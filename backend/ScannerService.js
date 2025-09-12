import fs from 'fs/promises';
import path from 'path';
import fetch from 'node-fetch';
import { SMA, ADX, MACD, RSI, EMA } from 'technicalindicators';

const FIAT_CURRENCIES = ['EUR', 'GBP', 'JPY', 'AUD', 'CAD', 'CHF', 'CNY', 'HKD', 'NZD', 'SEK', 'KRW', 'SGD', 'NOK', 'MXN', 'INR', 'RUB', 'ZAR', 'TRY', 'BRL'];

export class ScannerService {
    constructor(log, klineDataDir) {
        this.log = log;
        this.klineDataDir = klineDataDir;
        this.cache = new Map(); // Cache in-memory pour les analyses de fond
        this.cacheTTL = 60 * 60 * 1000; // 1 heure
    }

    async runScan(settings) {
        this.log('SCANNER', 'Starting new discovery cycle for breakout strategy...');
        try {
            const binancePairs = await this.discoverAndFilterPairsFromBinance(settings);
            if (binancePairs.length === 0) {
                this.log('WARN', 'No pairs found meeting volume/exclusion criteria.');
                return [];
            }
            this.log('SCANNER', `Found ${binancePairs.length} pairs after initial filters. Analyzing in batches to avoid rate limits...`);

            // FIX: (marketData.service.ts:55) Implémentation d'un traitement par lots pour éviter de dépasser les limites de l'API Binance (rate-limit).
            const analyzedPairs = [];
            const chunkSize = 15; // Process 15 pairs at a time
            for (let i = 0; i < binancePairs.length; i += chunkSize) {
                const chunk = binancePairs.slice(i, i + chunkSize);
                this.log('SCANNER', `Analyzing chunk ${Math.floor(i / chunkSize) + 1}/${Math.ceil(binancePairs.length / chunkSize)}...`);
                
                const chunkPromises = chunk.map(pair => this.analyzePair(pair.symbol, settings)
                    .then(analysis => analysis ? { ...pair, ...analysis } : null)
                    .catch(e => {
                        this.log('WARN', `Could not analyze ${pair.symbol}: ${e.message}`);
                        return null;
                    })
                );

                const chunkResults = await Promise.all(chunkPromises);
                analyzedPairs.push(...chunkResults.filter(p => p !== null));
                
                // Optional small delay between chunks for extra safety
                await new Promise(resolve => setTimeout(resolve, 200)); 
            }
            
            this.log('SCANNER', `Discovery finished. ${analyzedPairs.length} pairs passed long-term analysis and are being monitored.`);
            return analyzedPairs;

        } catch (error) {
            this.log('ERROR', `Discovery cycle failed: ${error.message}.`);
            throw error;
        }
    }

    async discoverAndFilterPairsFromBinance(settings) {
        this.log('BINANCE_API', 'Fetching all 24hr ticker data from Binance...');
        try {
            const response = await fetch('https://api.binance.com/api/v3/ticker/24hr');
            if (!response.ok) throw new Error(`Binance API error! status: ${response.status}`);
            const allTickers = await response.json();
            if (!Array.isArray(allTickers)) throw new Error('Binance API did not return an array.');

            const excluded = settings.EXCLUDED_PAIRS.split(',').map(p => p.trim());
            const containsFiat = (symbol) => {
                const base = symbol.replace('USDT', '');
                return FIAT_CURRENCIES.includes(base);
            };

            return allTickers
                .filter(ticker => 
                    ticker.symbol.endsWith('USDT') &&
                    !containsFiat(ticker.symbol) &&
                    ticker.quoteVolume && parseFloat(ticker.quoteVolume) > settings.MIN_VOLUME_USD &&
                    !excluded.includes(ticker.symbol)
                )
                .map(ticker => ({
                    symbol: ticker.symbol,
                    volume: parseFloat(ticker.quoteVolume),
                    price: parseFloat(ticker.lastPrice),
                }));
        } catch (error) {
            this.log('ERROR', `Failed to discover pairs from Binance: ${error.message}`);
            throw error;
        }
    }

    async analyzePair(symbol, settings) {
        const cached = this.cache.get(symbol);
        if (cached && cached.timestamp > Date.now() - this.cacheTTL) {
            return cached.data;
        }
        this.log('SCANNER', `Performing long-term analysis for ${symbol}...`);

        // --- Fetch Data ---
        // These are hard requirements for data availability, so they remain.
        const klines4h = await this.fetchKlinesFromBinance(symbol, '4h', 0, 100);
        if (klines4h.length < 50) return null;
        
        const klines1h = await this.fetchKlinesFromBinance(symbol, '1h', 0, 100);
        if (klines1h.length < 15) return null;

        // --- 4h ANALYSIS ---
        const closes4h = klines4h.map(k => parseFloat(k[4]));
        const volumes4h = klines4h.map(k => parseFloat(k[5]));
        
        // Master Trend Filter
        const lastEma50_4h = EMA.calculate({ period: 50, values: closes4h }).pop();
        const lastClose4h = closes4h[closes4h.length - 1];
        const price_above_ema50_4h = lastClose4h > lastEma50_4h;
        
        // Volume Spike Filter
        const lastVolume4h = volumes4h[volumes4h.length - 1];
        const previousVolumes4h = volumes4h.slice(0, -1);
        const volumeSma20 = SMA.calculate({ period: 20, values: previousVolumes4h }).pop();
        const volume_spike_4h = lastVolume4h > (volumeSma20 * 2);
        
        // The bot will now analyze ALL pairs but will log if they fail a filter.
        // The trading logic will still prevent trades on unqualified pairs.
        if (settings.USE_MARKET_REGIME_FILTER && !price_above_ema50_4h) {
             this.log('SCANNER', `[${symbol}] Fails 4h trend filter.`);
        }
        if (!volume_spike_4h) {
            this.log('SCANNER', `[${symbol}] Fails 4h volume spike filter (Vol: ${lastVolume4h.toFixed(0)}, Avg: ${volumeSma20.toFixed(0)}).`);
        }

        // --- 1h ANALYSIS (Safety Filter) ---
        const closes1h = klines1h.map(k => parseFloat(k[4]));
        const rsi_1h = RSI.calculate({ values: closes1h, period: 14 }).pop();

        const analysisData = {
            price_above_ema50_4h,
            volume_spike_4h,
            rsi_1h,
            priceDirection: 'neutral',
            score: 'HOLD', // Default score, will be updated by RealtimeAnalyzer
            score_value: 50, // Default value
            is_in_squeeze_15m: false, // Default value
        };

        this.cache.set(symbol, { timestamp: Date.now(), data: analysisData });
        return analysisData;
    }

    async fetchKlinesFromBinance(symbol, interval, startTime = 0, limit = 201) {
        let url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
        if (startTime > 0) url += `&startTime=${startTime + 1}`;
        
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
}