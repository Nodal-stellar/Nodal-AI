/**
 * backend/persistence.ts
 *
 * Persistence module for Nodal AI (#957).
 * Database operations delegate to the storage layer and backend/db/sqlite.ts.
 * Note: No direct database connection exists here; all connection
 * management resides exclusively in backend/db/.
 */

import { createHash } from 'crypto';
import type Database from 'better-sqlite3';
import type { AgentResult } from './agent';
import * as sqlite from './db/sqlite';

// ─── Agent results ────────────────────────────────────────────────────────────

export type PersistedResult = AgentResult & { timestamp: string };

export function closeDb(): void {
  sqlite.closeDb();
}

export function probeDb(): void {
  sqlite.probeDb();
}

export function saveResult(result: PersistedResult): void {
  sqlite.saveResult(result);
}

/**
 * Drop agent_results rows older than `beforeIso` (#963). ISO-8601 timestamps
 * compare correctly as plain strings, so no numeric conversion is needed.
 */
export function pruneResults(beforeIso: string): number {
  const result = getDb().prepare(`DELETE FROM agent_results WHERE timestamp < ?`).run(beforeIso);
  return result.changes;
}

export function getResults(limit = 100, offset = 0): PersistedResult[] {
  return sqlite.getResults(limit, offset);
}

// ─── Cryptographic audit log (#243) ───────────────────────────────────────────

export const AUDIT_GENESIS_HASH = '0'.repeat(64);

export interface AuditEntry {
  ts: string;
  correlationId?: string;
  taskType: string;
  txHash?: string;
  envelopeHash?: string;
  destination?: string;
  asset?: string;
  amount?: string;
}

export interface AuditRow extends AuditEntry {
  id: number;
  prevHash: string;
  hash: string;
}

export interface AuditVerification {
  valid: boolean;
  tamperedAtId?: number;
  reason?: string;
  rowsChecked: number;
}

export function computeAuditHash(prevHash: string, entry: AuditEntry): string {
  const canonical = [
    prevHash,
    entry.ts,
    entry.correlationId ?? '',
    entry.taskType,
    entry.txHash ?? '',
    entry.envelopeHash ?? '',
    entry.destination ?? '',
    entry.asset ?? '',
    entry.amount ?? '',
  ].join('|');

  return createHash('sha256').update(canonical).digest('hex');
}

export function appendAuditEntry(entry: AuditEntry): AuditRow {
  return sqlite.appendAuditEntry(entry);
}

export function getAuditLog(): AuditRow[] {
  return sqlite.getAuditLog();
}

export function verifyAuditChain(): AuditVerification {
  const rows = getAuditLog();
  if (rows.length === 0) {
    return { valid: true, rowsChecked: 0 };
  }

  let expectedPrevHash = AUDIT_GENESIS_HASH;

  for (const row of rows) {
    if (row.prevHash !== expectedPrevHash) {
      return {
        valid: false,
        tamperedAtId: row.id,
        reason: `Broken chain: expected prevHash ${expectedPrevHash}, found ${row.prevHash}`,
        rowsChecked: rows.indexOf(row),
      };
    }

    const recomputedHash = computeAuditHash(row.prevHash, row);
    if (row.hash !== recomputedHash) {
      return {
        valid: false,
        tamperedAtId: row.id,
        reason: `Hash mismatch at id ${row.id}: stored ${row.hash}, computed ${recomputedHash}`,
        rowsChecked: rows.indexOf(row),
      };
    }

    expectedPrevHash = row.hash;
  }

  return { valid: true, rowsChecked: rows.length };
}

// ─── Cumulative spending window (#244) ────────────────────────────────────────

export interface SpendingRecord {
  amount: number;
  timestamp: number;
}

export function saveSpendingRecord(record: SpendingRecord): void {
  sqlite.saveSpendingRecord(record);
}

export function loadSpendingRecords(sinceMs: number): SpendingRecord[] {
  return sqlite.loadSpendingRecords(sinceMs);
}

export function pruneSpendingRecords(cutoffMs: number): void {
  sqlite.pruneSpendingRecords(cutoffMs);
}

export function clearSpendingRecords(): void {
  sqlite.clearSpendingRecords();
}

export interface SpendingReservation {
  id: number;
  total: number;
  totalStroops?: bigint;
}

export function reserveSpendingRecord(
  amount: number,
  limit: number,
  sinceMs: number,
  now: number = Date.now()
): SpendingReservation {
  return sqlite.reserveSpendingRecord(amount, limit, sinceMs, now);
}

export function deleteSpendingRecord(id: number): void {
  sqlite.deleteSpendingRecord(id);
}

export interface TrackedSpendingRecord {
  id: string;
  assetKey: string | null;
  stroops: bigint;
  timestamp: number;
}

export function saveTrackedSpendingRecord(
  record: TrackedSpendingRecord & { assetKey: string }
): void {
  sqlite.saveTrackedSpendingRecord(record);
}

export function getSpendingRecordsSince(sinceMs: number): TrackedSpendingRecord[] {
  return sqlite.getSpendingRecordsSince(sinceMs);
}

export function deleteTrackedSpendingRecord(reservationId: string): void {
  sqlite.deleteTrackedSpendingRecord(reservationId);
}

// ─── Key-value agent state ───────────────────────────────────────────────────

export function saveAgentState(key: string, value: string): void {
  sqlite.saveAgentState(key, value);
}

export function loadAgentState(key: string): string | undefined {
  return sqlite.loadAgentState(key);
}

/**
 * Every agent-state entry whose key starts with `prefix`. Used by the MPP
 * session sweeper to find channels without knowing their ids up front.
 */
export function listAgentStateByPrefix(prefix: string): Array<{ key: string; value: string }> {
  return getDb()
    .prepare(`SELECT key, value FROM agent_state WHERE substr(key, 1, ?) = ?`)
    .all(prefix.length, prefix) as Array<{ key: string; value: string }>;
}

// ─── Pending approvals (#736) ─────────────────────────────────────────────────

export type ApprovalStatus = 'pending_approval' | 'approved' | 'denied' | 'expired';

export interface PendingApproval {
  id: string;
  taskType: string;
  payload: unknown;
  amount: string;
  correlationId: string | null;
  status: ApprovalStatus;
  createdAt: number;
  expiresAt: number;
  decidedAt: number | null;
  /** Name of the approver who made the final decision (#954), or "admin" when
   * decided with the shared ADMIN_API_TOKEN. Null until decided. */
  decidedBy: string | null;
}

export interface ApprovalAuditRow {
  approvalId: string;
  decision: Exclude<ApprovalStatus, 'pending_approval'>;
  ts: number;
}

export function savePendingApproval(approval: Omit<PendingApproval, 'status' | 'decidedAt'>): void {
  sqlite.savePendingApproval(approval);
}

export function getPendingApproval(id: string): PendingApproval | undefined {
  return sqlite.getPendingApproval(id);
}

export function listPendingApprovals(): PendingApproval[] {
  return sqlite.listPendingApprovals();
}

export function decideApproval(
  id: string,
  decision: 'approved' | 'denied',
  now: number = Date.now(),
  decidedBy: string | null = null
): boolean {
  return sqlite.decideApproval(id, decision, now);
}

export function expirePendingApprovals(now: number = Date.now()): string[] {
  return sqlite.expirePendingApprovals(now);
}

export function getApprovalAuditLog(): ApprovalAuditRow[] {
  return sqlite.getApprovalAuditLog();
}

// ─── Payment idempotency keys ─────────────────────────────────────────────────

export function getIdempotencyResult(
  key: string,
  payload: unknown
): AgentResult | { conflict: true } | null {
  return sqlite.getIdempotencyResult(key, payload);
}

export function saveIdempotencyResult(
  key: string,
  taskType: string,
  payload: unknown,
  result: AgentResult
): void {
  sqlite.saveIdempotencyResult(key, taskType, payload, result);
}

export function pruneIdempotencyKeys(): number {
  return sqlite.pruneIdempotencyKeys();
}

// ─── X402 rate limiter records ───────────────────────────────────────────────

export function saveX402RateRecord(timestamp: number): void {
  sqlite.saveX402RateRecord(timestamp);
}

export function loadX402RateRecords(sinceMs: number): number[] {
  return sqlite.loadX402RateRecords(sinceMs);
}

export function pruneX402RateRecords(cutoffMs: number): void {
  sqlite.pruneX402RateRecords(cutoffMs);
}

export function clearX402RateRecords(): void {
  sqlite.clearX402RateRecords();
}

// ─── Test hook ────────────────────────────────────────────────────────────────

export function _setDb(db: Database.Database | null): void {
  sqlite._setDb(db);
}

// ─── Plan persistence (issue #908) ───────────────────────────────────────────

export type PlanStatus = 'pending' | 'confirmed' | 'cancelled' | 'expired' | 'executed';

export type PlanAuditEvent =
  | 'created'
  | 'confirmed'
  | 'cancelled'
  | 'expired'
  | 'executed'
  | 'execute_failed';

export interface PersistedPlan {
  id: string;
  /** SHA-256 hex of JSON.stringify(tasks). */
  hash: string;
  /** Raw JSON string of the tasks array. */
  tasks: string;
  /** Human-readable summary. */
  preview: string;
  status: PlanStatus;
  createdAt: string;
  expiresAt: string;
}

export interface PlanAuditRow {
  id: number;
  planId: string;
  event: PlanAuditEvent;
  ts: string;
  detail: string | null;
}

/** Compute the canonical hash for a tasks array. */
export function computePlanHash(tasks: unknown): string {
  return createHash('sha256').update(JSON.stringify(tasks)).digest('hex');
}

/** Persist a newly created plan in `pending` status and write a `created` audit row. */
export function savePlan(plan: Omit<PersistedPlan, 'status'>): PersistedPlan {
  const db = getDb();
  const persist = db.transaction((): PersistedPlan => {
    db.prepare(
      `INSERT INTO plans (id, hash, tasks, preview, status, createdAt, expiresAt)
       VALUES (@id, @hash, @tasks, @preview, 'pending', @createdAt, @expiresAt)`
    ).run(plan);
    db.prepare(
      `INSERT INTO plan_audit_log (planId, event, ts, detail) VALUES (?, 'created', ?, NULL)`
    ).run(plan.id, new Date().toISOString());
    return { ...plan, status: 'pending' };
  });
  return persist();
}

/** Load a single plan by id. Returns undefined when not found. */
export function getPlan(id: string): PersistedPlan | undefined {
  return getDb()
    .prepare(`SELECT id, hash, tasks, preview, status, createdAt, expiresAt FROM plans WHERE id = ?`)
    .get(id) as PersistedPlan | undefined;
}

/**
 * Atomically confirm a pending, unexpired plan.
 *
 * Uses a conditional UPDATE so two concurrent confirm calls can never both
 * succeed.  The plan moves to `confirmed`; callers should then immediately
 * execute it and call `markPlanExecuted` or `markPlanExecuteFailed`.
 *
 * @returns true when this call made the transition, false otherwise.
 */
export function confirmPlan(id: string, now: string = new Date().toISOString()): boolean {
  const db = getDb();
  const confirm = db.transaction((): boolean => {
    const info = db
      .prepare(
        `UPDATE plans SET status = 'confirmed'
         WHERE id = ? AND status = 'pending' AND expiresAt > ?`
      )
      .run(id, now);
    if (info.changes !== 1) return false;
    db.prepare(
      `INSERT INTO plan_audit_log (planId, event, ts, detail) VALUES (?, 'confirmed', ?, NULL)`
    ).run(id, now);
    return true;
  });
  return confirm();
}

/**
 * Atomically cancel a pending plan.
 *
 * @returns true when this call made the transition, false otherwise.
 */
export function cancelPlan(id: string, now: string = new Date().toISOString()): boolean {
  const db = getDb();
  const cancel = db.transaction((): boolean => {
    const info = db
      .prepare(`UPDATE plans SET status = 'cancelled' WHERE id = ? AND status = 'pending'`)
      .run(id);
    if (info.changes !== 1) return false;
    db.prepare(
      `INSERT INTO plan_audit_log (planId, event, ts, detail) VALUES (?, 'cancelled', ?, NULL)`
    ).run(id, now);
    return true;
  });
  return cancel();
}

/**
 * Mark a confirmed plan as executed.
 * @param detail - Optional JSON-serialisable detail (e.g. tx hashes).
 */
export function markPlanExecuted(id: string, detail?: unknown): void {
  const db = getDb();
  const ts = new Date().toISOString();
  db.transaction(() => {
    db.prepare(`UPDATE plans SET status = 'executed' WHERE id = ? AND status = 'confirmed'`).run(id);
    db.prepare(
      `INSERT INTO plan_audit_log (planId, event, ts, detail) VALUES (?, 'executed', ?, ?)`
    ).run(id, ts, detail !== undefined ? JSON.stringify(detail) : null);
  })();
}

/** Mark a confirmed plan as failed to execute. */
export function markPlanExecuteFailed(id: string, error: string): void {
  const db = getDb();
  const ts = new Date().toISOString();
  db.transaction(() => {
    // Revert to pending so the operator can retry.
    db.prepare(`UPDATE plans SET status = 'pending' WHERE id = ? AND status = 'confirmed'`).run(id);
    db.prepare(
      `INSERT INTO plan_audit_log (planId, event, ts, detail) VALUES (?, 'execute_failed', ?, ?)`
    ).run(id, ts, JSON.stringify({ error }));
  })();
}

/**
 * Mark every pending plan past its deadline as `expired`.
 * @returns ids that were expired in this call.
 */
export function expireOldPlans(now: string = new Date().toISOString()): string[] {
  const db = getDb();
  const expire = db.transaction((): string[] => {
    const rows = db
      .prepare(`SELECT id FROM plans WHERE status = 'pending' AND expiresAt <= ?`)
      .all(now) as Array<{ id: string }>;
    const update = db.prepare(`UPDATE plans SET status = 'expired' WHERE id = ?`);
    const audit = db.prepare(
      `INSERT INTO plan_audit_log (planId, event, ts, detail) VALUES (?, 'expired', ?, NULL)`
    );
    for (const { id } of rows) {
      update.run(id);
      audit.run(id, now);
    }
    return rows.map((r) => r.id);
  });
  return expire();
}

/** Full audit trail for a plan, oldest first. */
export function getPlanAuditLog(planId: string): PlanAuditRow[] {
  return getDb()
    .prepare(
      `SELECT id, planId, event, ts, detail FROM plan_audit_log WHERE planId = ? ORDER BY id ASC`
    )
    .all(planId) as PlanAuditRow[];
}
