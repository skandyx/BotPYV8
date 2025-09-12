
import { PriceUpdate, TickerUpdate } from './websocketService';
import { scannerStore } from './scannerStore';
import { positionService } from './positionService';

type PriceStoreSubscriber = (update: PriceUpdate) => void;

class PriceStore {
    private prices = new Map<string, PriceUpdate>();
    private subscribers = new Set<PriceStoreSubscriber>();

    public subscribe(callback: PriceStoreSubscriber): () => void {
        this.subscribers.add(callback);
        // Return an unsubscribe function
        return () => this.unsubscribe(callback);
    }

    public unsubscribe(callback: PriceStoreSubscriber): void {
        this.subscribers.delete(callback);
    }
    
    /**
     * Handles the new unified ticker update message from the backend.
     * @param update The TickerUpdate payload containing symbol, price, and volume.
     */
    public updateTickerData(update: TickerUpdate): void {
        const priceUpdatePayload: PriceUpdate = { symbol: update.symbol, price: update.price };
        
        this.prices.set(update.symbol, priceUpdatePayload);
        
        // Update the scanner store with all ticker info (price, volume, direction)
        scannerStore.handleTickerUpdate(update);
        
        // Notify direct subscribers (like positionService for real-time PnL)
        // with just the price update they need.
        this.subscribers.forEach(callback => callback(priceUpdatePayload));
    }


    public getPrice(symbol: string): PriceUpdate | undefined {
        return this.prices.get(symbol);
    }
}

export const priceStore = new PriceStore();