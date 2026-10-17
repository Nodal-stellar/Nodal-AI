/**
 * backend/persistence.ts
 *
 * SQLite-backed audit log for every AgentResult produced by PayFiAgent.run().
 * The DB path is configured via DB_PATH (default: ./agent.db).
 * Pass ":memory:" for in-process testing via _setDb().
 */

import { createHash } from 'crypto';
import Database from 'better-sqlite3';
import type { AgentResult } from './agent';

export type PersistedResult = AgentResult & { timestamp: string };

let _db: Database.Database | null = null;

/**
 * Create every table this module owns, plus the idempotent migrations.
 *
 * Applied both to the lazily opened connection and to any DB injected through
 * `_setDb()`, so a test database has the same shape as a real one and the two
 * cannot drift apart.
 */
function applySchema(db: Database.Database): void {
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
  // Operator-controlled agent state (e.g. the kill switch), kept across restarts.
  db.exec(`
      CREATE TABLE IF NOT EXISTS agent_state (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
  // Durable webhook outbox (#803). Each pending delivery is a row; the worker
  // picks up PENDING rows, attempts delivery with backoff+jitter, and moves
  // rows to DEAD after MAX_WEBHOOK_ATTEMPTS failures. A restart picks up where
  // the previous process left off — nothing is lost in memory.
  db.exec(`
      CREATE TABLE IF NOT EXISTS webhook_outbox (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        deliveryId    TEXT    NOT NULL UNIQUE,
        payload       TEXT    NOT NULL,
        status        TEXT    NOT NULL DEFAULT 'PENDING',
        attempts      INTEGER NOT NULL DEFAULT 0,
        nextRetryAt   INTEGER NOT NULL DEFAULT 0,
        lastError     TEXT,
        createdAt     INTEGER NOT NULL,
        updatedAt     INTEGER NOT NULL
      )
    `);
  db.exec(`
      CREATE INDEX IF NOT EXISTS idx_webhook_outbox_status_next
        ON webhook_outbox (status, nextRetryAt)
    `);
  // Idempotent migration for databases created before correlationId existed.
  const cols = db.prepare(`PRAGMA table_info(agent_results)`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'correlationId')) {
    db.exec(`ALTER TABLE agent_results ADD COLUMN correlationId TEXT`);
  }
}

function getDb(): Database.Database {
  if (!_db) {
    // Lazy import of config so that tests can inject via _setDb() before any DB access
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { config } = require('./config') as typeof import('./config');
    _db = new Database(config.DB_PATH);
    applySchema(_db);
  }
  return _db;
}

/**
 * Close the live connection and drop the cached handle (#644).
 *
 * `getDb()` owns the only `better-sqlite3` handle, so releasing it belongs here
 * rather than in DatabaseManager. After this call the next access re-opens a
 * fresh connection via `getDb()`. Safe to call when no connection is open.
 */
export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
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
export function probeDb(): void {
  getDb().prepare('SELECT 1').get();
}

export function saveResult(result: PersistedResult): void {
  getDb()
    .prepare(
      `INSERT INTO agent_results (timestamp, taskType, success, data, error, correlationId)
       VALUES (@timestamp, @taskType, @success, @data, @error, @correlationId)`
    )
    .run({
      timestamp: result.timestamp,
      taskType: result.taskType,
      success: result.success ? 1 : 0,
      data: result.data !== undefined ? JSON.stringify(result.data) : null,
      error: result.error ?? null,
      correlationId: result.correlationId ?? null,
    });
}

/** Filter parameters accepted by {@link getResults}. */
export interface ResultsFilter {
  taskType?: string;
  /** `true` = success only, `false` = failures only, omit = both. */
  success?: boolean;
  correlationId?: string;
  /** ISO-8601 lower bound (inclusive). */
  from?: string;
  /** ISO-8601 upper bound (inclusive). */
  to?: string;
}

export function getResults(limit?: number, offset?: number, filter?: ResultsFilter): PersistedResult[];
export function getResults(limit = 100, offset = 0, filter: ResultsFilter = {}): PersistedResult[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter.taskType !== undefined) {
    conditions.push('taskType = ?');
    params.push(filter.taskType);
  }
  if (filter.success !== undefined) {
    conditions.push('success = ?');
    params.push(filter.success ? 1 : 0);
  }
  if (filter.correlationId !== undefined) {
    conditions.push('correlationId = ?');
    params.push(filter.correlationId);
  }
  if (filter.from !== undefined) {
    conditions.push('timestamp >= ?');
    params.push(filter.from);
  }
  if (filter.to !== undefined) {
    conditions.push('timestamp <= ?');
    params.push(filter.to);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  params.push(limit, offset);

  const rows = getDb()
    .prepare(
      `SELECT timestamp, taskType, success, data, error, correlationId
       FROM agent_results ${where} ORDER BY id DESC LIMIT ? OFFSET ?`
    )
    .all(...params) as Array<{
    timestamp: string;
    taskType: string;
    success: number;
    data: string | null;
    error: string | null;
    correlationId: string | null;
  }>;

  return rows.map((r) => {
    const result: PersistedResult = {
      timestamp: r.timestamp,
      taskType: r.taskType as AgentResult['taskType'],
      success: r.success === 1,
      data: r.data !== null ? JSON.parse(r.data) : undefined,
    };
    if (r.error !== null) result.error = r.error;
    if (r.correlationId !== null) result.correlationId = r.correlationId;
    return result;
  });
}

// ─── Webhook outbox (#803) ─────────────────────────────────────────────────────

export type WebhookOutboxStatus = 'PENDING' | 'DELIVERED' | 'DEAD';

export interface WebhookOutboxRow {
  id: number;
  deliveryId: string;
  payload: string;
  status: WebhookOutboxStatus;
  attempts: number;
  nextRetryAt: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * Insert a webhook payload into the outbox so it survives a restart.
 * Called in the same logical flow as saveResult — the outbox entry exists
 * before the in-process delivery is attempted.
 */
export function enqueueWebhook(deliveryId: string, payload: string): WebhookOutboxRow {
  const now = Date.now();
  const info = getDb()
    .prepare(
      `INSERT INTO webhook_outbox (deliveryId, payload, status, attempts, nextRetryAt, createdAt, updatedAt)
       VALUES (@deliveryId, @payload, 'PENDING', 0, @now, @now, @now)`
    )
    .run({ deliveryId, payload, now });
  return {
    id: Number(info.lastInsertRowid),
    deliveryId,
    payload,
    status: 'PENDING',
    attempts: 0,
    nextRetryAt: now,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Return up to `batchSize` PENDING rows whose nextRetryAt is at or before now,
 * ordered oldest-first so the earliest failures are retried first.
 */
export function pendingWebhooks(nowMs = Date.now(), batchSize = 50): WebhookOutboxRow[] {
  return getDb()
    .prepare(
      `SELECT id, deliveryId, payload, status, attempts, nextRetryAt, lastError, createdAt, updatedAt
       FROM webhook_outbox
       WHERE status = 'PENDING' AND nextRetryAt <= ?
       ORDER BY id ASC LIMIT ?`
    )
    .all(nowMs, batchSize) as WebhookOutboxRow[];
}

/** Mark a row as successfully delivered. */
export function markWebhookDelivered(id: number): void {
  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE webhook_outbox SET status = 'DELIVERED', updatedAt = @now WHERE id = @id`
    )
    .run({ id, now });
}

/** Record a failed attempt and schedule the next retry (or dead-letter). */
export function markWebhookFailed(
  id: number,
  lastError: string,
  nextRetryAt: number,
  dead: boolean
): void {
  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE webhook_outbox
       SET attempts = attempts + 1,
           lastError = @lastError,
           nextRetryAt = @nextRetryAt,
           status = @status,
           updatedAt = @now
       WHERE id = @id`
    )
    .run({ id, lastError, nextRetryAt, status: dead ? 'DEAD' : 'PENDING', now });
}

/** Return a single outbox row by id (used by the replay endpoint). */
export function getWebhookById(id: number): WebhookOutboxRow | undefined {
  return getDb()
    .prepare(
      `SELECT id, deliveryId, payload, status, attempts, nextRetryAt, lastError, createdAt, updatedAt
       FROM webhook_outbox WHERE id = ?`
    )
    .get(id) as WebhookOutboxRow | undefined;
}

/** Reset a dead-lettered row back to PENDING so the worker retries it. */
export function requeueWebhook(id: number): void {
  const now = Date.now();
  getDb()
    .prepare(
      `UPDATE webhook_outbox
       SET status = 'PENDING', nextRetryAt = @now, updatedAt = @now
       WHERE id = @id`
    )
    .run({ id, now });
}

/** Return all DEAD rows for the dead-letter API. */
export function deadWebhooks(): WebhookOutboxRow[] {
  return getDb()
    .prepare(
      `SELECT id, deliveryId, payload, status, attempts, nextRetryAt, lastError, createdAt, updatedAt
       FROM webhook_outbox WHERE status = 'DEAD' ORDER BY id DESC`
    )
    .all() as WebhookOutboxRow[];
}

// ─── Audit log (#744) ─────────────────────────────────────────────────────────

/** `prevHash` of the first row in the chain. */
export const AUDIT_GENESIS_HASH = '0'.repeat(64);

/** Who/what/why of one signed transaction. */
export interface AuditEntry {
  ts: string;
  correlationId: string | null;
  taskType: string;
  txHash: string;
  envelopeHash: string | null;
  destination: string | null;
  asset: string | null;
  amount: string | null;
}

export interface AuditRow extends AuditEntry {
  id: number;
  prevHash: string;
  hash: string;
}

export interface AuditVerification {
  ok: boolean;
  /** Number of rows checked. */
  checked: number;
  /** id of the first row that fails verification. */
  brokenAt?: number;
  reason?: string;
}

/**
 * `sha256(prevHash || row)`. The row is serialised as a JSON array in a fixed
 * column order so the encoding is unambiguous and independent of key order.
 */
export function computeAuditHash(prevHash: string, entry: AuditEntry): string {
  const row = JSON.stringify([
    entry.ts,
    entry.correlationId,
    entry.taskType,
    entry.txHash,
    entry.envelopeHash,
    entry.destination,
    entry.asset,
    entry.amount,
  ]);
  return createHash('sha256').update(prevHash).update(row).digest('hex');
}

/**
 * Append one signed transaction to the audit log, chained to the previous row.
 * Reading the last hash and inserting run in one transaction so two appends
 * can never chain off the same predecessor.
 */
export function appendAuditEntry(entry: AuditEntry): AuditRow {
  const db = getDb();
  const append = db.transaction((e: AuditEntry): AuditRow => {
    const last = db.prepare(`SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1`).get() as
      | { hash: string }
      | undefined;
    const prevHash = last?.hash ?? AUDIT_GENESIS_HASH;
    const hash = computeAuditHash(prevHash, e);
    const info = db
      .prepare(
        `INSERT INTO audit_log
           (ts, correlationId, taskType, txHash, envelopeHash, destination, asset, amount,
            prevHash, hash)
         VALUES
           (@ts, @correlationId, @taskType, @txHash, @envelopeHash, @destination, @asset,
            @amount, @prevHash, @hash)`
      )
      .run({ ...e, prevHash, hash });
    return { ...e, id: Number(info.lastInsertRowid), prevHash, hash };
  });
  return append(entry);
}

/** Every audit row, oldest first. */
export function getAuditLog(db: Database.Database = getDb()): AuditRow[] {
  return db
    .prepare(
      `SELECT id, ts, correlationId, taskType, txHash, envelopeHash, destination, asset, amount,
              prevHash, hash
       FROM audit_log ORDER BY id ASC`
    )
    .all() as AuditRow[];
}

/**
 * Walk the chain from the genesis hash and recompute every row's hash.
 * Detects a modified row (its hash no longer matches its contents) and a
 * removed or reordered row (the next row's prevHash no longer links up).
 */
export function verifyAuditChain(db: Database.Database = getDb()): AuditVerification {
  const rows = getAuditLog(db);
  let expectedPrev = AUDIT_GENESIS_HASH;
  for (const row of rows) {
    if (row.prevHash !== expectedPrev) {
      return {
        ok: false,
        checked: rows.length,
        brokenAt: row.id,
        reason: 'prevHash does not match the previous row — a row was removed or reordered',
      };
    }
    if (computeAuditHash(row.prevHash, row) !== row.hash) {
      return {
        ok: false,
        checked: rows.length,
        brokenAt: row.id,
        reason: 'hash does not match row contents — the row was modified',
      };
    }
    expectedPrev = row.hash;
  }
  return { ok: true, checked: rows.length };
}

/** One recorded payment inside the rolling spending window (#372). */
export interface SpendingRecord {
  amount: number;
  timestamp: number;
}

/** Append a payment to the persisted spending window. */
export function saveSpendingRecord(record: SpendingRecord): void {
  getDb()
    .prepare(`INSERT INTO spending_records (amount, timestamp) VALUES (@amount, @timestamp)`)
    .run({ amount: record.amount, timestamp: record.timestamp });
}

/** Records at or after `sinceMs`, oldest first. */
export function loadSpendingRecords(sinceMs: number): SpendingRecord[] {
  return getDb()
    .prepare(
      `SELECT amount, timestamp FROM spending_records
       WHERE timestamp >= ? ORDER BY timestamp ASC`
    )
    .all(sinceMs) as SpendingRecord[];
}

/** Drop records that have fallen out of the window. */
export function pruneSpendingRecords(cutoffMs: number): void {
  getDb().prepare(`DELETE FROM spending_records WHERE timestamp < ?`).run(cutoffMs);
}

/** Drop the whole persisted window. */
export function clearSpendingRecords(): void {
  getDb().prepare(`DELETE FROM spending_records`).run();
}

/** Persist a single agent-state value, replacing any previous one. */
export function saveAgentState(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO agent_state (key, value) VALUES (@key, @value)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run({ key, value });
}

/** Read a persisted agent-state value, or undefined when it was never set. */
export function loadAgentState(key: string): string | undefined {
  const row = getDb().prepare(`SELECT value FROM agent_state WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

/** Replace the underlying DB instance — used in tests to inject an in-memory DB. */
export function _setDb(db: Database.Database | null): void {
  _db = db;
  if (_db) {
    applySchema(_db);
  }
}
