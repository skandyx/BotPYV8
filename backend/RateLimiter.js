// backend/RateLimiter.js

export class RateLimiter {
    constructor(requestsPerInterval, intervalMs) {
        this.requestsPerInterval = requestsPerInterval;
        this.intervalMs = intervalMs;
        this.queue = [];
        this.processing = false;
        
        setInterval(() => this.processQueue(), this.intervalMs);
    }

    add(task) {
        return new Promise((resolve, reject) => {
            this.queue.push({ task, resolve, reject });
            if (!this.processing) {
                this.processQueue();
            }
        });
    }

    processQueue() {
        if (this.processing || this.queue.length === 0) {
            return;
        }

        this.processing = true;

        const itemsToProcess = this.queue.splice(0, this.requestsPerInterval);

        const promises = itemsToProcess.map(({ task, resolve, reject }) => {
            return task()
                .then(result => resolve(result))
                .catch(error => reject(error));
        });

        Promise.allSettled(promises).finally(() => {
            this.processing = false;
        });
    }
}
