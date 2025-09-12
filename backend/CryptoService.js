// backend/CryptoService.js
import AES from 'crypto-js/aes.js';
import Utf8 from 'crypto-js/enc-utf8.js';

export class CryptoService {
    constructor(masterKey, log) {
        this.log = log;
        if (!masterKey || masterKey.length < 32) {
            this.log('ERROR', 'CRITICAL: MASTER_ENCRYPTION_KEY is missing or too short. It must be at least 32 characters long.');
            this.masterKey = null;
        } else {
            this.masterKey = masterKey;
        }
    }

    encrypt(text) {
        if (!this.masterKey || !text) return text; // Return original if no key or text
        try {
            return AES.encrypt(text, this.masterKey).toString();
        } catch (error) {
            this.log('ERROR', `Encryption failed: ${error.message}`);
            return text; // Return original on failure
        }
    }

    decrypt(ciphertext) {
        if (!this.masterKey || !ciphertext) return null;
        // Don't try to decrypt unencrypted-looking strings or placeholders
        if (ciphertext.length < 32 || !ciphertext.includes('U2FsdGVkX1')) {
            return null;
        }
        try {
            const bytes = AES.decrypt(ciphertext, this.masterKey);
            const originalText = bytes.toString(Utf8);
            if (!originalText) {
                // This can happen if the master key is wrong
                this.log('WARN', 'Decryption resulted in an empty string. Check if MASTER_ENCRYPTION_KEY is correct.');
                return null;
            }
            return originalText;
        } catch (error) {
            this.log('ERROR', `Decryption failed. Ensure MASTER_ENCRYPTION_KEY is correct. Error: ${error.message}`);
            return null;
        }
    }
    
    isEncrypted(text) {
        return typeof text === 'string' && text.startsWith('U2FsdGVkX1');
    }
}
