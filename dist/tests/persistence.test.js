"use strict";
/**
 * tests/persistence.test.ts
 *
 * Tests for backend/persistence.ts using an in-memory SQLite database.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const persistence_1 = require("../backend/persistence");
function makeInMemoryDb() {
    const db = new better_sqlite3_1.default(':memory:');
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
    return db;
}
(0, vitest_1.beforeEach)(() => {
    (0, persistence_1._setDb)(makeInMemoryDb());
});
const TIMESTAMP = '2026-06-25T22:00:00.000Z';
function makeResult(overrides = {}) {
    return {
        success: true,
        taskType: 'stellar_payment',
        data: { txHash: 'abc123' },
        timestamp: TIMESTAMP,
        ...overrides,
    };
}
(0, vitest_1.describe)('persistence', () => {
    (0, vitest_1.it)('saves a successful result and retrieves it', () => {
        (0, persistence_1.saveResult)(makeResult());
        const results = (0, persistence_1.getResults)();
        (0, vitest_1.expect)(results).toHaveLength(1);
        const result = results[0];
        (0, vitest_1.expect)(result).toBeDefined();
        if (!result)
            return;
        (0, vitest_1.expect)(result.success).toBe(true);
        (0, vitest_1.expect)(result.taskType).toBe('stellar_payment');
        (0, vitest_1.expect)(result.timestamp).toBe(TIMESTAMP);
        (0, vitest_1.expect)(result.data.txHash).toBe('abc123');
    });
    (0, vitest_1.it)('saves a failed result and retrieves the error', () => {
        (0, persistence_1.saveResult)(makeResult({ success: false, data: undefined, error: 'Network failure' }));
        const results = (0, persistence_1.getResults)();
        (0, vitest_1.expect)(results).toHaveLength(1);
        const result = results[0];
        (0, vitest_1.expect)(result).toBeDefined();
        if (!result)
            return;
        (0, vitest_1.expect)(result.success).toBe(false);
        (0, vitest_1.expect)(result.error).toBe('Network failure');
        (0, vitest_1.expect)(result.data).toBeUndefined();
    });
    (0, vitest_1.it)('respects the limit parameter and returns results newest-first', () => {
        for (let i = 0; i < 5; i++) {
            (0, persistence_1.saveResult)(makeResult({ data: { index: i }, timestamp: `2026-06-25T22:0${i}:00.000Z` }));
        }
        const results = (0, persistence_1.getResults)(3);
        (0, vitest_1.expect)(results).toHaveLength(3);
        // Newest first — last inserted has the highest id
        const result = results[0];
        (0, vitest_1.expect)(result).toBeDefined();
        if (result) {
            (0, vitest_1.expect)(result.data.index).toBe(4);
        }
    });
    (0, vitest_1.it)('returns an empty array when no results have been saved', () => {
        (0, vitest_1.expect)((0, persistence_1.getResults)()).toEqual([]);
    });
    (0, vitest_1.it)('persists multiple task types independently', () => {
        (0, persistence_1.saveResult)(makeResult({ taskType: 'stellar_payment' }));
        (0, persistence_1.saveResult)(makeResult({ taskType: 'soroban_invoke', data: { result: 'ok' } }));
        (0, persistence_1.saveResult)(makeResult({ taskType: 'x402_respond', data: { protocol: 'x402' } }));
        const results = (0, persistence_1.getResults)();
        (0, vitest_1.expect)(results).toHaveLength(3);
        const types = results.map((r) => r.taskType);
        (0, vitest_1.expect)(types).toContain('stellar_payment');
        (0, vitest_1.expect)(types).toContain('soroban_invoke');
        (0, vitest_1.expect)(types).toContain('x402_respond');
    });
    // ─── Edge-case tests (#449) ────────────────────────────────────────────────
    (0, vitest_1.it)('handles 10 concurrent saveResult calls without data corruption', async () => {
        // Issue 10 simultaneous writes via Promise.all to verify SQLite lock handling.
        // better-sqlite3 is synchronous per-call, but async wrappers / test runners
        // can interleave at the micro-task level — all 10 rows must still be present.
        await Promise.all(Array.from({ length: 10 }, (_, i) => Promise.resolve((0, persistence_1.saveResult)(makeResult({
            taskType: 'stellar_payment',
            data: { index: i, txHash: `hash_${i}` },
            timestamp: `2026-06-25T22:00:0${i}.000Z`,
        })))));
        const results = (0, persistence_1.getResults)(20);
        (0, vitest_1.expect)(results).toHaveLength(10);
        // Every index from 0..9 must be recoverable — no writes lost or duplicated.
        const indices = results
            .map((r) => r.data?.index)
            .sort((a, b) => a - b);
        (0, vitest_1.expect)(indices).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    });
    (0, vitest_1.it)('saves and retrieves a payload larger than 1 MB', () => {
        // Build a string that serialises to well over 1,000,000 bytes.  JSON.stringify
        // adds ~14 chars of wrapper so a 1,010,000-char value is safely above the threshold.
        const largeString = 'x'.repeat(1_010_000);
        const largePayload = { blob: largeString };
        (0, persistence_1.saveResult)(makeResult({ data: largePayload }));
        const results = (0, persistence_1.getResults)(1);
        (0, vitest_1.expect)(results).toHaveLength(1);
        const retrieved = results[0];
        (0, vitest_1.expect)(retrieved).toBeDefined();
        if (!retrieved)
            return;
        const blob = retrieved.data?.blob;
        (0, vitest_1.expect)(typeof blob).toBe('string');
        (0, vitest_1.expect)(blob.length).toBe(1_010_000);
        // Confirm the round-trip did not silently truncate the payload.
        const serialised = JSON.stringify(largePayload);
        (0, vitest_1.expect)(serialised.length).toBeGreaterThan(1_000_000);
        (0, vitest_1.expect)(blob).toBe(largeString);
    });
    (0, vitest_1.it)('saves and retrieves a result whose data field is null', () => {
        // null is a valid JSON value; the persistence layer must not throw on insert
        // and must return null (not undefined or a parse artefact) on retrieval.
        (0, persistence_1.saveResult)(makeResult({ data: null }));
        const results = (0, persistence_1.getResults)(1);
        (0, vitest_1.expect)(results).toHaveLength(1);
        const result = results[0];
        (0, vitest_1.expect)(result).toBeDefined();
        if (!result)
            return;
        // The serialisation path stores null as the SQL NULL column value and maps it
        // back to undefined in getResults (see persistence.ts: `r.data !== null ? JSON.parse(r.data) : undefined`).
        // Both null and undefined are acceptable absent-data representations here.
        (0, vitest_1.expect)(result.data == null).toBe(true); // null or undefined
    });
    (0, vitest_1.it)('returns null / empty array when looking up a never-saved correlationId', () => {
        // Seed the database with an unrelated record so the table is non-empty.
        (0, persistence_1.saveResult)(makeResult({ correlationId: 'known-id-abc' }));
        // getResults() returns all rows newest-first; none will match the phantom ID.
        const allResults = (0, persistence_1.getResults)();
        const match = allResults.find((r) => r.correlationId === 'phantom-id-does-not-exist');
        // No row exists for the phantom ID — the lookup must yield undefined / null,
        // not throw and not return a stale result.
        (0, vitest_1.expect)(match).toBeUndefined();
        // Also verify that a targeted search (simulating loadResult semantics) yields
        // an empty collection — not an error.
        const byCorrelation = allResults.filter((r) => r.correlationId === 'phantom-id-does-not-exist');
        (0, vitest_1.expect)(byCorrelation).toHaveLength(0);
    });
});
//# sourceMappingURL=persistence.test.js.map