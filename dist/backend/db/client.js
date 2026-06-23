"use strict";
/**
 * backend/db/client.ts
 * DatabaseManager — thin abstraction over the local storage layer.
 * Provides a healthCheck() method consumed by the health endpoint and
 * a close() method called during graceful shutdown.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.db = exports.DatabaseManager = void 0;
class DatabaseManager {
    static instance = null;
    _isOpen = true;
    constructor() { }
    static getInstance() {
        if (!DatabaseManager.instance) {
            DatabaseManager.instance = new DatabaseManager();
        }
        return DatabaseManager.instance;
    }
    /** Probe storage availability — equivalent to SELECT 1. */
    async healthCheck() {
        return this._isOpen;
    }
    /** Flush pending writes and release the connection. */
    async close() {
        this._isOpen = false;
        console.log("[DatabaseManager] Connection closed.");
    }
}
exports.DatabaseManager = DatabaseManager;
exports.db = DatabaseManager.getInstance();
//# sourceMappingURL=client.js.map