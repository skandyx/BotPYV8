import { RSI, ADX, ATR, MACD, SMA, BollingerBands, EMA } from 'technicalindicators';

// --- Realtime Analysis Engine (Macro-Micro Strategy) ---
class RealtimeAnalyzer {
    constructor(log, getState, broadcast, addSymbolTo1mStream, removeSymbolFrom1mStream, scanner) {
        this.log = log;
        this.getState = getState;
        this.broadcast = broadcast;
        this.addSymbolTo1mStream = addSymbolTo1mStream;
        this.removeSymbolFrom1mStream = removeSymbolFrom1mStream;
        this.scanner = scanner;
        this.tradingEngine = null; // To be set later to break circular dependency

        this.settings = {};
        this.klineData = new Map(); // Map<symbol, Map<interval, kline[]>>
        this.hydrating = new Set();
        this.SQUEEZE_PERCENTILE_THRESHOLD = 0.25;
        this.SQUEEZE_LOOKBACK = 50;
    }

    setTradingEngine(engine) {
        this.tradingEngine = engine;
    }

    updateSettings(newSettings) {
        this.log('INFO', '[Analyzer] Settings updated for Macro-Micro strategy.');
        this.settings = newSettings;
    }

    // Phase 1: 15m analysis to qualify pairs for the Hotlist
    analyze15mIndicators(symbolOrPair) {
        const botState = this.getState();
        const symbol = typeof symbolOrPair === 'string' ? symbolOrPair : symbolOrPair.symbol;
        const pairToUpdate = typeof symbolOrPair === 'string'
            ? botState.scannerCache.find(p => p.symbol === symbol)
            : symbolOrPair;

        if (!pairToUpdate) return;

        const klines15m = this.klineData.get(symbol)?.get('15m');
        if (!klines15m || klines15m.length < 21) return; // Need at least 20 for BB + 1 previous

        const old_score = pairToUpdate.score;
        const old_hotlist_status = pairToUpdate.is_on_hotlist;

        const closes15m = klines15m.map(d => d.close);
        const highs15m = klines15m.map(d => d.high);
        const lows15m = klines15m.map(d => d.low);

        const bbResult = BollingerBands.calculate({ period: 20, values: closes15m, stdDev: 2 });
        const atrResult = ATR.calculate({ high: highs15m, low: lows15m, close: closes15m, period: 14 });

        if (bbResult.length < 2 || !atrResult.length) return;

        pairToUpdate.atr_15m = atrResult[atrResult.length - 1];
        
        const lastCandle = klines15m[klines15m.length - 1];
        const lastBB = bbResult[bbResult.length - 1];

        // Update pair with CURRENT BB width for display purposes
        const currentBbWidthPct = (lastBB.upper - lastBB.lower) / lastBB.middle * 100;
        pairToUpdate.bollinger_bands_15m = { ...lastBB, width_pct: currentBbWidthPct };

        // --- CORRECTED SQUEEZE LOGIC ---
        const bbWidths = bbResult.map(b => (b.upper - b.lower) / b.middle);
        const previousCandleIndex = bbWidths.length - 2;
        const previousBbWidth = bbWidths[previousCandleIndex];

        const historyForSqueeze = bbWidths.slice(0, previousCandleIndex + 1).slice(-this.SQUEEZE_LOOKBACK);
        
        let wasInSqueeze = false;
        if (historyForSqueeze.length < 20) {
            pairToUpdate.is_in_squeeze_15m = false;
        } else {
            const sortedWidths = [...historyForSqueeze].sort((a, b) => a - b);
            const squeezeThreshold = sortedWidths[Math.floor(sortedWidths.length * this.SQUEEZE_PERCENTILE_THRESHOLD)];
            wasInSqueeze = previousBbWidth <= squeezeThreshold;
            pairToUpdate.is_in_squeeze_15m = wasInSqueeze;
        }
        
        const volumes15m = klines15m.map(k => k.volume);
        const avgVolume = volumes15m.slice(-21, -1).reduce((sum, v) => sum + v, 0) / 20;
        pairToUpdate.volume_20_period_avg_15m = avgVolume;

        const volumeConditionMet = lastCandle.volume > (avgVolume * 2);

        // --- "Hotlist" Logic using the CORRECTED squeeze state ---
        const isTrendOK = pairToUpdate.price_above_ema50_4h === true;
        const isOnHotlist = isTrendOK && wasInSqueeze;
        pairToUpdate.is_on_hotlist = isOnHotlist;

        if (isOnHotlist && !old_hotlist_status) {
            this.log('SCANNER', `[HOTLIST ADDED] ${symbol} now meets macro conditions (Trend OK, Squeeze on previous candle). Watching on 1m.`);
            this.addSymbolTo1mStream(symbol);
        } else if (!isOnHotlist && old_hotlist_status) {
            this.log('SCANNER', `[HOTLIST REMOVED] ${symbol} no longer meets macro conditions.`);
            this.removeSymbolFrom1mStream(symbol);
        }

        let finalScore = 'HOLD';
        if (isOnHotlist) finalScore = 'COMPRESSION';

        const isBreakout = lastCandle.close > lastBB.upper;
        if (isBreakout && !wasInSqueeze) {
            finalScore = 'FAKE_BREAKOUT';
        }

        const cooldownInfo = botState.recentlyLostSymbols.get(symbol);
        if (cooldownInfo && Date.now() < cooldownInfo.until) {
            finalScore = 'COOLDOWN';
        }

        const conditions = {
            trend: isTrendOK,
            squeeze: wasInSqueeze,
            safety: pairToUpdate.rsi_1h !== undefined && pairToUpdate.rsi_1h < this.settings.RSI_OVERBOUGHT_THRESHOLD,
            breakout: isBreakout,
            volume: volumeConditionMet,
        };
        const conditionsMetCount = Object.values(conditions).filter(Boolean).length;
        pairToUpdate.conditions = conditions;
        pairToUpdate.conditions_met_count = conditionsMetCount;
        pairToUpdate.score_value = (conditionsMetCount / 5) * 100;
        pairToUpdate.score = finalScore;

        if (pairToUpdate.score !== old_score || pairToUpdate.is_on_hotlist !== old_hotlist_status) {
            this.broadcast({ type: 'SCANNER_UPDATE', payload: pairToUpdate });
        }
    }
    
    // Phase 2: 1m analysis to find the precision entry for pairs on the Hotlist
    analyze1mIndicators(symbol, kline) {
        const botState = this.getState();
        const pair = botState.scannerCache.find(p => p.symbol === symbol);
        if (!pair || !pair.is_on_hotlist) return;

        const klines1m = this.klineData.get(symbol)?.get('1m');
        if (!klines1m || klines1m.length < 21) return; // Need enough for EMA and avg volume

        const closes1m = klines1m.map(k => k.close);
        const volumes1m = klines1m.map(k => k.volume);

        const lastEma9 = EMA.calculate({ period: 9, values: closes1m }).pop();
        const avgVolume = volumes1m.slice(-21, -1).reduce((sum, v) => sum + v, 0) / 20;

        if (lastEma9 === undefined) return;
        
        const triggerCandle = klines1m[klines1m.length - 1];
        const isEntrySignal = triggerCandle.close > lastEma9 && triggerCandle.volume > avgVolume * 1.5;

        if (isEntrySignal) {
            this.log('TRADE', `[1m TRIGGER] Precision entry signal detected for ${symbol}!`);
            pair.score = 'STRONG BUY'; // Update score to reflect the trigger
            this.broadcast({ type: 'SCANNER_UPDATE', payload: pair });
            
            const tradeOpened = this.tradingEngine.evaluateAndOpenTrade(pair, triggerCandle.low);
            
            // Once triggered, remove from hotlist to prevent re-entry ONLY if trade was successful
            if (tradeOpened) {
                pair.is_on_hotlist = false;
                this.removeSymbolFrom1mStream(symbol);
                this.broadcast({ type: 'SCANNER_UPDATE', payload: pair });
            }
        }
    }


    async hydrateSymbol(symbol, interval = '15m') {
        const klineLimit = interval === '1m' ? 50 : 201;
        if (this.hydrating.has(`${symbol}-${interval}`)) return;
        this.hydrating.add(`${symbol}-${interval}`);
        this.log('INFO', `[Analyzer] Hydrating ${interval} klines for: ${symbol}`);
        try {
            const klines = await this.scanner.fetchKlinesFromBinance(symbol, interval, 0, klineLimit);
            if (klines.length === 0) throw new Error(`No ${interval} klines fetched.`);
            const formattedKlines = klines.map(k => ({
                openTime: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
                low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
                closeTime: k[6],
            }));

            if (!this.klineData.has(symbol)) this.klineData.set(symbol, new Map());
            this.klineData.get(symbol).set(interval, formattedKlines);
            
            if (interval === '15m') this.analyze15mIndicators(symbol);

        } catch (error) {
            this.log('ERROR', `Failed to hydrate ${symbol} (${interval}): ${error.message}`);
        } finally {
            this.hydrating.delete(`${symbol}-${interval}`);
        }
    }

    handleNewKline(symbol, interval, kline) {
        this.log('BINANCE_WS', `[${interval} KLINE] Received for ${symbol}. Close: ${kline.close}`);
        if (!this.klineData.has(symbol) || !this.klineData.get(symbol).has(interval)) {
            this.hydrateSymbol(symbol, interval);
            return;
        }

        const klines = this.klineData.get(symbol).get(interval);
        klines.push(kline);
        if (klines.length > 201) klines.shift();
        
        if (interval === '15m') {
            this.analyze15mIndicators(symbol);
        } else if (interval === '1m') {
            this.analyze1mIndicators(symbol, kline);
        }
    }
}


// --- Trading Engine ---
function createTradingEngine(log, getState, saveData, broadcast, realtimeAnalyzer) {
    return {
        evaluateAndOpenTrade(pair, slPriceReference) {
            const botState = getState();
            if (!botState.isRunning) return false;
            const s = botState.settings;
            
            // --- RSI Safety Filter ---
            if (s.USE_RSI_SAFETY_FILTER) {
                if (pair.rsi_1h === undefined || pair.rsi_1h === null) {
                    log('TRADE', `[RSI FILTER] Skipped trade for ${pair.symbol}. 1h RSI data not available.`);
                    return false;
                }
                if (pair.rsi_1h >= s.RSI_OVERBOUGHT_THRESHOLD) {
                    log('TRADE', `[RSI FILTER] Skipped trade for ${pair.symbol}. 1h RSI (${pair.rsi_1h.toFixed(2)}) is >= threshold (${s.RSI_OVERBOUGHT_THRESHOLD}).`);
                    return false;
                }
            }

            // --- Parabolic Filter Check ---
            if (s.USE_PARABOLIC_FILTER) {
                const klines1m = realtimeAnalyzer.klineData.get(pair.symbol)?.get('1m');
                if (klines1m && klines1m.length >= s.PARABOLIC_FILTER_PERIOD_MINUTES) {
                    const checkPeriodKlines = klines1m.slice(-s.PARABOLIC_FILTER_PERIOD_MINUTES);
                    const startingPrice = checkPeriodKlines[0].open;
                    const currentPrice = pair.price;
                    const priceIncreasePct = ((currentPrice - startingPrice) / startingPrice) * 100;

                    if (priceIncreasePct > s.PARABOLIC_FILTER_THRESHOLD_PCT) {
                        log('TRADE', `[PARABOLIC FILTER] Skipped trade for ${pair.symbol}. Price increased by ${priceIncreasePct.toFixed(2)}% in the last ${s.PARABOLIC_FILTER_PERIOD_MINUTES} minutes, exceeding threshold of ${s.PARABOLIC_FILTER_THRESHOLD_PCT}%.`);
                        return false; // Abort trade
                    }
                }
            }
            
            const cooldownInfo = botState.recentlyLostSymbols.get(pair.symbol);
            if (cooldownInfo && Date.now() < cooldownInfo.until) {
                log('TRADE', `Skipping trade for ${pair.symbol} due to recent loss cooldown.`);
                pair.score = 'COOLDOWN'; // Ensure state reflects this
                return false;
            }

            if (botState.activePositions.length >= s.MAX_OPEN_POSITIONS) {
                log('TRADE', `Skipping trade for ${pair.symbol}: Max open positions (${s.MAX_OPEN_POSITIONS}) reached.`);
                return false;
            }

            if (botState.activePositions.some(p => p.symbol === pair.symbol)) {
                log('TRADE', `Skipping trade for ${pair.symbol}: Position already open.`);
                return false;
            }

            const entryPrice = pair.price;
            
            // FIX: (position.service.ts:142) Prévention de la division par zéro en validant le prix d'entrée avant tout calcul.
            if (!entryPrice || entryPrice <= 0) {
                log('ERROR', `[CRITICAL] Invalid entry price ($${entryPrice}) for ${pair.symbol}. Aborting trade.`);
                return false;
            }

            let positionSizePct = s.POSITION_SIZE_PCT;
            if (s.USE_DYNAMIC_POSITION_SIZING && pair.score === 'STRONG BUY') {
                positionSizePct = s.STRONG_BUY_POSITION_SIZE_PCT;
            }

            const positionSizeUSD = botState.balance * (positionSizePct / 100);

            // FIX: (order.service.ts:81) Vérification du solde disponible avant de tenter d'ouvrir une position.
            if (botState.balance < positionSizeUSD) {
                log('WARN', `[INSUFFICIENT BALANCE] Skipping trade for ${pair.symbol}. Required: $${positionSizeUSD.toFixed(2)}, Available: $${botState.balance.toFixed(2)}.`);
                return false;
            }

            const rawQuantity = positionSizeUSD / entryPrice;
            const quantity = Math.floor(rawQuantity * 1e8) / 1e8; // Truncate to 8 decimal places

            let stopLoss;
            if (s.USE_ATR_STOP_LOSS && pair.atr_15m) {
                stopLoss = entryPrice - (pair.atr_15m * s.ATR_MULTIPLIER);
            } else {
                stopLoss = slPriceReference * (1 - s.STOP_LOSS_PCT / 100);
            }

            const riskPerUnit = entryPrice - stopLoss;
            if (riskPerUnit <= 0) {
                log('ERROR', `Calculated risk is zero or negative for ${pair.symbol}. SL: ${stopLoss}, Entry: ${entryPrice}. Aborting trade.`);
                return false;
            }
            
            if (!s.USE_ATR_STOP_LOSS && (!s.STOP_LOSS_PCT || s.STOP_LOSS_PCT <= 0)) {
                log('ERROR', `STOP_LOSS_PCT is zero or invalid (${s.STOP_LOSS_PCT}%) while not using ATR stop loss for ${pair.symbol}. Aborting trade.`);
                return false;
            }
            const riskRewardRatio = s.TAKE_PROFIT_PCT / s.STOP_LOSS_PCT;
            const takeProfit = entryPrice + (riskPerUnit * riskRewardRatio);

            const newTrade = {
                id: botState.tradeIdCounter++,
                mode: botState.tradingMode,
                symbol: pair.symbol,
                side: 'BUY',
                entry_price: entryPrice,
                quantity: quantity,
                initial_quantity: quantity,
                stop_loss: stopLoss,
                take_profit: takeProfit,
                highest_price_since_entry: entryPrice,
                entry_time: new Date().toISOString(),
                status: 'PENDING',
                entry_snapshot: { ...pair },
                initial_risk_usd: positionSizeUSD * (s.STOP_LOSS_PCT / 100),
                is_at_breakeven: false,
                partial_tp_hit: false,
                realized_pnl: 0,
            };

            log('TRADE', `>>> FIRING TRADE <<< Opening ${botState.tradingMode} trade for ${pair.symbol}: Qty=${quantity.toFixed(8)}, Entry=$${entryPrice}, SL=$${stopLoss.toFixed(4)}, TP=$${takeProfit.toFixed(4)}`);
            
            newTrade.status = 'FILLED';
            botState.activePositions.push(newTrade);
            botState.balance -= positionSizeUSD;
            
            saveData('state');
            broadcast({ type: 'POSITIONS_UPDATED' });
            return true;
        },

        monitorAndManagePositions() {
            const botState = getState();
            if (!botState.isRunning) return;

            const positionsToClose = [];
            let stateHasChanged = false; // Flag to check if we need to save state

            botState.activePositions.forEach(pos => {
                const priceData = botState.priceCache.get(pos.symbol);

                if (!priceData) {
                    log('WARN', `No price data for active position ${pos.symbol}. Skipping management check.`);
                    return;
                }

                const currentPrice = priceData.price;
                
                if (currentPrice > pos.highest_price_since_entry) {
                    // FIX: (trailing.service.ts) L'état du trailing stop (prix le plus haut) est mis à jour ici pour assurer la persistance.
                    pos.highest_price_since_entry = currentPrice;
                    stateHasChanged = true;
                }

                if (currentPrice <= pos.stop_loss) {
                    positionsToClose.push({ trade: pos, exitPrice: pos.stop_loss, reason: 'Stop Loss' });
                    return;
                }

                if (currentPrice >= pos.take_profit) {
                    positionsToClose.push({ trade: pos, exitPrice: pos.take_profit, reason: 'Take Profit' });
                    return;
                }

                const s = botState.settings;
                const pnlPct = ((currentPrice - pos.entry_price) / pos.entry_price) * 100;
                
                if (s.USE_PARTIAL_TAKE_PROFIT && !pos.partial_tp_hit && pnlPct >= s.PARTIAL_TP_TRIGGER_PCT) {
                    this.executePartialSell(pos, currentPrice);
                    stateHasChanged = true;
                }

                if (s.USE_AUTO_BREAKEVEN && !pos.is_at_breakeven && pnlPct >= s.BREAKEVEN_TRIGGER_PCT) {
                    let newStopLoss = pos.entry_price;
                    let logMessage = `[${pos.symbol}] Stop Loss moved to Break-even at $${pos.entry_price}.`;

                    if (s.ADJUST_BREAKEVEN_FOR_FEES && s.TRANSACTION_FEE_PCT > 0) {
                        const feeMultiplier = 1 + (s.TRANSACTION_FEE_PCT / 100) * 2;
                        newStopLoss = pos.entry_price * feeMultiplier;
                        logMessage = `[${pos.symbol}] Stop Loss moved to REAL Break-even (fees included) at $${newStopLoss.toFixed(4)}.`;
                    }
                    
                    pos.stop_loss = newStopLoss;
                    pos.is_at_breakeven = true;
                    stateHasChanged = true;
                    log('TRADE', logMessage);
                }
                
                if (s.USE_TRAILING_STOP_LOSS && pos.is_at_breakeven) {
                    const newTrailingSL = pos.highest_price_since_entry * (1 - s.TRAILING_STOP_LOSS_PCT / 100);
                    if (newTrailingSL > pos.stop_loss) {
                        // FIX: (trailing.service.ts) Le stop-loss suiveur est mis à jour ici pour assurer la persistance.
                        pos.stop_loss = newTrailingSL;
                        stateHasChanged = true;
                        log('TRADE', `[${pos.symbol}] Trailing Stop Loss updated to $${newTrailingSL.toFixed(4)}.`);
                    }
                }
            });

            if (positionsToClose.length > 0) {
                positionsToClose.forEach(({ trade, exitPrice, reason }) => {
                    this.closeTrade(trade.id, exitPrice, reason);
                });
                saveData('state'); // A close always saves state
                broadcast({ type: 'POSITIONS_UPDATED' });
            } else if (stateHasChanged) {
                // FIX: (trailing.service.ts) Si l'état d'un trade a changé (SL, TSL), la sauvegarde est déclenchée ici.
                saveData('state');
            }
        },

        closeTrade(tradeId, exitPrice, reason = 'Manual Close') {
            const botState = getState();
            const tradeIndex = botState.activePositions.findIndex(t => t.id === tradeId);
            if (tradeIndex === -1) {
                log('WARN', `Could not find trade with ID ${tradeId} to close.`);
                return null;
            }
            const [trade] = botState.activePositions.splice(tradeIndex, 1);
            
            trade.exit_price = exitPrice;
            trade.exit_time = new Date().toISOString();
            trade.status = 'CLOSED';

            const entryValue = trade.entry_price * trade.initial_quantity;
            const exitValue = exitPrice * trade.initial_quantity;
            const pnl = (exitValue - entryValue) + (trade.realized_pnl || 0);

            trade.pnl = pnl;
            // FIX: (position.service.ts:142) Prévention de la division par zéro lors du calcul du P&L final.
            trade.pnl_pct = entryValue > 0 ? (pnl / entryValue) * 100 : 0;

            botState.balance += entryValue + pnl;
            botState.tradeHistory.push(trade);
            
            if (pnl < 0 && botState.settings.LOSS_COOLDOWN_HOURS > 0) {
                const cooldownUntil = Date.now() + botState.settings.LOSS_COOLDOWN_HOURS * 60 * 60 * 1000;
                botState.recentlyLostSymbols.set(trade.symbol, { until: cooldownUntil });
                log('TRADE', `[${trade.symbol}] placed on cooldown until ${new Date(cooldownUntil).toLocaleString()}`);
            }
            
            log('TRADE', `<<< TRADE CLOSED >>> [${reason}] Closed ${trade.symbol} at $${exitPrice.toFixed(4)}. PnL: $${pnl.toFixed(2)} (${trade.pnl_pct.toFixed(2)}%)`);
            return trade;
        },
        
        executePartialSell(position, currentPrice) {
            const botState = getState();
            const s = botState.settings;
            const sellQty = position.initial_quantity * (s.PARTIAL_TP_SELL_QTY_PCT / 100);
            const pnlFromSale = (currentPrice - position.entry_price) * sellQty;

            position.quantity -= sellQty;
            position.realized_pnl = (position.realized_pnl || 0) + pnlFromSale;
            position.partial_tp_hit = true;
            
            log('TRADE', `[PARTIAL TP] Sold ${s.PARTIAL_TP_SELL_QTY_PCT}% of ${position.symbol} at $${currentPrice}. Realized PnL: $${pnlFromSale.toFixed(2)}`);
        }
    };
}


export function createTradingStrategy(dependencies) {
    const realtimeAnalyzer = new RealtimeAnalyzer(
        dependencies.log,
        dependencies.getState,
        dependencies.broadcast,
        dependencies.addSymbolTo1mStream,
        dependencies.removeSymbolFrom1mStream,
        dependencies.scanner
    );

    const tradingEngine = createTradingEngine(
        dependencies.log,
        dependencies.getState,
        dependencies.saveData,
        dependencies.broadcast,
        realtimeAnalyzer
    );
    
    // Break the circular dependency
    realtimeAnalyzer.setTradingEngine(tradingEngine);

    return { realtimeAnalyzer, tradingEngine };
}