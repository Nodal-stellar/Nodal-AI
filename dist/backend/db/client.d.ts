/**
 * backend/db/client.ts
 * DatabaseManager — thin abstraction over the local storage layer.
 * Provides a healthCheck() method consumed by the health endpoint and
 * a close() method called during graceful shutdown.
 */
export declare class DatabaseManager {
    private static instance;
    private _isOpen;
    private constructor();
    static getInstance(): DatabaseManager;
    /** Probe storage availability — equivalent to SELECT 1. */
    healthCheck(): Promise<boolean>;
    /** Flush pending writes and release the connection. */
    close(): Promise<void>;
}
export declare const db: DatabaseManager;
//# sourceMappingURL=client.d.ts.map