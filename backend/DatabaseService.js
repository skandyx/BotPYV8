// backend/DatabaseService.js
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';

const KLINE_HISTORY_LIMITS = {
  '1m': 1000,
  '5m': 500,
  '15m': 400,
  '1h': 300,
  '4h': 200,
  '1d': 100,
};

class DatabaseService {
    constructor(log) {
        this.db = null;
        this.log = log;
        this.dbPath = path.join(process.cwd(), 'data', 'klines.sqlite');
        // Promise chain to act as a write queue/mutex
        this.writeLock = Promise.resolve();
    }

    /**
     * Enqueues a write operation to ensure sequential execution and prevent race conditions.
     * @param {() => Promise<any>} task The async function to execute.
     * @returns {Promise<any>} A promise that resolves when the task is complete.
     */
    _enqueueWrite(task) {
        const taskPromise = () => new Promise((resolve, reject) => {
            // The task function itself should handle its own errors.
            // This outer promise ensures the chain continues.
            task().then(resolve).catch(reject);
        });
        
        this.writeLock = this.writeLock.then(taskPromise, taskPromise);
        return this.writeLock;
    }

    async init() {
        try {
            this.db = await open({
                filename: this.dbPath,
                driver: sqlite3.Database
            });
            this.log('INFO', `[DB] Successfully connected to SQLite database at ${this.dbPath}`);
            await this.createTables();
        } catch (error) {
            this.log('ERROR', `[DB] Failed to connect to SQLite: ${error.message}`);
            throw error;
        }
    }

    async createTables() {
        const createKlinesTableSQL = `
            CREATE TABLE IF NOT EXISTS klines (
                symbol TEXT NOT NULL,
                interval TEXT NOT NULL,
                open_time INTEGER NOT NULL,
                open REAL NOT NULL,
                high REAL NOT NULL,
                low REAL NOT NULL,
                close REAL NOT NULL,
                volume REAL NOT NULL,
                close_time INTEGER NOT NULL,
                PRIMARY KEY (symbol, interval, open_time)
            );
        `;
         const createTradeHistoryTableSQL = `
            CREATE TABLE IF NOT EXISTS trade_history (
                id INTEGER PRIMARY KEY,
                mode TEXT NOT NULL,
                symbol TEXT NOT NULL,
                side TEXT NOT NULL,
                entry_price REAL NOT NULL,
                exit_price REAL,
                quantity REAL NOT NULL,
                initial_quantity REAL NOT NULL,
                stop_loss REAL NOT NULL,
                take_profit REAL NOT NULL,
                entry_time TEXT NOT NULL,
                exit_time TEXT,
                pnl REAL,
                pnl_pct REAL,
                status TEXT NOT NULL,
                strategy TEXT,
                entry_snapshot TEXT
            );
        `;
        const createActivePositionsTableSQL = `
             CREATE TABLE IF NOT EXISTS active_positions (
                id INTEGER PRIMARY KEY,
                data TEXT NOT NULL
            );
        `;
        const createBotStateTableSQL = `
            CREATE TABLE IF NOT EXISTS bot_state (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
        `;
        await this.db.exec(createKlinesTableSQL);
        await this.db.exec(createTradeHistoryTableSQL);
        await this.db.exec(createActivePositionsTableSQL);
        await this.db.exec(createBotStateTableSQL);
        this.log('INFO', '[DB] Tables created or already exist.');
    }

    // --- KLINE METHODS ---
    async saveKlines(symbol, interval, klines) {
        if (!this.db || !klines || klines.length === 0) return;

        await this._enqueueWrite(async () => {
            const stmt = await this.db.prepare(`
                INSERT OR REPLACE INTO klines (symbol, interval, open_time, open, high, low, close, volume, close_time)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `);
            try {
                await this.db.run('BEGIN TRANSACTION');
                for (const k of klines) {
                    await stmt.run(symbol, interval, k.openTime, k.open, k.high, k.low, k.close, k.volume, k.closeTime);
                }
                await this.db.run('COMMIT');
            } catch (error) {
                this.log('ERROR', `[DB] Bulk kline save transaction failed for ${symbol} [${interval}]: ${error.message}`);
                await this.db.run('ROLLBACK').catch(err => this.log('ERROR', `[DB] Rollback failed: ${err.message}`));
            } finally {
                await stmt.finalize();
            }
        });
        
        await this.pruneKlines(symbol, interval);
    }
    
    async getKlines(symbol, interval, limit = 0) {
        const effectiveLimit = limit > 0 ? limit : KLINE_HISTORY_LIMITS[interval] || 201;
        const sql = `
            SELECT * FROM klines
            WHERE symbol = ? AND interval = ?
            ORDER BY open_time DESC
            LIMIT ?
        `;
        try {
            const rows = await this.db.all(sql, symbol, interval, effectiveLimit);
            return rows.reverse();
        } catch (error) {
            this.log('ERROR', `[DB] Failed to get klines for ${symbol} [${interval}]: ${error.message}`);
            return [];
        }
    }
    
    async getLatestKlineTime(symbol, interval) {
        const sql = `SELECT MAX(open_time) as latest_time FROM klines WHERE symbol = ? AND interval = ?`;
        try {
            const result = await this.db.get(sql, symbol, interval);
            return result?.latest_time || 0;
        } catch (error) {
            this.log('ERROR', `[DB] Failed to get latest kline time for ${symbol} [${interval}]: ${error.message}`);
            return 0;
        }
    }

    async pruneKlines(symbol, interval) {
        const limit = KLINE_HISTORY_LIMITS[interval];
        if (!limit) return;
        
        await this._enqueueWrite(async () => {
            const sql = `
                DELETE FROM klines
                WHERE rowid IN (
                    SELECT rowid FROM klines
                    WHERE symbol = ? AND interval = ?
                    ORDER BY open_time DESC
                    LIMIT -1 OFFSET ?
                )
            `;
            try {
                await this.db.run(sql, symbol, interval, limit);
            } catch (error) {
                this.log('ERROR', `[DB] Failed to prune klines for ${symbol} [${interval}]: ${error.message}`);
            }
        });
    }
    
    // --- TRADE HISTORY METHODS ---
    async saveTrade(trade) {
        if (!this.db || !trade) return;
        
        return this._enqueueWrite(async () => {
            const sql = `
                INSERT OR REPLACE INTO trade_history (
                    id, mode, symbol, side, entry_price, exit_price, quantity, initial_quantity,
                    stop_loss, take_profit, entry_time, exit_time, pnl, pnl_pct, status, strategy, entry_snapshot
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `;
            try {
                await this.db.run(sql,
                    trade.id, trade.mode, trade.symbol, trade.side, trade.entry_price, trade.exit_price,
                    trade.quantity, trade.initial_quantity, trade.stop_loss, trade.take_profit, trade.entry_time,
                    trade.exit_time, trade.pnl, trade.pnl_pct, trade.status, trade.strategy,
                    JSON.stringify(trade.entry_snapshot)
                );
            } catch (error) {
                 this.log('ERROR', `[DB] Failed to save trade ID ${trade.id}: ${error.message}`);
            }
        });
    }
    
    async getTradeHistory() {
        if (!this.db) return [];
        const sql = `SELECT * FROM trade_history ORDER BY entry_time DESC`;
        try {
            const rows = await this.db.all(sql);
            return rows.map(row => ({
                ...row,
                entry_snapshot: row.entry_snapshot ? JSON.parse(row.entry_snapshot) : null
            }));
        } catch (error) {
            this.log('ERROR', `[DB] Failed to get trade history: ${error.message}`);
            return [];
        }
    }
    
    async clearTradeHistory() {
        if (!this.db) return;
        return this._enqueueWrite(async () => {
            const sql = `DELETE FROM trade_history`;
            try {
                await this.db.run(sql);
                this.log('INFO', '[DB] Trade history table has been cleared.');
            } catch (error) {
                this.log('ERROR', `[DB] Failed to clear trade history: ${error.message}`);
            }
        });
    }

    // --- ACTIVE POSITIONS & BOT STATE METHODS ---
    async saveActivePositions(positions) {
        if (!this.db) return;
        return this._enqueueWrite(async () => {
            try {
                await this.db.run('BEGIN TRANSACTION');
                await this.db.run('DELETE FROM active_positions');
                const stmt = await this.db.prepare('INSERT INTO active_positions (id, data) VALUES (?, ?)');
                for (const pos of positions) {
                    await stmt.run(pos.id, JSON.stringify(pos));
                }
                await stmt.finalize();
                await this.db.run('COMMIT');
            } catch (error) {
                this.log('ERROR', `[DB] Failed to save active positions: ${error.message}`);
                await this.db.run('ROLLBACK').catch(err => this.log('ERROR', `[DB] Rollback failed: ${err.message}`));
            }
        });
    }

    async loadActivePositions() {
        if (!this.db) return [];
        try {
            const rows = await this.db.all('SELECT data FROM active_positions');
            return rows.map(row => JSON.parse(row.data));
        } catch (error) {
            this.log('ERROR', `[DB] Failed to load active positions: ${error.message}`);
            return [];
        }
    }

    async clearActivePositions() {
        if (!this.db) return;
        return this._enqueueWrite(async () => {
            try {
                await this.db.run('DELETE FROM active_positions');
                this.log('INFO', '[DB] Active positions table has been cleared.');
            } catch (error) {
                this.log('ERROR', `[DB] Failed to clear active positions: ${error.message}`);
            }
        });
    }

    async saveBotState(state) {
        if (!this.db) return;
        return this._enqueueWrite(async () => {
            try {
                const stmt = await this.db.prepare('INSERT OR REPLACE INTO bot_state (key, value) VALUES (?, ?)');
                for (const [key, value] of Object.entries(state)) {
                    await stmt.run(key, value.toString());
                }
                await stmt.finalize();
            } catch (error) {
                this.log('ERROR', `[DB] Failed to save bot state: ${error.message}`);
            }
        });
    }

    async loadBotState() {
        if (!this.db) return {};
        try {
            const rows = await this.db.all('SELECT key, value FROM bot_state');
            const state = {};
            for (const row of rows) {
                // Attempt to parse numbers, booleans, etc.
                if (!isNaN(parseFloat(row.value)) && isFinite(row.value)) {
                    state[row.key] = parseFloat(row.value);
                } else if (row.value === 'true' || row.value === 'false') {
                    state[row.key] = row.value === 'true';
                } else {
                    state[row.key] = row.value;
                }
            }
            return state;
        } catch (error) {
            this.log('ERROR', `[DB] Failed to load bot state: ${error.message}`);
            return {};
        }
    }
}

export { DatabaseService };