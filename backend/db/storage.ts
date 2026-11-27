/**
 * backend/db/storage.ts
 *
 * Storage — the backend-agnostic contract for everything the agent persists
 * (#822, #957, #959): agent results, the audit log, agent state, the spending window,
 * approvals, idempotency, triggers, and x402 nonces.
 *
 * Two implementations:
 *   • SqliteStorage   — the default; a local file, single instance only.
 *   • PostgresStorage — a shared database for multi-instance deployments
 *     (backend/db/postgres.ts). Select it with STORAGE_BACKEND=postgres and
 *     DATABASE_URL.
 *
 * Every method is async so both backends share one call shape, even though
 * better-sqlite3 itself is synchronous.
 */

import type { AgentResult } from '../agent';
import { config } from '../config';
import type { INonceStore } from '../nonce_store';
import { SqliteNonceStore } from '../nonce_store';
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
import type { Trigger } from '../triggers';
import { migrateSqlite } from './migrate';
import * as sqlite from './sqlite';

export type StorageBackend = 'sqlite' | 'postgres';

/** A persisted MPP session: its channel id and JSON-serialized channel state. */
export interface MppSessionRecord {
  channelId: string;
  state: string;
}

export interface Storage {
  readonly backend: StorageBackend;

  /** Apply pending schema migrations; returns how many were applied. */
  migrate(): Promise<number>;
  /** Run a trivial query; throws when the store is unreachable. */
  probe(): Promise<void>;
  /** Release connections. */
  close(): Promise<void>;

  saveResult(result: PersistedResult): Promise<void>;
  getResults(limit?: number, offset?: number): Promise<PersistedResult[]>;
  /** Drop agent_results rows older than `beforeIso` (#963). */
  pruneResults(beforeIso: string): Promise<void>;

  appendAuditEntry(entry: AuditEntry): Promise<AuditRow>;
  getAuditLog(): Promise<AuditRow[]>;

  saveAgentState(key: string, value: string): Promise<void>;
  loadAgentState(key: string): Promise<string | undefined>;

  saveSpendingRecord(record: SpendingRecord): Promise<void>;
  loadSpendingRecords(sinceMs: number): Promise<SpendingRecord[]>;
  pruneSpendingRecords(cutoffMs: number): Promise<void>;
  clearSpendingRecords(): Promise<void>;

  /**
   * Per-asset atomic reservation (#959) or legacy float-amount reservation.
   * Atomically checks window total and records the reservation against it.
   */
  reserveSpending(options: ReserveSpendingOptions): Promise<SpendingReservation>;
  reserveSpending(
    amount: number,
    limit: number,
    sinceMs: number,
    now?: number
  ): Promise<SpendingReservation>;
  reserveSpending(
    optsOrAmount: ReserveSpendingOptions | number,
    limit?: number,
    sinceMs?: number,
    now?: number
  ): Promise<SpendingReservation>;

  /** Release a reservation, e.g. after a failed submission. */
  releaseSpending(id: number): Promise<void>;

  /** Tracked spending records per-asset (#733, #957). */
  saveTrackedSpendingRecord(record: TrackedSpendingRecord & { assetKey: string }): Promise<void>;
  getSpendingRecordsSince(sinceMs: number): Promise<TrackedSpendingRecord[]>;
  deleteTrackedSpendingRecord(reservationId: string): Promise<void>;

  /** Pending approvals (#736, #957). */
  savePendingApproval(approval: Omit<PendingApproval, 'status' | 'decidedAt'>): Promise<void>;
  getPendingApproval(id: string): Promise<PendingApproval | undefined>;
  listPendingApprovals(): Promise<PendingApproval[]>;
  decideApproval(id: string, decision: 'approved' | 'denied', now?: number): Promise<boolean>;
  expirePendingApprovals(now?: number): Promise<string[]>;
  getApprovalAuditLog(): Promise<ApprovalAuditRow[]>;

  /** Idempotency keys (#957). */
  getIdempotencyResult(key: string, payload: unknown): Promise<AgentResult | { conflict: true } | null>;
  saveIdempotencyResult(
    key: string,
    taskType: string,
    payload: unknown,
    result: AgentResult
  ): Promise<void>;
  pruneIdempotencyKeys(now?: number): Promise<number>;

  /** Triggers (#957). */
  saveTrigger(trigger: Trigger): Promise<void>;
  loadTriggers(): Promise<Trigger[]>;
  recordTriggerFired(triggerId: string, eventId: string): Promise<boolean>;
  deleteTrigger(id: string): Promise<void>;

  /** Nonce store sharing this storage's database. */
  nonceStore(): INonceStore;

  /** MPP Session storage: save, load, and update channel states. */
  saveMppSession(channelId: string, state: string): Promise<void>;
  loadMppSession(channelId: string): Promise<string | undefined>;
  /** Every persisted MPP session, for the expiry sweeper. */
  listMppSessions(): Promise<MppSessionRecord[]>;

  /** X402 rate limiter: save, load, prune, and clear timestamp records. */
  saveX402RateRecord(timestamp: number): Promise<void>;
  loadX402RateRecords(sinceMs: number): Promise<number[]>;
  pruneX402RateRecords(cutoffMs: number): Promise<void>;
  clearX402RateRecords(): Promise<void>;
}

// ─── SQLite ───────────────────────────────────────────────────────────────────

/**
 * SQLite storage over the connection owned by backend/db/sqlite.ts.
 */
export class SqliteStorage implements Storage {
  readonly backend = 'sqlite' as const;

  async migrate(): Promise<number> {
    return migrateSqlite(sqlite.getDb()).length;
  }

  async probe(): Promise<void> {
    sqlite.probeDb();
  }

  async close(): Promise<void> {
    sqlite.closeDb();
  }

  async saveResult(result: PersistedResult): Promise<void> {
    sqlite.saveResult(result);
  }

  async getResults(limit?: number, offset?: number): Promise<PersistedResult[]> {
    return sqlite.getResults(limit, offset);
  }

  async pruneResults(beforeIso: string): Promise<void> {
    persistence.pruneResults(beforeIso);
  }

  async appendAuditEntry(entry: AuditEntry): Promise<AuditRow> {
    return sqlite.appendAuditEntry(entry);
  }

  async getAuditLog(): Promise<AuditRow[]> {
    return sqlite.getAuditLog();
  }

  async saveAgentState(key: string, value: string): Promise<void> {
    sqlite.saveAgentState(key, value);
  }

  async loadAgentState(key: string): Promise<string | undefined> {
    return sqlite.loadAgentState(key);
  }

  async saveSpendingRecord(record: SpendingRecord): Promise<void> {
    sqlite.saveSpendingRecord(record);
  }

  async loadSpendingRecords(sinceMs: number): Promise<SpendingRecord[]> {
    return sqlite.loadSpendingRecords(sinceMs);
  }

  async pruneSpendingRecords(cutoffMs: number): Promise<void> {
    sqlite.pruneSpendingRecords(cutoffMs);
  }

  async clearSpendingRecords(): Promise<void> {
    sqlite.clearSpendingRecords();
  }

  async reserveSpending(
    optsOrAmount: ReserveSpendingOptions | number,
    limit?: number,
    sinceMs?: number,
    now?: number
  ): Promise<SpendingReservation> {
    return sqlite.reserveSpendingRecord(optsOrAmount, limit, sinceMs, now);
  }

  async releaseSpending(id: number): Promise<void> {
    sqlite.deleteSpendingRecord(id);
  }

  async saveTrackedSpendingRecord(
    record: TrackedSpendingRecord & { assetKey: string }
  ): Promise<void> {
    sqlite.saveTrackedSpendingRecord(record);
  }

  async getSpendingRecordsSince(sinceMs: number): Promise<TrackedSpendingRecord[]> {
    return sqlite.getSpendingRecordsSince(sinceMs);
  }

  async deleteTrackedSpendingRecord(reservationId: string): Promise<void> {
    sqlite.deleteTrackedSpendingRecord(reservationId);
  }

  async savePendingApproval(
    approval: Omit<PendingApproval, 'status' | 'decidedAt'>
  ): Promise<void> {
    sqlite.savePendingApproval(approval);
  }

  async getPendingApproval(id: string): Promise<PendingApproval | undefined> {
    return sqlite.getPendingApproval(id);
  }

  async listPendingApprovals(): Promise<PendingApproval[]>;
  async listPendingApprovals(): Promise<PendingApproval[]> {
    return sqlite.listPendingApprovals();
  }

  async decideApproval(
    id: string,
    decision: 'approved' | 'denied',
    now?: number
  ): Promise<boolean> {
    return sqlite.decideApproval(id, decision, now);
  }

  async expirePendingApprovals(now?: number): Promise<string[]> {
    return sqlite.expirePendingApprovals(now);
  }

  async getApprovalAuditLog(): Promise<ApprovalAuditRow[]> {
    return sqlite.getApprovalAuditLog();
  }

  async getIdempotencyResult(
    key: string,
    payload: unknown
  ): Promise<AgentResult | { conflict: true } | null> {
    return sqlite.getIdempotencyResult(key, payload);
  }

  async saveIdempotencyResult(
    key: string,
    taskType: string,
    payload: unknown,
    result: AgentResult
  ): Promise<void> {
    sqlite.saveIdempotencyResult(key, taskType, payload, result);
  }

  async pruneIdempotencyKeys(now?: number): Promise<number> {
    return sqlite.pruneIdempotencyKeys(now);
  }

  async saveTrigger(trigger: Trigger): Promise<void> {
    sqlite.saveTrigger(trigger);
  }

  async loadTriggers(): Promise<Trigger[]> {
    return sqlite.loadTriggers();
  }

  async recordTriggerFired(triggerId: string, eventId: string): Promise<boolean> {
    return sqlite.recordTriggerFired(triggerId, eventId);
  }

  async deleteTrigger(id: string): Promise<void> {
    sqlite.deleteTrigger(id);
  }

  async savePendingApproval(
    approval: Omit<PendingApproval, 'status' | 'decidedAt'>
  ): Promise<void> {
    persistence.savePendingApproval(approval);
  }

  async getPendingApproval(id: string): Promise<PendingApproval | undefined> {
    return persistence.getPendingApproval(id);
  }

  async listPendingApprovals(): Promise<PendingApproval[]> {
    return persistence.listPendingApprovals();
  }

  async decideApproval(
    id: string,
    decision: 'approved' | 'denied',
    now?: number
  ): Promise<boolean> {
    return persistence.decideApproval(id, decision, now);
  }

  async expirePendingApprovals(now?: number): Promise<string[]> {
    return persistence.expirePendingApprovals(now);
  }

  async getApprovalAuditLog(): Promise<ApprovalAuditRow[]> {
    return persistence.getApprovalAuditLog();
  }

  async getIdempotencyResult(
    key: string,
    payload: unknown
  ): Promise<AgentResult | { conflict: true } | null> {
    return persistence.getIdempotencyResult(key, payload);
  }

  async saveIdempotencyResult(
    key: string,
    taskType: string,
    payload: unknown,
    result: AgentResult
  ): Promise<void> {
    persistence.saveIdempotencyResult(key, taskType, payload, result);
  }

  async pruneIdempotencyKeys(now?: number): Promise<number> {
    return persistence.pruneIdempotencyKeys();
  }

  async saveTrigger(trigger: Trigger): Promise<void> {
    persistence.getDb()
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

  async loadTriggers(): Promise<Trigger[]> {
    try {
      const rows = persistence.getDb()
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

  async recordTriggerFired(triggerId: string, eventId: string): Promise<boolean> {
    const key = `trigger:${triggerId}:event:${eventId}`;
    const info = persistence.getDb()
      .prepare('INSERT OR IGNORE INTO trigger_events (key, fired_at) VALUES (?, ?)')
      .run(key, new Date().toISOString());
    return info.changes === 1;
  }

  async deleteTrigger(id: string): Promise<void> {
    persistence.getDb().prepare('DELETE FROM triggers WHERE id = ?').run(id);
  }

  async setPaused(paused: boolean): Promise<void> {
    await this.saveAgentState('paused', String(paused));
  }

  async isPaused(): Promise<boolean> {
    return (await this.loadAgentState('paused')) === 'true';
  }

  nonceStore(): INonceStore {
    return new SqliteNonceStore(sqlite.getDb());
  }

  async saveMppSession(channelId: string, state: string): Promise<void> {
    sqlite.saveAgentState(`mpp_session:${channelId}`, state);
  }

  async loadMppSession(channelId: string): Promise<string | undefined> {
    return sqlite.loadAgentState(`mpp_session:${channelId}`);
  }

  async listMppSessions(): Promise<MppSessionRecord[]> {
    const prefix = 'mpp_session:';
    return persistence
      .listAgentStateByPrefix(prefix)
      .map(({ key, value }) => ({ channelId: key.slice(prefix.length), state: value }));
  }

  async saveX402RateRecord(timestamp: number): Promise<void> {
    sqlite.saveX402RateRecord(timestamp);
  }

  async loadX402RateRecords(sinceMs: number): Promise<number[]> {
    return sqlite.loadX402RateRecords(sinceMs);
  }

  async pruneX402RateRecords(cutoffMs: number): Promise<void> {
    sqlite.pruneX402RateRecords(cutoffMs);
  }

  async clearX402RateRecords(): Promise<void> {
    sqlite.clearX402RateRecords();
  }
}

// ─── Process-wide instance ────────────────────────────────────────────────────

let _storage: Storage | null = null;

export function getStorage(): Storage {
  if (!_storage) {
    if (config.STORAGE_BACKEND === 'postgres') {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { PostgresStorage } = require('./postgres') as typeof import('./postgres');
      _storage = PostgresStorage.fromUrl(config.DATABASE_URL as string);
    } else {
      _storage = new SqliteStorage();
    }
  }
  return _storage;
}

export function _setStorage(storage: Storage | null): void {
  _storage = storage;
}
