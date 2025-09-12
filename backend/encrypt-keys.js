// backend/encrypt-keys.js
import dotenv from 'dotenv';
import readline from 'readline';
import { CryptoService } from './CryptoService.js';

dotenv.config();

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const question = (query) => new Promise(resolve => rl.question(query, resolve));

const log = (level, message) => {
    const colors = {
        INFO: '\x1b[36m', // Cyan
        SUCCESS: '\x1b[32m', // Green
        WARN: '\x1b[33m', // Yellow
        ERROR: '\x1b[31m', // Red
        RESET: '\x1b[0m'
    };
    console.log(`${colors[level] || ''}[${level}] ${message}${colors.RESET}`);
};

const main = async () => {
    log('INFO', 'BOTPY API Key Encryption Utility');
    log('INFO', '---------------------------------');
    log('INFO', 'This script will encrypt your Binance API keys for secure storage in your .env file.');

    const masterKey = process.env.MASTER_ENCRYPTION_KEY;
    if (!masterKey || masterKey.length < 32) {
        log('ERROR', 'CRITICAL: MASTER_ENCRYPTION_KEY is not set or is less than 32 characters in your .env file.');
        log('ERROR', 'Please set a strong, 32+ character key and run this script again.');
        rl.close();
        return;
    }
    
    log('INFO', 'MASTER_ENCRYPTION_KEY loaded successfully.');
    const cryptoService = new CryptoService(masterKey, log);

    const apiKey = await question('\nEnter your PLAINTEXT Binance API Key: ');
    if (!apiKey) {
        log('ERROR', 'API Key cannot be empty.');
        rl.close();
        return;
    }

    const secretKey = await question('Enter your PLAINTEXT Binance Secret Key: ');
    if (!secretKey) {
        log('ERROR', 'Secret Key cannot be empty.');
        rl.close();
        return;
    }

    const encryptedApiKey = cryptoService.encrypt(apiKey);
    const encryptedSecretKey = cryptoService.encrypt(secretKey);

    log('SUCCESS', '\nEncryption successful!');
    log('SUCCESS', '-------------------------------------------------');
    log('WARN', 'Copy the following lines and paste them into your .env file, replacing the existing ones.');
    console.log(`\nBINANCE_API_KEY_ENCRYPTED=${encryptedApiKey}`);
    console.log(`BINANCE_SECRET_KEY_ENCRYPTED=${encryptedSecretKey}\n`);
    log('WARN', 'For security, it is recommended to delete this script after use.');
    log('SUCCESS', '-------------------------------------------------');

    rl.close();
};

main();
