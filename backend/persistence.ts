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
