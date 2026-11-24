/**
 * backend/db/sqlite.ts
 *
 * SQLite handle and queries for Nodal AI.
 * This is the ONLY place where better-sqlite3 is accessed directly.
 */

import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentResult } from '../agent';
import { config } from '../config';
import type {
  ApprovalAuditRow,
  AuditEntry,
  AuditRow,
  PendingApproval,
  PersistedResult,
  SpendingRecord,
  SpendingReservation,
  TrackedSpendingRecord,
} from '../persistence';
import { AUDIT_GENESIS_HASH, computeAuditHash } from '../persistence';
import type { Trigger, TriggerSource } from '../triggers';
import type { ReserveSpendingOptions } from './storage';

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    const dbPath = config.DB_PATH;
    if (dbPath !== ':memory:') {
      const dir = path.dirname(path.resolve(dbPath));
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    _db = new Database(dbPath);
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    _db.pragma('busy_timeout = 5000');
  }
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export function probeDb(): void {
  getDb().prepare('SELECT 1').get();
}

export function _setDb(db: Database.Database | null): void {
  _db = db;
}

// ─── Results ──────────────────────────────────────────────────────────────────

export function saveResult(result: PersistedResult): void {
  getDb()
    .prepare(
      `INSERT INTO agent_results (timestamp, taskType, success, data, error, correlationId, errorType, durationMs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      result.timestamp,
      result.taskType,
      result.success ? 1 : 0,
      result.data !== undefined ? JSON.stringify(result.data) : null,
      result.error ?? null,
      result.correlationId ?? null,
      result.errorType ?? null,
      result.durationMs ?? null
    );
}

export function getResults(limit = 100, offset = 0): PersistedResult[] {
  const rows = getDb()
    .prepare(
      `SELECT timestamp, taskType, success, data, error, correlationId, errorType, durationMs
       FROM agent_results
       ORDER BY timestamp DESC, id DESC
       LIMIT ? OFFSET ?`
    )
    .all(limit, offset) as Array<{
    timestamp: string;
    taskType: string;
    success: number;
    data: string | null;
    error: string | null;
    correlationId: string | null;
    errorType: string | null;
    durationMs: number | null;
  }>;

  return rows.map((r) => ({
    timestamp: r.timestamp,
    taskType: r.taskType,
    success: r.success === 1,
    data: r.data !== null ? (JSON.parse(r.data) as unknown) : undefined,
    error: r.error ?? undefined,
    correlationId: r.correlationId ?? undefined,
    errorType: r.errorType ?? undefined,
    durationMs: r.durationMs ?? undefined,
  }));
}

// ─── Audit ────────────────────────────────────────────────────────────────────

export function appendAuditEntry(entry: AuditEntry): AuditRow {
  const db = getDb();
  const append = db.transaction((): AuditRow => {
    const lastRow = db
      .prepare(`SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1`)
      .get() as { hash: string } | undefined;
    const prevHash = lastRow?.hash ?? AUDIT_GENESIS_HASH;
    const hash = computeAuditHash(prevHash, entry);

    const info = db
      .prepare(
        `INSERT INTO audit_log
           (ts, correlationId, taskType, txHash, envelopeHash, destination, asset, amount, prevHash, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        entry.ts,
        entry.correlationId ?? null,
        entry.taskType,
        entry.txHash ?? null,
        entry.envelopeHash ?? null,
        entry.destination ?? null,
        entry.asset ?? null,
        entry.amount ?? null,
        prevHash,
        hash
      );

    return {
      id: Number(info.lastInsertRowid),
      prevHash,
      hash,
      ...entry,
    };
  });

  return append.immediate();
}

export function getAuditLog(): AuditRow[] {
  const rows = getDb()
    .prepare(
      `SELECT id, ts, correlationId, taskType, txHash, envelopeHash, destination, asset, amount, prevHash, hash
       FROM audit_log ORDER BY id ASC`
    )
    .all() as Array<{
    id: number;
    ts: string;
    correlationId: string | null;
    taskType: string;
    txHash: string | null;
    envelopeHash: string | null;
    destination: string | null;
    asset: string | null;
    amount: string | null;
    prevHash: string;
    hash: string;
  }>;

  return rows.map((r) => ({
    id: r.id,
    ts: r.ts,
    correlationId: r.correlationId ?? undefined,
    taskType: r.taskType,
    txHash: r.txHash ?? undefined,
    envelopeHash: r.envelopeHash ?? undefined,
    destination: r.destination ?? undefined,
    asset: r.asset ?? undefined,
    amount: r.amount ?? undefined,
    prevHash: r.prevHash,
    hash: r.hash,
  }));
}

// ─── Agent State ──────────────────────────────────────────────────────────────

export function saveAgentState(key: string, value: string): void {
  getDb()
    .prepare(`INSERT OR REPLACE INTO agent_state (key, value) VALUES (?, ?)`)
    .run(key, value);
}

export function loadAgentState(key: string): string | undefined {
  const row = getDb().prepare(`SELECT value FROM agent_state WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

// ─── Spending ─────────────────────────────────────────────────────────────────

export function saveSpendingRecord(record: SpendingRecord): void {
  getDb()
    .prepare(`INSERT INTO spending_records (amount, timestamp) VALUES (?, ?)`)
    .run(record.amount, record.timestamp);
}

export function loadSpendingRecords(sinceMs: number): SpendingRecord[] {
  const rows = getDb()
    .prepare(
      `SELECT amount, timestamp FROM spending_records
       WHERE timestamp >= ? ORDER BY timestamp ASC`
    )
    .all(sinceMs) as Array<{ amount: number; timestamp: number }>;
  return rows.map((r) => ({ amount: r.amount, timestamp: r.timestamp }));
}

export function pruneSpendingRecords(cutoffMs: number): void {
  getDb().prepare(`DELETE FROM spending_records WHERE timestamp < ?`).run(cutoffMs);
}

export function clearSpendingRecords(): void {
  getDb().prepare(`DELETE FROM spending_records`).run();
}

export function deleteSpendingRecord(id: number): void {
  getDb().prepare(`DELETE FROM spending_records WHERE id = ?`).run(id);
}

export function saveTrackedSpendingRecord(
  record: TrackedSpendingRecord & { assetKey: string }
): void {
  getDb()
    .prepare(
      `INSERT INTO spending_records (amount, timestamp, reservation_id, asset_key, stroops)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      Number(record.stroops) / 10_000_000,
      record.timestamp,
      record.id,
      record.assetKey,
      record.stroops.toString()
    );
}

export function getSpendingRecordsSince(sinceMs: number): TrackedSpendingRecord[] {
  const rows = getDb()
    .prepare(
      `SELECT id, amount, timestamp, reservation_id, asset_key, stroops
       FROM spending_records
       WHERE timestamp >= ?
       ORDER BY timestamp ASC`
    )
    .all(sinceMs) as Array<{
    id: number;
    amount: number;
    timestamp: number;
    reservation_id: string | null;
    asset_key: string | null;
    stroops: string | null;
  }>;

  return rows.map((r) => ({
    id: r.reservation_id ?? `legacy-${r.id}`,
    assetKey: r.asset_key,
    stroops: r.stroops !== null ? BigInt(r.stroops) : BigInt(Math.round(r.amount * 10_000_000)),
    timestamp: r.timestamp,
  }));
}

export function deleteTrackedSpendingRecord(reservationId: string): void {
  getDb().prepare(`DELETE FROM spending_records WHERE reservation_id = ?`).run(reservationId);
}

export function reserveSpendingRecord(
  optsOrAmount: ReserveSpendingOptions | number,
  limit?: number,
  sinceMs?: number,
  now?: number
): SpendingReservation {
  const opts: ReserveSpendingOptions =
    typeof optsOrAmount === 'object'
      ? optsOrAmount
      : {
          assetKey: 'USDC',
          amountStroops: BigInt(Math.round(optsOrAmount * 10_000_000)),
          limitStroops: BigInt(Math.round((limit ?? 0) * 10_000_000)),
          sinceMs: sinceMs ?? 0,
          now: now ?? Date.now(),
        };

  const db = getDb();
  const reserve = db.transaction((): SpendingReservation => {
    const rows = db
      .prepare(`SELECT stroops, amount, asset_key FROM spending_records WHERE timestamp >= ?`)
      .all(opts.sinceMs) as Array<{
      stroops: string | null;
      amount: number;
      asset_key: string | null;
    }>;

    let currentTotalStroops = 0n;
    for (const row of rows) {
      const rowAsset = row.asset_key ?? 'USDC';
      if (rowAsset === opts.assetKey) {
        if (row.stroops != null) {
          currentTotalStroops += BigInt(row.stroops);
        } else {
          currentTotalStroops += BigInt(Math.round(row.amount * 10_000_000));
        }
      }
    }

    const totalStroops = currentTotalStroops + opts.amountStroops;
    if (totalStroops > opts.limitStroops) {
      throw new Error(
        `Cumulative spending ${Number(totalStroops) / 10_000_000} exceeds limit ${
          Number(opts.limitStroops) / 10_000_000
        }`
      );
    }

    const resId = randomUUID();
    const timestamp = opts.now ?? Date.now();
    const info = db
      .prepare(
        `INSERT INTO spending_records (amount, timestamp, reservation_id, asset_key, stroops)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        Number(opts.amountStroops) / 10_000_000,
        timestamp,
        resId,
        opts.assetKey,
        opts.amountStroops.toString()
      );

    return {
      id: Number(info.lastInsertRowid),
      total: Number(totalStroops) / 10_000_000,
      totalStroops,
    };
  });

  return reserve.immediate();
}

// ─── Approvals ────────────────────────────────────────────────────────────────

type ApprovalRow = Omit<PendingApproval, 'payload'> & { payload: string };

function toPendingApproval(row: ApprovalRow): PendingApproval {
  return { ...row, payload: JSON.parse(row.payload) };
}

export function savePendingApproval(
  approval: Omit<PendingApproval, 'status' | 'decidedAt'>
): void {
  getDb()
    .prepare(
      `INSERT INTO pending_approvals
         (id, taskType, payload, amount, correlationId, status, createdAt, expiresAt, decidedAt)
       VALUES
         (@id, @taskType, @payload, @amount, @correlationId, 'pending_approval', @createdAt,
          @expiresAt, NULL)`
    )
    .run({ ...approval, payload: JSON.stringify(approval.payload ?? null) });
}

export function getPendingApproval(id: string): PendingApproval | undefined {
  const row = getDb().prepare(`SELECT * FROM pending_approvals WHERE id = ?`).get(id) as
    | ApprovalRow
    | undefined;
  return row ? toPendingApproval(row) : undefined;
}

export function listPendingApprovals(): PendingApproval[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM pending_approvals WHERE status = 'pending_approval' ORDER BY createdAt ASC`
    )
    .all() as ApprovalRow[];
  return rows.map(toPendingApproval);
}

export function decideApproval(
  id: string,
  decision: 'approved' | 'denied',
  now: number = Date.now()
): boolean {
  const db = getDb();
  const decide = db.transaction((): boolean => {
    const info = db
      .prepare(
        `UPDATE pending_approvals SET status = ?, decidedAt = ?
         WHERE id = ? AND status = 'pending_approval' AND expiresAt > ?`
      )
      .run(decision, now, id, now);
    if (info.changes !== 1) return false;
    db.prepare(`INSERT INTO approval_audit_log (approvalId, decision, ts) VALUES (?, ?, ?)`).run(
      id,
      decision,
      now
    );
    return true;
  });
  return decide();
}

export function expirePendingApprovals(now: number = Date.now()): string[] {
  const db = getDb();
  const expire = db.transaction((): string[] => {
    const rows = db
      .prepare(
        `SELECT id FROM pending_approvals WHERE status = 'pending_approval' AND expiresAt <= ?`
      )
      .all(now) as Array<{ id: string }>;
    const update = db.prepare(
      `UPDATE pending_approvals SET status = 'expired', decidedAt = ? WHERE id = ?`
    );
    const audit = db.prepare(
      `INSERT INTO approval_audit_log (approvalId, decision, ts) VALUES (?, 'expired', ?)`
    );
    for (const { id } of rows) {
      update.run(now, id);
      audit.run(id, now);
    }
    return rows.map((r) => r.id);
  });
  return expire();
}

export function getApprovalAuditLog(): ApprovalAuditRow[] {
  return getDb()
    .prepare(`SELECT approvalId, decision, ts FROM approval_audit_log ORDER BY id ASC`)
    .all() as ApprovalAuditRow[];
}

// ─── Idempotency ──────────────────────────────────────────────────────────────

function computePayloadHash(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

export function getIdempotencyResult(
  key: string,
  payload: unknown
): AgentResult | { conflict: true } | null {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT payloadHash, taskType, status, result, expiresAt
       FROM idempotency_keys WHERE key = ?`
    )
    .get(key) as
    | {
        payloadHash: string;
        taskType: string;
        status: string;
        result: string;
        expiresAt: number;
      }
    | undefined;

  if (!row) return null;

  if (Date.now() > row.expiresAt) {
    db.prepare(`DELETE FROM idempotency_keys WHERE key = ?`).run(key);
    return null;
  }

  const payloadHash = computePayloadHash(payload);
  if (row.payloadHash !== payloadHash) {
    return { conflict: true };
  }

  return JSON.parse(row.result) as AgentResult;
}

export function saveIdempotencyResult(
  key: string,
  taskType: string,
  payload: unknown,
  result: AgentResult
): void {
  const db = getDb();
  const now = Date.now();
  const expiresAt = now + 24 * 60 * 60 * 1000;

  db.prepare(
    `INSERT OR REPLACE INTO idempotency_keys
       (key, payloadHash, taskType, status, result, createdAt, expiresAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    key,
    computePayloadHash(payload),
    taskType,
    result.success ? 'success' : 'failure',
    JSON.stringify(result),
    now,
    expiresAt
  );
}

export function pruneIdempotencyKeys(now: number = Date.now()): number {
  const info = getDb()
    .prepare(`DELETE FROM idempotency_keys WHERE expiresAt < ?`)
    .run(now);
  return info.changes;
}

// ─── Triggers ─────────────────────────────────────────────────────────────────

export function saveTrigger(trigger: Trigger): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO triggers (id, source, filter, task, enabled, created_at, last_fired_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      trigger.id,
      trigger.source,
      JSON.stringify(trigger.filter),
      JSON.stringify(trigger.task),
      trigger.enabled ? 1 : 0,
      trigger.createdAt,
      trigger.lastFiredAt ?? null
    );
}

export function loadTriggers(): Trigger[] {
  try {
    const rows = getDb()
      .prepare('SELECT * FROM triggers')
      .all() as Array<{
      id: string;
      source: string;
      filter: string;
      task: string;
      enabled: number;
      created_at: string;
      last_fired_at: string | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      source: row.source as TriggerSource,
      filter: JSON.parse(row.filter),
      task: JSON.parse(row.task),
      enabled: row.enabled === 1,
      createdAt: row.created_at,
      ...(row.last_fired_at !== null ? { lastFiredAt: row.last_fired_at } : {}),
    }));
  } catch {
    return [];
  }
}

export function recordTriggerFired(triggerId: string, eventId: string): boolean {
  const key = `trigger:${triggerId}:event:${eventId}`;
  const info = getDb()
    .prepare('INSERT OR IGNORE INTO trigger_events (key, fired_at) VALUES (?, ?)')
    .run(key, new Date().toISOString());
  return info.changes === 1;
}

export function deleteTrigger(id: string): void {
  getDb().prepare('DELETE FROM triggers WHERE id = ?').run(id);
}

// ─── X402 Rate Records ────────────────────────────────────────────────────────

export function saveX402RateRecord(timestamp: number): void {
  getDb().prepare(`INSERT INTO x402_rate_records (timestamp) VALUES (?)`).run(timestamp);
}

export function loadX402RateRecords(sinceMs: number): number[] {
  const rows = getDb()
    .prepare(
      `SELECT timestamp FROM x402_rate_records
       WHERE timestamp >= ? ORDER BY timestamp ASC`
    )
    .all(sinceMs) as Array<{ timestamp: number }>;
  return rows.map((r) => r.timestamp);
}

export function pruneX402RateRecords(cutoffMs: number): void {
  getDb().prepare(`DELETE FROM x402_rate_records WHERE timestamp < ?`).run(cutoffMs);
}

export function clearX402RateRecords(): void {
  getDb().prepare(`DELETE FROM x402_rate_records`).run();
}
