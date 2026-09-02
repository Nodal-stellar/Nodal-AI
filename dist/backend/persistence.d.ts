/**
 * backend/persistence.ts
 *
 * SQLite-backed audit log for every AgentResult produced by PayFiAgent.run().
 * The DB path is configured via DB_PATH (default: ./agent.db).
 * Pass ":memory:" for in-process testing via _setDb().
 */
import Database from 'better-sqlite3';
import type { AgentResult } from './agent';
export type PersistedResult = AgentResult & {
    timestamp: string;
};
/**
 * Execute a trivial query against the live connection (#234).
 *
 * `getDb()` owns the only `better-sqlite3` handle, so the probe belongs here
 * rather than in DatabaseManager — duplicating connection ownership to satisfy
 * a health check would mean the check exercised a handle the app does not use.
 *
 * Throws if the file is missing, corrupt, or the connection is in a bad state,
 * which is exactly what an in-memory boolean cannot detect.
 */
export declare function probeDb(): void;
export declare function saveResult(result: PersistedResult): void;
export declare function getResults(limit?: number, offset?: number): PersistedResult[];
/** One recorded payment inside the rolling spending window (#372). */
export interface SpendingRecord {
    amount: number;
    timestamp: number;
}
/** Append a payment to the persisted spending window. */
export declare function saveSpendingRecord(record: SpendingRecord): void;
/** Records at or after `sinceMs`, oldest first. */
export declare function loadSpendingRecords(sinceMs: number): SpendingRecord[];
/** Drop records that have fallen out of the window. */
export declare function pruneSpendingRecords(cutoffMs: number): void;
/** Drop the whole persisted window. */
export declare function clearSpendingRecords(): void;
/** Replace the underlying DB instance — used in tests to inject an in-memory DB. */
export declare function _setDb(db: Database.Database): void;
//# sourceMappingURL=persistence.d.ts.map