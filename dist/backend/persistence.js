"use strict";
/**
 * backend/persistence.ts
 *
 * SQLite-backed audit log for every AgentResult produced by PayFiAgent.run().
 * The DB path is configured via DB_PATH (default: ./agent.db).
 * Pass ":memory:" for in-process testing via _setDb().
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.probeDb = probeDb;
exports.saveResult = saveResult;
exports.getResults = getResults;
exports.saveSpendingRecord = saveSpendingRecord;
exports.loadSpendingRecords = loadSpendingRecords;
exports.pruneSpendingRecords = pruneSpendingRecords;
exports.clearSpendingRecords = clearSpendingRecords;
exports._setDb = _setDb;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
let _db = null;
/**
 * Create every table this module owns, plus the idempotent migrations.
 *
 * Applied both to the lazily opened connection and to any DB injected through
 * `_setDb()`, so a test database has the same shape as a real one and the two
 * cannot drift apart.
 */
function applySchema(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_results (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp     TEXT    NOT NULL,
        taskType      TEXT    NOT NULL,
        success       INTEGER NOT NULL,
        data          TEXT,
        error         TEXT,
        correlationId TEXT
      )
    `);
    // Rolling spending window (#372). Kept here so the tracker survives a
    // restart instead of silently resetting its cumulative total to zero.
    db.exec(`
      CREATE TABLE IF NOT EXISTS spending_records (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        amount    REAL    NOT NULL,
        timestamp INTEGER NOT NULL
      )
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_spending_records_timestamp
        ON spending_records (timestamp)
    `);
    // Idempotent migration for databases created before correlationId existed.
    const cols = db.prepare(`PRAGMA table_info(agent_results)`).all();
    if (!cols.some((c) => c.name === 'correlationId')) {
        db.exec(`ALTER TABLE agent_results ADD COLUMN correlationId TEXT`);
    }
}
function getDb() {
    if (!_db) {
        // Lazy import of config so that tests can inject via _setDb() before any DB access
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { config } = require('./config');
        _db = new better_sqlite3_1.default(config.DB_PATH);
        applySchema(_db);
    }
    return _db;
}
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
function probeDb() {
    getDb().prepare('SELECT 1').get();
}
function saveResult(result) {
    getDb()
        .prepare(`INSERT INTO agent_results (timestamp, taskType, success, data, error, correlationId)
       VALUES (@timestamp, @taskType, @success, @data, @error, @correlationId)`)
        .run({
        timestamp: result.timestamp,
        taskType: result.taskType,
        success: result.success ? 1 : 0,
        data: result.data !== undefined ? JSON.stringify(result.data) : null,
        error: result.error ?? null,
        correlationId: result.correlationId ?? null,
    });
}
function getResults(limit = 100, offset = 0) {
    const rows = getDb()
        .prepare(`SELECT timestamp, taskType, success, data, error, correlationId
       FROM agent_results ORDER BY id DESC LIMIT ? OFFSET ?`)
        .all(limit, offset);
    return rows.map((r) => {
        const result = {
            timestamp: r.timestamp,
            taskType: r.taskType,
            success: r.success === 1,
            data: r.data !== null ? JSON.parse(r.data) : undefined,
        };
        if (r.error !== null)
            result.error = r.error;
        if (r.correlationId !== null)
            result.correlationId = r.correlationId;
        return result;
    });
}
/** Append a payment to the persisted spending window. */
function saveSpendingRecord(record) {
    getDb()
        .prepare(`INSERT INTO spending_records (amount, timestamp) VALUES (@amount, @timestamp)`)
        .run({ amount: record.amount, timestamp: record.timestamp });
}
/** Records at or after `sinceMs`, oldest first. */
function loadSpendingRecords(sinceMs) {
    return getDb()
        .prepare(`SELECT amount, timestamp FROM spending_records
       WHERE timestamp >= ? ORDER BY timestamp ASC`)
        .all(sinceMs);
}
/** Drop records that have fallen out of the window. */
function pruneSpendingRecords(cutoffMs) {
    getDb().prepare(`DELETE FROM spending_records WHERE timestamp < ?`).run(cutoffMs);
}
/** Drop the whole persisted window. */
function clearSpendingRecords() {
    getDb().prepare(`DELETE FROM spending_records`).run();
}
/** Replace the underlying DB instance — used in tests to inject an in-memory DB. */
function _setDb(db) {
    _db = db;
    applySchema(_db);
}
//# sourceMappingURL=persistence.js.map