// backend/server.js
import express from 'express';
import bodyParser from 'body-parser';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';
import dotenv from 'dotenv';
import session from 'express-session';
import crypto from 'crypto';
import { WebSocketServer } from 'ws';
import WebSocket from 'ws';
import http from 'http';
import fetch from 'node-fetch';
import { ScannerService } from './ScannerService.js';
import { createTradingStrategy } from './TradingStrategy.js';
import { DatabaseService } from './DatabaseService.js';
import { CryptoService } from './CryptoService.js';


// --- Basic Setup ---
dotenv.config();
const app = express();
const port = process.env.PORT || 8080;
const server = http.createServer(app);

app.use(cors({
    origin: (origin, callback) => {
        callback(null, true);
    },
    credentials: true,
}));
app.use(bodyParser.json());
app.set('trust proxy', 1); // For Nginx

// --- Session Management ---
app.use(session({
    secret: process.env.SESSION_SECRET || 'a_much_more_secure_and_random_secret_string_32_chars_long',
    resave: false,
    saveUninitialized: true,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        maxAge: 1000 * 60 * 60 * 24
    }
}));

// --- WebSocket Server for Frontend Communication ---
const wss = new WebSocketServer({ noServer: true });
const clients = new Set();
server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    
    if (url.pathname === '/ws') {
        wss.handleUpgrade(request, socket, head, (ws) => {
            wss.emit('connection', ws, request);
        });
    } else {
        socket.destroy();
    }
});
wss.on('connection', (ws) => {
    clients.add(ws);
    log('WEBSOCKET', 'Frontend client connected.');
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            log('WEBSOCKET', `Received message from client: ${JSON.stringify(data)}`);
            
            if (data.type === 'GET_FULL_SCANNER_LIST') {
                log('WEBSOCKET', 'Client requested full scanner list. Sending...');
                ws.send(JSON.stringify({
                    type: 'FULL_SCANNER_LIST',
                    payload: botState.scannerCache
                }));
            }
        } catch (e) {
            log('ERROR', `Failed to parse message from client: ${message}`);
        }
    });
    ws.on('close', () => {
        clients.delete(ws);
        log('WEBSOCKET', 'Frontend client disconnected.');
    });
    ws.on('error', (error) => {
        log('ERROR', `WebSocket client error: ${error.message}`);
        ws.close();
    });
});
function broadcast(message) {
    const data = JSON.stringify(message);
    if (['SCANNER_UPDATE', 'POSITIONS_UPDATED'].includes(message.type)) {
        log('WEBSOCKET', `Broadcasting ${message.type} to ${clients.size} clients.`);
    }
    for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
             client.send(data, (err) => {
                if (err) {
                    log('ERROR', `Failed to send message to a client: ${err.message}`);
                }
            });
        }
    }
}

// --- Logging Service ---
const log = (level, message) => {
    console.log(`[${level}] ${message}`);
    const logEntry = {
        type: 'LOG_ENTRY',
        payload: {
            timestamp: new Date().toISOString(),
            level,
            message
        }
    };
    broadcast(logEntry);
};

// --- Persistence ---
const DATA_DIR = path.join(process.cwd(), 'data');
const SETTINGS_FILE_PATH = path.join(DATA_DIR, 'settings.json');
const AUTH_FILE_PATH = path.join(DATA_DIR, 'auth.json');
const ensureDataDirs = async () => {
    try { await fs.access(DATA_DIR); } catch { await fs.mkdir(DATA_DIR); }
};
const dbService = new DatabaseService(log);
const cryptoService = new CryptoService(process.env.MASTER_ENCRYPTION_KEY, log);

// --- Auth Helpers ---
const hashPassword = (password) => {
    return new Promise((resolve, reject) => {
        const salt = crypto.randomBytes(16).toString('hex');
        crypto.scrypt(password, salt, 64, (err, derivedKey) => {
            if (err) reject(err);
            resolve(salt + ":" + derivedKey.toString('hex'));
        });
    });
};

const verifyPassword = (password, hash) => {
    return new Promise((resolve, reject) => {
        const [salt, key] = hash.split(':');
        if (!salt || !key) {
            return reject(new Error('Invalid hash format.'));
        }
        crypto.scrypt(password, salt, 64, (err, derivedKey) => {
            if (err) reject(err);
            try {
                const keyBuffer = Buffer.from(key, 'hex');
                const match = crypto.timingSafeEqual(keyBuffer, derivedKey);
                resolve(match);
            } catch (e) {
                resolve(false);
            }
        });
    });
};

const loadData = async () => {
    try {
        const settingsContent = await fs.readFile(SETTINGS_FILE_PATH, 'utf-8');
        botState.settings = JSON.parse(settingsContent);
    } catch {
        log("WARN", "settings.json not found. Loading from .env defaults.");
        botState.settings = {
            INITIAL_VIRTUAL_BALANCE: parseFloat(process.env.INITIAL_VIRTUAL_BALANCE) || 10000,
            MAX_OPEN_POSITIONS: parseInt(process.env.MAX_OPEN_POSITIONS, 10) || 5,
            POSITION_SIZE_PCT: parseFloat(process.env.POSITION_SIZE_PCT) || 2.0,
            TAKE_PROFIT_PCT: parseFloat(process.env.TAKE_PROFIT_PCT) || 4.0,
            STOP_LOSS_PCT: parseFloat(process.env.STOP_LOSS_PCT) || 2.0,
            USE_TRAILING_STOP_LOSS: process.env.USE_TRAILING_STOP_LOSS === 'true',
            TRAILING_STOP_LOSS_PCT: parseFloat(process.env.TRAILING_STOP_LOSS_PCT) || 1.5,
            SLIPPAGE_PCT: parseFloat(process.env.SLIPPAGE_PCT) || 0.05,
            MIN_VOLUME_USD: parseFloat(process.env.MIN_VOLUME_USD) || 10000000,
            SCANNER_DISCOVERY_INTERVAL_SECONDS: parseInt(process.env.SCANNER_DISCOVERY_INTERVAL_SECONDS, 10) || 3600,
            EXCLUDED_PAIRS: process.env.EXCLUDED_PAIRS || "USDCUSDT,FDUSDUSDT",
            USE_VOLUME_CONFIRMATION: process.env.USE_VOLUME_CONFIRMATION === 'true',
            USE_MARKET_REGIME_FILTER: process.env.USE_MARKET_REGIME_FILTER === 'true',
            REQUIRE_STRONG_BUY: process.env.REQUIRE_STRONG_BUY === 'true',
            LOSS_COOLDOWN_HOURS: parseInt(process.env.LOSS_COOLDOWN_HOURS, 10) || 4,
            BINANCE_API_KEY: process.env.BINANCE_API_KEY || '',
            BINANCE_SECRET_KEY: process.env.BINANCE_SECRET_KEY || '',
            USE_ATR_STOP_LOSS: false,
            ATR_MULTIPLIER: 1.5,
            USE_AUTO_BREAKEVEN: true,
            BREAKEVEN_TRIGGER_PCT: parseFloat(process.env.BREAKEVEN_TRIGGER_PCT) || 0.5,
            ADJUST_BREAKEVEN_FOR_FEES: process.env.ADJUST_BREAKEVEN_FOR_FEES === 'true',
            TRANSACTION_FEE_PCT: parseFloat(process.env.TRANSACTION_FEE_PCT) || 0.1,
            USE_RSI_SAFETY_FILTER: true,
            RSI_OVERBOUGHT_THRESHOLD: 75,
            USE_PARTIAL_TAKE_PROFIT: false,
            PARTIAL_TP_TRIGGER_PCT: 1.5,
            PARTIAL_TP_SELL_QTY_PCT: 50,
            USE_DYNAMIC_POSITION_SIZING: false,
            STRONG_BUY_POSITION_SIZE_PCT: 3.0,
            USE_PARABOLIC_FILTER: true,
            PARABOLIC_FILTER_PERIOD_MINUTES: 5,
            PARABOLIC_FILTER_THRESHOLD_PCT: 3.0,
            USE_IGNITION_STRATEGY: process.env.USE_IGNITION_STRATEGY === 'true',
            IGNITION_VOLUME_SPIKE_FACTOR: parseFloat(process.env.IGNITION_VOLUME_SPIKE_FACTOR) || 5,
            IGNITION_PRICE_ACCEL_PERIOD_MINUTES: parseInt(process.env.IGNITION_PRICE_ACCEL_PERIOD_MINUTES, 10) || 5,
            IGNITION_PRICE_ACCEL_THRESHOLD_PCT: parseFloat(process.env.IGNITION_PRICE_ACCEL_THRESHOLD_PCT) || 2.0,
            IGNITION_MAX_SPREAD_PCT: parseFloat(process.env.IGNITION_MAX_SPREAD_PCT) || 0.5,
            IGNITION_TSL_USE_ATR_BUFFER: process.env.IGNITION_TSL_USE_ATR_BUFFER === 'true',
            IGNITION_TSL_ATR_MULTIPLIER: parseFloat(process.env.IGNITION_TSL_ATR_MULTIPLIER) || 0.5,
            REAL_MODE_READ_ONLY: process.env.REAL_MODE_READ_ONLY === 'true',
        };
        await saveData('settings');
    }

    // Load state from DB
    const persistedState = await dbService.loadBotState();
    botState.balance = persistedState.balance || botState.settings.INITIAL_VIRTUAL_BALANCE;
    botState.tradeIdCounter = persistedState.tradeIdCounter || 1;
    botState.isRunning = persistedState.isRunning !== undefined ? persistedState.isRunning : true;
    botState.tradingMode = persistedState.tradingMode || 'VIRTUAL';
    
    // Load active positions from DB
    botState.activePositions = await dbService.loadActivePositions();
    log('INFO', `[DB] Loaded ${botState.activePositions.length} active positions.`);

    // Load trade history from DB
    botState.tradeHistory = await dbService.getTradeHistory();
    log('INFO', `[DB] Loaded ${botState.tradeHistory.length} trades from history.`);

    try {
        const authContent = await fs.readFile(AUTH_FILE_PATH, 'utf-8');
        const authData = JSON.parse(authContent);
        if (authData.passwordHash) {
            botState.passwordHash = authData.passwordHash;
        } else {
            throw new Error("Invalid auth file format");
        }
    } catch {
        log("WARN", "auth.json not found or invalid. Initializing from .env.");
        const initialPassword = process.env.APP_PASSWORD;
        if (!initialPassword) {
            log('ERROR', 'CRITICAL: APP_PASSWORD is not set in .env file. Please set it and restart.');
            process.exit(1);
        }
        botState.passwordHash = await hashPassword(initialPassword);
        await fs.writeFile(AUTH_FILE_PATH, JSON.stringify({ passwordHash: botState.passwordHash }, null, 2));
        log('INFO', 'Created auth.json with a new secure password hash.');
    }
    
    // Decrypt API keys after loading settings
    botState.decryptedApiKey = cryptoService.decrypt(botState.settings.BINANCE_API_KEY);
    botState.decryptedApiSecret = cryptoService.decrypt(botState.settings.BINANCE_SECRET_KEY);

    realtimeAnalyzer.updateSettings(botState.settings);
};

const saveData = async (type) => {
    if (type === 'settings') {
        await fs.writeFile(SETTINGS_FILE_PATH, JSON.stringify(botState.settings, null, 2));
    } else if (type === 'state') {
        const stateToPersist = {
            balance: botState.balance,
            tradeIdCounter: botState.tradeIdCounter,
            isRunning: botState.isRunning,
            tradingMode: botState.tradingMode,
        };
        await dbService.saveBotState(stateToPersist);
        await dbService.saveActivePositions(botState.activePositions);
    } else if (type === 'auth') {
        await fs.writeFile(AUTH_FILE_PATH, JSON.stringify({ passwordHash: botState.passwordHash }, null, 2));
    }
};

// --- Binance API Helpers ---
const getBinanceAccountInfo = async () => {
    const { decryptedApiKey, decryptedApiSecret } = botState;
    if (!decryptedApiKey || !decryptedApiSecret) {
        throw new Error('Binance API Key or Secret is not configured or failed to decrypt.');
    }

    const endpoint = 'https://api.binance.com/api/v3/account';
    const timestamp = Date.now();
    const queryString = `timestamp=${timestamp}`;
    
    const signature = crypto
        .createHmac('sha256', decryptedApiSecret)
        .update(queryString)
        .digest('hex');

    const url = `${endpoint}?${queryString}&signature=${signature}`;

    try {
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'X-MBX-APIKEY': decryptedApiKey }
        });

        const data = await response.json();
        if (!response.ok) {
            throw new Error(`Binance API Error: ${data.msg || `Status ${response.status}`}`);
        }
        return data;
    } catch (error) {
        log('BINANCE_API', `Failed to fetch Binance account info: ${error.message}`);
        throw error;
    }
};


// --- Binance WebSocket for Real-time Kline Data ---
let binanceWs = null;
const BINANCE_WS_URL = 'wss://stream.binance.com:9443/ws';
const subscribedStreams = new Set();
let reconnectBinanceWsTimeout = null;

function connectToBinanceStreams() {
    if (binanceWs && (binanceWs.readyState === WebSocket.OPEN || binanceWs.readyState === WebSocket.CONNECTING)) {
        return;
    }
    if (reconnectBinanceWsTimeout) clearTimeout(reconnectBinanceWsTimeout);

    log('BINANCE_WS', 'Connecting to Binance streams...');
    binanceWs = new WebSocket(BINANCE_WS_URL);

    binanceWs.on('open', () => {
        log('BINANCE_WS', 'Connected. Subscribing to streams...');
        if (subscribedStreams.size > 0) {
            const streams = Array.from(subscribedStreams);
            const payload = { method: "SUBSCRIBE", params: streams, id: 1 };
            binanceWs.send(JSON.stringify(payload));
            log('BINANCE_WS', `Resubscribed to ${streams.length} streams.`);
        }
    });

    binanceWs.on('message', (data) => {
        try {
            const msg = JSON.parse(data);
            if (msg.e === 'kline') {
                const { s: symbol, k: kline } = msg;
                if (kline.x) { // is closed kline
                     const formattedKline = {
                        openTime: kline.t, open: parseFloat(kline.o), high: parseFloat(kline.h),
                        low: parseFloat(kline.l), close: parseFloat(kline.c), volume: parseFloat(kline.v),
                        closeTime: kline.T,
                    };
                    realtimeAnalyzer.handleNewKline(symbol, kline.i, formattedKline);
                }
            } else if (msg.e === '24hrTicker') {
                const symbol = msg.s;
                const newPrice = parseFloat(msg.c);
                const newVolume = parseFloat(msg.q); 

                botState.priceCache.set(symbol, { price: newPrice });
                const updatedPair = botState.scannerCache.find(p => p.symbol === symbol);
                if (updatedPair) {
                    const oldPrice = updatedPair.price;
                    updatedPair.price = newPrice;
                    updatedPair.volume = newVolume; 
                    updatedPair.priceDirection = newPrice > oldPrice ? 'up' : newPrice < oldPrice ? 'down' : (updatedPair.priceDirection || 'neutral');
                    broadcast({ type: 'SCANNER_UPDATE', payload: updatedPair });
                }
                broadcast({ type: 'PRICE_UPDATE', payload: {symbol: symbol, price: newPrice } });
            } else if (msg.e === 'bookTicker') {
                botState.bookTickerCache.set(msg.s, {
                    bid: parseFloat(msg.b),
                    ask: parseFloat(msg.a)
                });
            }
        } catch (e) {
            log('ERROR', `Error processing Binance WS message: ${e.message}`);
        }
    });

    binanceWs.on('close', () => {
        log('WARN', 'Binance WebSocket disconnected. Reconnecting in 5s...');
        binanceWs = null;
        reconnectBinanceWsTimeout = setTimeout(connectToBinanceStreams, 5000);
    });
    binanceWs.on('error', (err) => log('ERROR', `Binance WebSocket error: ${err.message}`));
}

function updateBinanceSubscriptions(baseSymbols) {
    const symbolsFromScanner = new Set(baseSymbols);
    const symbolsFromPositions = new Set(botState.activePositions.map(p => p.symbol));
    const allSymbolsForTickers = new Set([...symbolsFromScanner, ...symbolsFromPositions]);
    const newStreams = new Set();
    
    allSymbolsForTickers.forEach(s => {
        newStreams.add(`${s.toLowerCase()}@ticker`);
        if (botState.settings.USE_IGNITION_STRATEGY) {
            newStreams.add(`${s.toLowerCase()}@bookTicker`);
        }
    });

    if (!botState.settings.USE_IGNITION_STRATEGY) {
        symbolsFromScanner.forEach(s => {
            newStreams.add(`${s.toLowerCase()}@kline_15m`);
        });
    }
    
    const symbolsFor1m = botState.settings.USE_IGNITION_STRATEGY ? symbolsFromScanner : botState.hotlist;
    symbolsFor1m.forEach(s => {
        newStreams.add(`${s.toLowerCase()}@kline_1m`);
    });

    const streamsToUnsub = [...subscribedStreams].filter(s => !newStreams.has(s));
    const streamsToSub = [...newStreams].filter(s => !subscribedStreams.has(s));

    if (binanceWs && binanceWs.readyState === WebSocket.OPEN) {
        if (streamsToUnsub.length > 0) {
            binanceWs.send(JSON.stringify({ method: "UNSUBSCRIBE", params: streamsToUnsub, id: 2 }));
            log('BINANCE_WS', `Unsubscribed from ${streamsToUnsub.length} streams.`);
        }
        if (streamsToSub.length > 0) {
            binanceWs.send(JSON.stringify({ method: "SUBSCRIBE", params: streamsToSub, id: 3 }));
            log('BINANCE_WS', `Subscribed to ${streamsToSub.length} new streams.`);
        }
    }

    subscribedStreams.clear();
    newStreams.forEach(s => subscribedStreams.add(s));
}

function addSymbolTo1mStream(symbol) {
    botState.hotlist.add(symbol);
    const streamName = `${symbol.toLowerCase()}@kline_1m`;
    if (!subscribedStreams.has(streamName)) {
        subscribedStreams.add(streamName);
        if (binanceWs && binanceWs.readyState === WebSocket.OPEN) {
            binanceWs.send(JSON.stringify({ method: "SUBSCRIBE", params: [streamName], id: Date.now() }));
            log('BINANCE_WS', `Dynamically subscribed to 1m stream for ${symbol}.`);
        }
        realtimeAnalyzer.hydrateSymbol(symbol, '1m');
    }
}

function removeSymbolFrom1mStream(symbol) {
    botState.hotlist.delete(symbol);
    const streamName = `${symbol.toLowerCase()}@kline_1m`;
    if (subscribedStreams.has(streamName)) {
        subscribedStreams.delete(streamName);
        if (binanceWs && binanceWs.readyState === WebSocket.OPEN) {
            binanceWs.send(JSON.stringify({ method: "UNSUBSCRIBE", params: [streamName], id: Date.now() }));
            log('BINANCE_WS', `Dynamically unsubscribed from 1m stream for ${symbol}.`);
        }
    }
}

// --- Bot State & Core Logic ---
let botState = {
    settings: {},
    decryptedApiKey: null,
    decryptedApiSecret: null,
    balance: 10000,
    activePositions: [],
    tradeHistory: [],
    tradeIdCounter: 1,
    scannerCache: [],
    isRunning: true,
    tradingMode: 'VIRTUAL',
    passwordHash: '',
    recentlyLostSymbols: new Map(),
    hotlist: new Set(),
    priceCache: new Map(),
    bookTickerCache: new Map(),
};

const scanner = new ScannerService(log);
let scannerInterval = null;

// --- Latency Checker ---
let binanceLatency = null;
const checkBinanceLatency = async () => {
    try {
        const startTime = Date.now();
        const response = await fetch('https://api.binance.com/api/v3/ping');
        if (response.ok) {
            const endTime = Date.now();
            binanceLatency = endTime - startTime;
            broadcast({ type: 'LATENCY_UPDATE', payload: { latency: binanceLatency } });
        } else {
            binanceLatency = null;
            broadcast({ type: 'LATENCY_UPDATE', payload: { latency: null } });
        }
    } catch (error) {
        binanceLatency = null;
        broadcast({ type: 'LATENCY_UPDATE', payload: { latency: null } });
    }
};

// --- Instantiate Strategy Module ---
const { realtimeAnalyzer, tradingEngine } = createTradingStrategy({
    log,
    broadcast,
    saveData,
    getState: () => botState,
    dbService,
    addSymbolTo1mStream,
    removeSymbolFrom1mStream,
});

async function runScannerCycle() {
    if (!botState.isRunning) return;
    try {
        const discoveredPairs = await scanner.discoverAndFilterPairsFromBinance(botState.settings);
        const discoveredSymbols = new Set(discoveredPairs.map(p => p.symbol));
        const existingSymbols = new Set(botState.scannerCache.map(p => p.symbol));

        const newSymbols = [...discoveredSymbols].filter(s => !existingSymbols.has(s));
        
        if (newSymbols.length > 0) {
            log('SCANNER', `Discovered ${newSymbols.length} new pairs. Hydrating data...`);
            const hydrationPromises = newSymbols.flatMap(symbol => [
                realtimeAnalyzer.hydrateSymbol(symbol, '4h'),
                realtimeAnalyzer.hydrateSymbol(symbol, '1h'),
                realtimeAnalyzer.hydrateSymbol(symbol, '15m'),
                realtimeAnalyzer.hydrateSymbol(symbol, '1m')
            ]);
            await Promise.all(hydrationPromises);
        }

        botState.scannerCache = botState.scannerCache.filter(p => discoveredSymbols.has(p.symbol));
        
        const existingPairsMap = new Map(botState.scannerCache.map(p => [p.symbol, p]));

        for (const discoveredPair of discoveredPairs) {
            const existingPair = existingPairsMap.get(discoveredPair.symbol);
            if (existingPair) {
                existingPair.volume = discoveredPair.volume;
                existingPair.price = discoveredPair.price;
            } else {
                const analysisData = await realtimeAnalyzer.performInitialAnalysis(discoveredPair.symbol);
                if(analysisData) {
                    botState.scannerCache.push({ ...discoveredPair, ...analysisData });
                }
            }
        }
        
        updateBinanceSubscriptions(botState.scannerCache.map(p => p.symbol));
        
    } catch (error) {
        log('ERROR', `Scanner cycle failed: ${error.message}`);
    }
}

// --- Main Application Loop ---
const startBot = () => {
    if (scannerInterval) clearInterval(scannerInterval);
    
    runScannerCycle(); 
    scannerInterval = setInterval(runScannerCycle, botState.settings.SCANNER_DISCOVERY_INTERVAL_SECONDS * 1000);
    
    setInterval(() => {
        if (botState.isRunning) {
            tradingEngine.monitorAndManagePositions();
        }
    }, 1000);
    
    setInterval(async () => {
        if (botState.tradingMode !== 'VIRTUAL' && botState.isRunning) {
            try {
                const accountInfo = await getBinanceAccountInfo();
                const usdtBalance = accountInfo.balances.find(b => b.asset === 'USDT');
                if (usdtBalance) {
                    const realBalance = parseFloat(usdtBalance.free);
                    if (botState.balance !== realBalance) {
                        log('INFO', `Syncing real Binance balance. Old: ${botState.balance.toFixed(2)}, New: ${realBalance.toFixed(2)}`);
                        botState.balance = realBalance;
                    }
                }
            } catch (error) {
                log('ERROR', `Failed to sync real Binance balance: ${error.message}`);
            }
        }
    }, 30000);

    connectToBinanceStreams();
    
    checkBinanceLatency();
    setInterval(checkBinanceLatency, 10000);
    
    log('INFO', 'Bot started. Initializing scanner and position manager...');
};

// --- API Endpoints ---
const requireAuth = (req, res, next) => {
    if (req.session && req.session.isAuthenticated) {
        next();
    } else {
        res.status(401).json({ message: 'Unauthorized' });
    }
};

app.post('/api/login', async (req, res) => {
    const { password } = req.body;
    try {
        const isValid = await verifyPassword(password, botState.passwordHash);
        if (isValid) {
            req.session.isAuthenticated = true;
            res.json({ success: true, message: 'Login successful.' });
        } else {
            res.status(401).json({ success: false, message: 'Invalid credentials.' });
        }
    } catch (error) {
        log('ERROR', `Login attempt failed: ${error.message}`);
        res.status(500).json({ success: false, message: 'Internal server error during login.' });
    }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy(err => {
        if (err) {
            return res.status(500).json({ message: 'Could not log out.' });
        }
        res.clearCookie('connect.sid');
        res.status(204).send();
    });
});

app.get('/api/check-session', (req, res) => {
    if (req.session && req.session.isAuthenticated) {
        res.json({ isAuthenticated: true });
    } else {
        res.json({ isAuthenticated: false });
    }
});

app.post('/api/change-password', requireAuth, async (req, res) => {
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 8) {
        return res.status(400).json({ success: false, message: 'Password must be at least 8 characters long.' });
    }
    try {
        botState.passwordHash = await hashPassword(newPassword);
        await saveData('auth');
        log('INFO', 'User password has been successfully updated.');
        res.json({ success: true, message: 'Password updated successfully.' });
    } catch (error) {
        log('ERROR', `Failed to update password: ${error.message}`);
        res.status(500).json({ success: false, message: 'Internal server error.' });
    }
});


app.get('/api/settings', requireAuth, (req, res) => {
    // Never send the decrypted keys to the frontend.
    // Send the encrypted (or original) keys from the settings object.
    const settingsToSend = {
        ...botState.settings,
        BINANCE_API_KEY: botState.settings.BINANCE_API_KEY || '',
        BINANCE_SECRET_KEY: botState.settings.BINANCE_SECRET_KEY ? '********' : '' // Mask secret
    };
    res.json(settingsToSend);
});

app.post('/api/settings', requireAuth, async (req, res) => {
    const oldSettings = { ...botState.settings };
    const newSettings = { ...botState.settings, ...req.body };
    
    // If API keys are updated, encrypt them before saving
    if (newSettings.BINANCE_API_KEY !== oldSettings.BINANCE_API_KEY) {
        newSettings.BINANCE_API_KEY = cryptoService.encrypt(newSettings.BINANCE_API_KEY);
    }
    if (req.body.BINANCE_SECRET_KEY && req.body.BINANCE_SECRET_KEY !== '********') {
        newSettings.BINANCE_SECRET_KEY = cryptoService.encrypt(req.body.BINANCE_SECRET_KEY);
    } else {
        newSettings.BINANCE_SECRET_KEY = oldSettings.BINANCE_SECRET_KEY; // Keep old one if not changed
    }

    botState.settings = newSettings;
    
    if (botState.tradingMode === 'VIRTUAL' && botState.settings.INITIAL_VIRTUAL_BALANCE !== oldSettings.INITIAL_VIRTUAL_BALANCE) {
        botState.balance = botState.settings.INITIAL_VIRTUAL_BALANCE;
        log('INFO', `Virtual balance was adjusted to match new setting: $${botState.balance}`);
        await saveData('state');
        broadcast({ type: 'POSITIONS_UPDATED' });
    }

    await saveData('settings');
    botState.decryptedApiKey = cryptoService.decrypt(botState.settings.BINANCE_API_KEY);
    botState.decryptedApiSecret = cryptoService.decrypt(botState.settings.BINANCE_SECRET_KEY);
    realtimeAnalyzer.updateSettings(botState.settings);
    
    if (botState.settings.SCANNER_DISCOVERY_INTERVAL_SECONDS !== oldSettings.SCANNER_DISCOVERY_INTERVAL_SECONDS) {
        log('INFO', `Scanner interval updated to ${botState.settings.SCANNER_DISCOVERY_INTERVAL_SECONDS} seconds.`);
        if (scannerInterval) clearInterval(scannerInterval);
        scannerInterval = setInterval(runScannerCycle, botState.settings.SCANNER_DISCOVERY_INTERVAL_SECONDS * 1000);
    }
    
    res.json({ success: true });
});

app.get('/api/status', requireAuth, async (req, res) => {
    let currentBalance = botState.balance;

    if (botState.tradingMode !== 'VIRTUAL') {
        try {
            const accountInfo = await getBinanceAccountInfo();
            const usdtBalance = accountInfo.balances.find(b => b.asset === 'USDT');
            if (usdtBalance) {
                currentBalance = parseFloat(usdtBalance.free);
            } else {
                log('WARN', 'Could not find USDT balance in Binance account response. Using internal value.');
            }
        } catch (error) {
            log('ERROR', `Could not fetch real Binance balance for status, falling back to internal state: ${error.message}`);
        }
    }

    res.json({
        mode: botState.tradingMode,
        balance: currentBalance,
        positions: botState.activePositions.length,
        monitored_pairs: botState.scannerCache.length,
        top_pairs: botState.scannerCache
            .sort((a, b) => (b.score_value || 0) - (a.score_value || 0))
            .slice(0, 15)
            .map(p => p.symbol),
        max_open_positions: botState.settings.MAX_OPEN_POSITIONS
    });
});

app.get('/api/positions', requireAuth, (req, res) => {
    const augmentedPositions = botState.activePositions.map(pos => {
        const priceData = botState.priceCache.get(pos.symbol);
        const currentPrice = priceData ? priceData.price : pos.entry_price;
        const pnl = (currentPrice - pos.entry_price) * pos.quantity;
        const entryValue = pos.entry_price * pos.quantity;
        const pnl_pct = entryValue > 0 ? (pnl / entryValue) * 100 : 0;

        return {
            ...pos,
            current_price: currentPrice,
            pnl: pnl,
            pnl_pct: pnl_pct,
        };
    });
    res.json(augmentedPositions);
});

app.get('/api/history', requireAuth, (req, res) => {
    res.json(botState.tradeHistory);
});

app.get('/api/performance-stats', requireAuth, (req, res) => {
    const total_trades = botState.tradeHistory.length;
    const winning_trades = botState.tradeHistory.filter(t => (t.pnl || 0) > 0).length;
    const losing_trades = botState.tradeHistory.filter(t => (t.pnl || 0) < 0).length;
    const total_pnl = botState.tradeHistory.reduce((sum, t) => sum + (t.pnl || 0), 0);
    const win_rate = total_trades > 0 ? (winning_trades / total_trades) * 100 : 0;
    
    const pnlPcts = botState.tradeHistory.map(t => t.pnl_pct).filter(p => p !== undefined && p !== null);
    const avg_pnl_pct = pnlPcts.length > 0 ? pnlPcts.reduce((a, b) => a + b, 0) / pnlPcts.length : 0;

    res.json({ total_trades, winning_trades, losing_trades, total_pnl, win_rate, avg_pnl_pct });
});

app.get('/api/scanner', requireAuth, (req, res) => {
    res.json(botState.scannerCache);
});


app.post('/api/open-trade', requireAuth, (req, res) => {
    res.status(501).json({ message: 'Manual trade opening not implemented.' });
});

app.post('/api/close-trade/:id', requireAuth, (req, res) => {
    const tradeId = parseInt(req.params.id, 10);
    const trade = botState.activePositions.find(t => t.id === tradeId);
    if (!trade) return res.status(404).json({ message: 'Trade not found.' });

    const priceData = botState.priceCache.get(trade.symbol);
    const exitPrice = priceData ? priceData.price : trade.entry_price;

    const closedTrade = tradingEngine.closeTrade(tradeId, exitPrice, 'Manual Close');
    if (closedTrade) {
        saveData('state');
        broadcast({ type: 'POSITIONS_UPDATED' });
        res.json(closedTrade);
    } else {
        res.status(404).json({ message: 'Trade not found during close operation.' });
    }
});

app.post('/api/clear-data', requireAuth, async (req, res) => {
    log('WARN', 'User initiated data clear. Resetting all trade history and balance.');
    botState.balance = botState.settings.INITIAL_VIRTUAL_BALANCE;
    botState.activePositions = [];
    botState.tradeHistory = [];
    botState.tradeIdCounter = 1;
    await dbService.clearTradeHistory();
    await dbService.clearActivePositions();
    await saveData('state');
    broadcast({ type: 'POSITIONS_UPDATED' });
    res.json({ success: true });
});

app.post('/api/test-connection', requireAuth, async (req, res) => {
    let { apiKey, secretKey } = req.body;
    if (!apiKey || !secretKey) {
        return res.status(400).json({ success: false, message: 'API Key and Secret are required.' });
    }
    
    // Attempt to decrypt if they look like they might be encrypted, otherwise use as-is
    // This allows testing a new key before saving it
    const decryptedKey = cryptoService.isEncrypted(apiKey) ? cryptoService.decrypt(apiKey) : apiKey;
    const decryptedSecret = cryptoService.isEncrypted(secretKey) ? cryptoService.decrypt(secretKey) : secretKey;

    try {
        const endpoint = 'https://api.binance.com/api/v3/account';
        const timestamp = Date.now();
        const queryString = `timestamp=${timestamp}`;
        const signature = crypto.createHmac('sha256', decryptedSecret).update(queryString).digest('hex');
        const url = `${endpoint}?${queryString}&signature=${signature}`;
        
        const response = await fetch(url, {
            method: 'GET',
            headers: { 'X-MBX-APIKEY': decryptedKey }
        });

        const data = await response.json();

        if (response.ok) {
            res.json({ success: true, message: 'Connexion à Binance réussie et clés API valides !' });
        } else {
            throw new Error(data.msg || `Status: ${response.status}`);
        }
    } catch (error) {
        res.status(500).json({ success: false, message: `Échec du test de connexion : ${error.message}` });
    }
});


app.get('/api/bot/status', requireAuth, (req, res) => {
    res.json({ isRunning: botState.isRunning });
});
app.post('/api/bot/start', requireAuth, async (req, res) => {
    botState.isRunning = true;
    await saveData('state');
    log('INFO', 'Bot has been started via API.');
    res.json({ success: true });
});
app.post('/api/bot/stop', requireAuth, async (req, res) => {
    botState.isRunning = false;
    await saveData('state');
    log('INFO', 'Bot has been stopped via API.');
    res.json({ success: true });
});
app.get('/api/mode', requireAuth, (req, res) => {
    res.json({ mode: botState.tradingMode });
});
app.post('/api/mode', requireAuth, async (req, res) => {
    const { mode } = req.body;
    if (['VIRTUAL', 'REAL_PAPER', 'REAL_LIVE'].includes(mode)) {
        botState.tradingMode = mode;
        await saveData('state');
        log('INFO', `Trading mode switched to ${mode}.`);
        res.json({ success: true, mode: botState.tradingMode });
    } else {
        res.status(400).json({ success: false, message: 'Invalid mode.' });
    }
});

// --- Serve Frontend ---
const __dirname = path.resolve();
app.use(express.static(path.join(__dirname, '..', 'dist')));
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'dist', 'index.html'));
});

// --- Initialize and Start Server ---
(async () => {
    try {
        await ensureDataDirs();
        await dbService.init();
        await loadData();
        startBot();
        server.listen(port, () => {
            log('INFO', `Server running on http://localhost:${port}`);
        });
    } catch (error) {
        log('ERROR', `Failed to initialize and start server: ${error.message}`);
        process.exit(1);
    }
})();