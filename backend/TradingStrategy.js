// backend/TradingStrategy.js
import { RSI, ATR, BollingerBands, EMA } from 'technicalindicators';
import fetch from 'node-fetch';

class RealtimeAnalyzer {
    constructor(log, getState, broadcast, addSymbolTo1mStream, removeSymbolFrom1mStream, dbService) {
        this.log = log;
        this.getState = getState;
        this.broadcast = broadcast;
        this.addSymbolTo1mStream = addSymbolTo1mStream;
        this.removeSymbolFrom1mStream = removeSymbolFrom1mStream;
        this.dbService = dbService;
        this.tradingEngine = null;

        this.settings = {};
        this.klineData = new Map();
        this.hydrating = new Set();
        this.SQUEEZE_PERCENTILE_THRESHOLD = 0.25;
        this.SQUEEZE_LOOKBACK = 50;
    }

    setTradingEngine(engine) {
        this.tradingEngine = engine;
    }

    updateSettings(newSettings) {
        this.log('INFO', '[Analyzer] Settings updated for available strategies.');
        this.settings = newSettings;
    }

    async fetchKlinesFromBinance(symbol, interval, startTime = 0, limit = 500) {
        let url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
        if (startTime > 0) {
            url += `&startTime=${startTime + 1}`;
        }
        
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`Failed to fetch klines for ${symbol} (${interval}). Status: ${response.status}`);
            const klines = await response.json();
            if (!Array.isArray(klines)) throw new Error(`Binance klines response for ${symbol} is not an array.`);
            return klines;
        } catch (error) {
            this.log('WARN', `Could not fetch klines for ${symbol} (${interval}): ${error.message}`);
            return [];
        }
    }

    async hydrateSymbol(symbol, interval) {
        if (this.hydrating.has(`${symbol}-${interval}`)) return;
        this.hydrating.add(`${symbol}-${interval}`);
        
        try {
            const latestTimeInDb = await this.dbService.getLatestKlineTime(symbol, interval);
            const newApiKlines = await this.fetchKlinesFromBinance(symbol, interval, latestTimeInDb);

            if (newApiKlines.length > 0) {
                const formattedKlines = newApiKlines.map(k => ({
                    openTime: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
                    low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
                    closeTime: k[6],
                }));
                await this.dbService.saveKlines(symbol, interval, formattedKlines);
            }

            const klineLimit = { '1m': 100, '15m': 201, '1h': 100, '4h': 100 }[interval] || 201;
            const klinesForAnalysis = await this.dbService.getKlines(symbol, interval, klineLimit);

            if (!this.klineData.has(symbol)) this.klineData.set(symbol, new Map());
            this.klineData.get(symbol).set(interval, klinesForAnalysis);

        } catch (error) {
            this.log('ERROR', `Failed to hydrate ${symbol} (${interval}): ${error.message}`);
        } finally {
            this.hydrating.delete(`${symbol}-${interval}`);
        }
    }
    
    async performInitialAnalysis(symbol) {
        const klines4h = this.klineData.get(symbol)?.get('4h');
        const klines1h = this.klineData.get(symbol)?.get('1h');

        if (!klines4h || klines4h.length < 51 || !klines1h || klines1h.length < 15) {
            this.log('WARN', `[${symbol}] Not enough data for initial analysis after hydration.`);
            return null;
        }

        const closes4h = klines4h.map(k => k.close);
        const lastEma50_4h = EMA.calculate({ period: 50, values: closes4h }).pop();
        const price_above_ema50_4h = closes4h[closes4h.length - 1] > lastEma50_4h;

        const closes1h = klines1h.map(k => k.close);
        const rsi_1h = RSI.calculate({ values: closes1h, period: 14 }).pop();

        this.log('SCANNER', `[${symbol}] Initial analysis: Trend 4h OK: ${price_above_ema50_4h}, RSI 1h: ${rsi_1h?.toFixed(1)}`);

        return {
            price_above_ema50_4h,
            rsi_1h,
            priceDirection: 'neutral',
            score: 'HOLD',
            score_value: 50,
            is_in_squeeze_15m: false,
        };
    }

    analyze15mIndicators(symbolOrPair) {
        const botState = this.getState();
        const symbol = typeof symbolOrPair === 'string' ? symbolOrPair : symbolOrPair.symbol;
        const pairToUpdate = typeof symbolOrPair === 'string'
            ? botState.scannerCache.find(p => p.symbol === symbol)
            : symbolOrPair;

        if (!pairToUpdate) return;

        const klines15m = this.klineData.get(symbol)?.get('15m');
        if (!klines15m || klines15m.length < 21) return;

        const old_hotlist_status = pairToUpdate.is_on_hotlist;

        const closes15m = klines15m.map(d => d.close);
        const highs15m = klines15m.map(d => d.high);
        const lows15m = klines15m.map(d => d.low);

        const bbResult = BollingerBands.calculate({ period: 20, values: closes15m, stdDev: 2 });
        const atrResult = ATR.calculate({ high: highs15m, low: lows15m, close: closes15m, period: 14 });

        if (bbResult.length < 2 || !atrResult.length) return;

        pairToUpdate.atr_15m = atrResult[atrResult.length - 1];
        
        const lastBB = bbResult[bbResult.length - 1];
        pairToUpdate.bollinger_bands_15m = { ...lastBB, width_pct: (lastBB.upper - lastBB.lower) / lastBB.middle * 100 };

        const bbWidths = bbResult.map(b => (b.upper - b.lower) / b.middle);
        const previousCandleIndex = bbWidths.length - 2;
        const historyForSqueeze = bbWidths.slice(0, previousCandleIndex + 1).slice(-this.SQUEEZE_LOOKBACK);
        
        let wasInSqueeze = false;
        if (historyForSqueeze.length >= 20) {
            const sortedWidths = [...historyForSqueeze].sort((a, b) => a - b);
            const squeezeThreshold = sortedWidths[Math.floor(sortedWidths.length * this.SQUEEZE_PERCENTILE_THRESHOLD)];
            wasInSqueeze = bbWidths[previousCandleIndex] <= squeezeThreshold;
        }
        pairToUpdate.is_in_squeeze_15m = wasInSqueeze;
        
        const isTrendOK = pairToUpdate.price_above_ema50_4h === true;
        const isOnHotlist = isTrendOK && wasInSqueeze;
        pairToUpdate.is_on_hotlist = isOnHotlist;

        if (isOnHotlist && !old_hotlist_status) {
            this.log('SCANNER', `[HOTLIST ADDED] ${symbol} now meets macro conditions. Watching on 1m.`);
            this.addSymbolTo1mStream(symbol);
        } else if (!isOnHotlist && old_hotlist_status) {
            this.log('SCANNER', `[HOTLIST REMOVED] ${symbol} no longer meets macro conditions.`);
            this.removeSymbolFrom1mStream(symbol);
        }

        const conditions = {
            trend: isTrendOK,
            squeeze: wasInSqueeze,
            safety: pairToUpdate.rsi_1h !== undefined && pairToUpdate.rsi_1h < this.settings.RSI_OVERBOUGHT_THRESHOLD,
        };
        const conditionsMetCount = Object.values(conditions).filter(Boolean).length;
        pairToUpdate.conditions_met_count = conditionsMetCount;
        pairToUpdate.score_value = (conditionsMetCount / Object.keys(conditions).length) * 100;

        this.broadcast({ type: 'SCANNER_UPDATE', payload: pairToUpdate });
    }
    
    analyze1mIndicators(symbol, kline) {
        const botState = this.getState();
        const pair = botState.scannerCache.find(p => p.symbol === symbol);
        if (!pair || !pair.is_on_hotlist) return;

        const klines1m = this.klineData.get(symbol)?.get('1m');
        if (!klines1m || klines1m.length < 21) return;

        const closes1m = klines1m.map(k => k.close);
        const volumes1m = klines1m.map(k => k.volume);

        const lastEma9 = EMA.calculate({ period: 9, values: closes1m }).pop();
        const avgVolume = volumes1m.slice(-21, -1).reduce((sum, v) => sum + v, 0) / 20;

        if (lastEma9 === undefined) return;
        
        const isEntrySignal = kline.close > lastEma9 && kline.volume > avgVolume * 1.5;

        if (isEntrySignal) {
            this.log('TRADE', `[1m TRIGGER] Precision entry signal for ${symbol}!`);
            pair.score = 'STRONG BUY';
            this.broadcast({ type: 'SCANNER_UPDATE', payload: pair });
            
            const tradeOpened = this.tradingEngine.evaluateAndOpenTrade(pair, kline.low, 'MACRO_MICRO');
            
            if (tradeOpened) {
                pair.is_on_hotlist = false;
                this.removeSymbolFrom1mStream(symbol);
                this.broadcast({ type: 'SCANNER_UPDATE', payload: pair });
            }
        }
    }
    
    analyze1mForIgnition(symbol, kline) {
        const s = this.settings;
        const klines1m = this.klineData.get(symbol)?.get('1m');
        if (!klines1m || klines1m.length < 21) return;

        const volumes1m = klines1m.map(k => k.volume);
        const avgVolume = volumes1m.slice(-21, -1).reduce((sum, v) => sum + v, 0) / 20;
        const isVolumeSpike = kline.volume > (avgVolume * s.IGNITION_VOLUME_SPIKE_FACTOR);

        let isPriceAccelerating = false;
        const accelPeriod = s.IGNITION_PRICE_ACCEL_PERIOD_MINUTES;
        if (klines1m.length >= accelPeriod) {
            const checkPeriodKlines = klines1m.slice(-accelPeriod);
            const startingPrice = checkPeriodKlines[0].open;
            const priceIncreasePct = ((kline.close - startingPrice) / startingPrice) * 100;
            isPriceAccelerating = priceIncreasePct >= s.IGNITION_PRICE_ACCEL_THRESHOLD_PCT;
        }

        if (isVolumeSpike && isPriceAccelerating) {
            const pair = this.getState().scannerCache.find(p => p.symbol === symbol);
            if (pair) {
                this.log('TRADE', `[IGNITION 🔥] Pump signal for ${symbol}! Vol: x${(kline.volume/avgVolume).toFixed(1)}, Price Accel: OK.`);
                pair.score = 'IGNITION';
                this.broadcast({ type: 'SCANNER_UPDATE', payload: pair });
                this.tradingEngine.evaluateAndOpenTrade(pair, kline.low, 'IGNITION');
            }
        }
    }

    handleNewKline(symbol, interval, kline) {
        if (!this.klineData.has(symbol) || !this.klineData.get(symbol).has(interval)) {
            this.hydrateSymbol(symbol, interval);
            return;
        }

        const klines = this.klineData.get(symbol).get(interval);
        klines.push(kline);
        if (klines.length > 201) klines.shift();
        
        this.dbService.saveKlines(symbol, interval, [kline]);
        
        if (interval === '15m' && !this.settings.USE_IGNITION_STRATEGY) {
            this.analyze15mIndicators(symbol);
        } else if (interval === '1m') {
            if (this.settings.USE_IGNITION_STRATEGY) {
                this.analyze1mForIgnition(symbol, kline);
            } else {
                this.analyze1mIndicators(symbol, kline);
            }
        }
    }
}


function createTradingEngine(log, getState, saveData, broadcast, realtimeAnalyzer, dbService) {
    return {
        evaluateAndOpenTrade(pair, slPriceReference, strategy = 'MACRO_MICRO') {
            const botState = getState();
            if (!botState.isRunning) return false;
            const s = botState.settings;
            
            if (strategy === 'MACRO_MICRO') {
                if (s.USE_RSI_SAFETY_FILTER && (pair.rsi_1h === undefined || pair.rsi_1h === null || pair.rsi_1h >= s.RSI_OVERBOUGHT_THRESHOLD)) {
                    log('TRADE', `[RSI FILTER] Skipped trade for ${pair.symbol}. RSI (${pair.rsi_1h?.toFixed(2)}) out of bounds.`);
                    return false;
                }
                if (s.USE_PARABOLIC_FILTER) {
                    const klines1m = realtimeAnalyzer.klineData.get(pair.symbol)?.get('1m');
                    if (klines1m && klines1m.length >= s.PARABOLIC_FILTER_PERIOD_MINUTES) {
                        const checkPeriodKlines = klines1m.slice(-s.PARABOLIC_FILTER_PERIOD_MINUTES);
                        const startingPrice = checkPeriodKlines[0].open;
                        const priceIncreasePct = ((pair.price - startingPrice) / startingPrice) * 100;
                        if (priceIncreasePct > s.PARABOLIC_FILTER_THRESHOLD_PCT) {
                            log('TRADE', `[PARABOLIC FILTER] Skipped trade for ${pair.symbol}. Price increase of ${priceIncreasePct.toFixed(2)}% exceeds threshold.`);
                            return false;
                        }
                    }
                }
            }
            
            const cooldownInfo = botState.recentlyLostSymbols.get(pair.symbol);
            if (cooldownInfo && Date.now() < cooldownInfo.until) {
                log('TRADE', `Skipping trade for ${pair.symbol} due to recent loss cooldown.`);
                pair.score = 'COOLDOWN';
                return false;
            }

            if (botState.activePositions.length >= s.MAX_OPEN_POSITIONS || botState.activePositions.some(p => p.symbol === pair.symbol)) {
                log('TRADE', `Skipping trade for ${pair.symbol}: Position limit reached or already open.`);
                return false;
            }

            const entryPrice = pair.price;
            if (!entryPrice || entryPrice <= 0) {
                log('ERROR', `[CRITICAL] Invalid entry price ($${entryPrice}) for ${pair.symbol}.`);
                return false;
            }

            let positionSizePct = s.POSITION_SIZE_PCT;
            if (s.USE_DYNAMIC_POSITION_SIZING && (pair.score === 'STRONG BUY' || pair.score === 'IGNITION')) {
                positionSizePct = s.STRONG_BUY_POSITION_SIZE_PCT;
            }

            const positionSizeUSD = botState.balance * (positionSizePct / 100);
            if (botState.balance < positionSizeUSD) {
                log('WARN', `[INSUFFICIENT BALANCE] Skipping trade for ${pair.symbol}.`);
                return false;
            }

            const quantity = positionSizeUSD / entryPrice;
            let stopLoss;
            if (s.USE_ATR_STOP_LOSS && pair.atr_15m && strategy === 'MACRO_MICRO') {
                stopLoss = entryPrice - (pair.atr_15m * s.ATR_MULTIPLIER);
            } else {
                stopLoss = slPriceReference * (1 - s.STOP_LOSS_PCT / 100);
            }

            const riskPerUnit = entryPrice - stopLoss;
            if (riskPerUnit <= 0) {
                log('ERROR', `Calculated risk is zero or negative for ${pair.symbol}. Aborting.`);
                return false;
            }
            
            const takeProfit = entryPrice + (riskPerUnit * (s.TAKE_PROFIT_PCT / s.STOP_LOSS_PCT));

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
                status: 'FILLED',
                entry_snapshot: { ...pair },
                initial_risk_usd: positionSizeUSD * (riskPerUnit / entryPrice),
                is_at_breakeven: false,
                partial_tp_hit: false,
                realized_pnl: 0,
                strategy: strategy,
            };

            log('TRADE', `>>> [${strategy}] FIRING TRADE <<< Opening for ${pair.symbol}: Qty=${quantity.toFixed(4)}, Entry=$${entryPrice}, SL=$${stopLoss.toFixed(4)}, TP=$${takeProfit.toFixed(4)}`);
            
            botState.activePositions.push(newTrade);
            botState.balance -= positionSizeUSD;
            saveData('state');
            broadcast({ type: 'POSITIONS_UPDATED' });
            return true;
        },

        monitorAndManagePositions() {
            const botState = getState();
            if (!botState.isRunning) return;

            let stateHasChanged = false;

            botState.activePositions.forEach(pos => {
                const priceData = botState.priceCache.get(pos.symbol);
                if (!priceData) return;

                const currentPrice = priceData.price;
                const s = botState.settings;

                if (currentPrice > pos.highest_price_since_entry) {
                    pos.highest_price_since_entry = currentPrice;
                    stateHasChanged = true;
                }

                if (currentPrice <= pos.stop_loss || currentPrice >= pos.take_profit) {
                    const reason = currentPrice <= pos.stop_loss ? 'Stop Loss' : 'Take Profit';
                    this.closeTrade(pos.id, currentPrice, reason);
                    stateHasChanged = true;
                    return;
                }
                
                const pnlPct = ((currentPrice - pos.entry_price) / pos.entry_price) * 100;

                if (s.USE_PARTIAL_TAKE_PROFIT && !pos.partial_tp_hit && pnlPct >= s.PARTIAL_TP_TRIGGER_PCT) {
                    this.executePartialSell(pos, currentPrice);
                    stateHasChanged = true;
                }

                if (s.USE_AUTO_BREAKEVEN && !pos.is_at_breakeven && pnlPct >= s.BREAKEVEN_TRIGGER_PCT) {
                    let newStopLoss = pos.entry_price * (1 + (s.ADJUST_BREAKEVEN_FOR_FEES ? (s.TRANSACTION_FEE_PCT / 100) * 2 : 0));
                    pos.stop_loss = newStopLoss;
                    pos.is_at_breakeven = true;
                    stateHasChanged = true;
                    log('TRADE', `[${pos.symbol}] Stop Loss moved to Break-even at $${newStopLoss.toFixed(4)}.`);
                }
                
                if (pos.strategy === 'IGNITION') {
                    const klines1m = realtimeAnalyzer.klineData.get(pos.symbol)?.get('1m');
                    if (klines1m && klines1m.length > 1) {
                        const previousCandleLow = klines1m[klines1m.length - 2].low;
                        if (previousCandleLow > pos.stop_loss) {
                            pos.stop_loss = previousCandleLow;
                            stateHasChanged = true;
                            log('TRADE', `[${pos.symbol}] Lightning TSL ⚡ updated to $${previousCandleLow.toFixed(4)}.`);
                        }
                    }
                } else if (s.USE_TRAILING_STOP_LOSS && pos.is_at_breakeven) {
                    const newTrailingSL = pos.highest_price_since_entry * (1 - s.TRAILING_STOP_LOSS_PCT / 100);
                    if (newTrailingSL > pos.stop_loss) {
                        pos.stop_loss = newTrailingSL;
                        stateHasChanged = true;
                        log('TRADE', `[${pos.symbol}] Trailing Stop Loss updated to $${newTrailingSL.toFixed(4)}.`);
                    }
                }
            });

            if (stateHasChanged) {
                saveData('state');
                broadcast({ type: 'POSITIONS_UPDATED' });
            }
        },

        closeTrade(tradeId, exitPrice, reason = 'Manual Close') {
            const botState = getState();
            const tradeIndex = botState.activePositions.findIndex(t => t.id === tradeId);
            if (tradeIndex === -1) return null;

            const [trade] = botState.activePositions.splice(tradeIndex, 1);
            trade.exit_price = exitPrice;
            trade.exit_time = new Date().toISOString();
            trade.status = 'CLOSED';

            const entryValue = trade.entry_price * trade.initial_quantity;
            const exitValue = exitPrice * trade.initial_quantity;
            const pnl = (exitValue - entryValue) + (trade.realized_pnl || 0);
            trade.pnl = pnl;
            trade.pnl_pct = entryValue > 0 ? (pnl / entryValue) * 100 : 0;

            botState.balance += entryValue + pnl;
            botState.tradeHistory.push(trade);
            dbService.saveTrade(trade); // Persist to SQLite
            
            if (pnl < 0 && botState.settings.LOSS_COOLDOWN_HOURS > 0) {
                const cooldownUntil = Date.now() + botState.settings.LOSS_COOLDOWN_HOURS * 3600000;
                botState.recentlyLostSymbols.set(trade.symbol, { until: cooldownUntil });
                log('TRADE', `[${trade.symbol}] placed on cooldown until ${new Date(cooldownUntil).toLocaleString()}`);
            }
            
            log('TRADE', `<<< [${reason}] CLOSED ${trade.symbol} >>> PnL: $${pnl.toFixed(2)} (${trade.pnl_pct.toFixed(2)}%)`);
            return trade;
        },
        
        executePartialSell(position, currentPrice) {
            const s = getState().settings;
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
        dependencies.dbService
    );

    const tradingEngine = createTradingEngine(
        dependencies.log,
        dependencies.getState,
        dependencies.saveData,
        dependencies.broadcast,
        realtimeAnalyzer,
        dependencies.dbService
    );
    
    realtimeAnalyzer.setTradingEngine(tradingEngine);

    return { realtimeAnalyzer, tradingEngine };
}
