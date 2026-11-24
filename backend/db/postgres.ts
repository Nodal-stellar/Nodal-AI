/**
 * backend/db/postgres.ts
 *
 * Postgres implementation of {@link Storage} for multi-instance deployments
 * (#822, #957, #959). Every instance pointed at the same DATABASE_URL shares one spending
 * window, one nonce set, one audit chain, approvals, triggers and idempotency.
 *
 * Concurrency:
 *   • Spending reservations lock the single `spending_lock` row with
 *     SELECT … FOR UPDATE before summing the window, so concurrent
 *     reservations — from any instance — are serialised.
 *   • Audit appends take a transaction-scoped advisory lock so two rows can
 *     never chain off the same predecessor.
 *   • Migrations run under a session advisory lock (see migrate.ts).
 */

import { createHash, randomUUID } from 'crypto';
import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import type { AgentResult } from '../agent';
import type { INonceStore } from '../nonce_store';
import { configuredTtlMs } from '../nonce_store';
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
import { migratePostgres } from './migrate';
import type { MppSessionRecord, Storage } from './storage';

/** Advisory-lock key serialising audit-log appends. Arbitrary but fixed. */
const AUDIT_LOCK_KEY = 7_440_744;

/** The subset of `pg.Pool` this module uses, so tests can supply their own. */
export interface PgPool {
  query(text: string, params?: unknown[]): Promise<{ rows: any[]; rowCount?: number }>;
  connect(): Promise<PoolClient>;
  end(): Promise<void>;
}

/** Run `fn` inside a transaction on a dedicated pooled client. */
async function withTransaction<T>(
  pool: PgPool,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

const AUDIT_COLUMNS = `id, ts, "correlationId", "taskType", "txHash", "envelopeHash",
  destination, asset, amount, "prevHash", hash`;

export class PostgresStorage implements Storage {
  readonly backend = 'postgres' as const;

  constructor(private readonly pool: PgPool) {}

  /** Create a storage backed by a new connection pool for `url`. */
  static fromUrl(url: string): PostgresStorage {
    if (!url) {
      throw new Error('DATABASE_URL is required when STORAGE_BACKEND=postgres');
    }
    return new PostgresStorage(new Pool({ connectionString: url }));
  }

  async migrate(): Promise<number> {
    const client = await this.pool.connect();
    try {
      return (await migratePostgres(client)).length;
    } finally {
      client.release();
    }
  }

  async probe(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  // ─── Agent results ──────────────────────────────────────────────────────────

  async saveResult(result: PersistedResult): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_results ("timestamp", "taskType", success, data, error, "correlationId", "errorType", "durationMs")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        result.timestamp,
        result.taskType,
        result.success,
        result.data !== undefined ? JSON.stringify(result.data) : null,
        result.error ?? null,
        result.correlationId ?? null,
        result.errorType ?? null,
        result.durationMs ?? null,
      ]
    );
  }

  async getResults(limit = 100, offset = 0): Promise<PersistedResult[]> {
    const { rows } = await this.pool.query(
      `SELECT "timestamp", "taskType", success, data, error, "correlationId", "errorType", "durationMs"
       FROM agent_results
       ORDER BY "timestamp" DESC, id DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    return rows.map((r: any) => ({
      timestamp: r.timestamp,
      taskType: r.taskType,
      success: r.success,
      data: r.data !== null ? JSON.parse(r.data) : undefined,
      error: r.error ?? undefined,
      correlationId: r.correlationId ?? undefined,
      errorType: r.errorType ?? undefined,
      durationMs: r.durationMs ?? undefined,
    }));
  }

  async pruneResults(beforeIso: string): Promise<void> {
    await this.pool.query(`DELETE FROM agent_results WHERE "timestamp" < $1`, [beforeIso]);
  }

  // ─── Audit log ──────────────────────────────────────────────────────────────

  async appendAuditEntry(entry: AuditEntry): Promise<AuditRow> {
    return withTransaction(this.pool, async (client) => {
      await client.query(`SELECT pg_advisory_xact_lock($1)`, [AUDIT_LOCK_KEY]);

      const last = await client.query(`SELECT hash FROM audit_log ORDER BY id DESC LIMIT 1`);
      const prevHash = last.rows[0]?.hash ?? AUDIT_GENESIS_HASH;
      const hash = computeAuditHash(prevHash, entry);

      const inserted = await client.query(
        `INSERT INTO audit_log
           (ts, "correlationId", "taskType", "txHash", "envelopeHash",
            destination, asset, amount, "prevHash", hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         RETURNING ${AUDIT_COLUMNS}`,
        [
          entry.ts,
          entry.correlationId ?? null,
          entry.taskType,
          entry.txHash ?? null,
          entry.envelopeHash ?? null,
          entry.destination ?? null,
          entry.asset ?? null,
          entry.amount ?? null,
          prevHash,
          hash,
        ]
      );

      return this.mapAuditRow(inserted.rows[0]);
    });
  }

  async getAuditLog(): Promise<AuditRow[]> {
    const { rows } = await this.pool.query(
      `SELECT ${AUDIT_COLUMNS} FROM audit_log ORDER BY id ASC`
    );
    return rows.map((r: any) => this.mapAuditRow(r));
  }

  private mapAuditRow(r: any): AuditRow {
    return {
      id: Number(r.id),
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
    };
  }

  // ─── Agent state ────────────────────────────────────────────────────────────

  async saveAgentState(key: string, value: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_state (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      [key, value]
    );
  }

  async loadAgentState(key: string): Promise<string | undefined> {
    const { rows } = await this.pool.query(`SELECT value FROM agent_state WHERE key = $1`, [key]);
    return rows[0]?.value;
  }

  // ─── Spending window ────────────────────────────────────────────────────────

  async saveSpendingRecord(record: SpendingRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO spending_records (amount, "timestamp") VALUES ($1, $2)`,
      [record.amount, record.timestamp]
    );
  }

  async loadSpendingRecords(sinceMs: number): Promise<SpendingRecord[]> {
    const { rows } = await this.pool.query(
      `SELECT amount, "timestamp" FROM spending_records
       WHERE "timestamp" >= $1 ORDER BY "timestamp" ASC`,
      [sinceMs]
    );
    return rows.map((r: any) => ({
      amount: Number(r.amount),
      timestamp: Number(r.timestamp),
    }));
  }

  async pruneSpendingRecords(cutoffMs: number): Promise<void> {
    await this.pool.query(`DELETE FROM spending_records WHERE "timestamp" < $1`, [cutoffMs]);
  }

  async clearSpendingRecords(): Promise<void> {
    await this.pool.query(`DELETE FROM spending_records`);
  }

  async reserveSpending(
    optsOrAmount: ReserveSpendingOptions | number,
    limit?: number,
    sinceMs?: number,
    now?: number
  ): Promise<SpendingReservation> {
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

    return withTransaction(this.pool, async (client) => {
      // Row lock: serialises concurrent reservations across instances
      await client.query(`SELECT id FROM spending_lock WHERE id = 1 FOR UPDATE`);

      const res = await client.query(
        `SELECT stroops, amount, asset_key FROM spending_records
         WHERE "timestamp" >= $1`,
        [opts.sinceMs]
      );

      let currentTotalStroops = 0n;
      for (const row of res.rows) {
        const rowAsset = row.asset_key ?? 'USDC';
        if (rowAsset === opts.assetKey) {
          if (row.stroops != null) {
            currentTotalStroops += BigInt(row.stroops);
          } else {
            currentTotalStroops += BigInt(Math.round(Number(row.amount) * 10_000_000));
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
      const inserted = await client.query(
        `INSERT INTO spending_records (amount, "timestamp", reservation_id, asset_key, stroops)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [
          Number(opts.amountStroops) / 10_000_000,
          timestamp,
          resId,
          opts.assetKey,
          opts.amountStroops.toString(),
        ]
      );

      return {
        id: Number(inserted.rows[0].id),
        total: Number(totalStroops) / 10_000_000,
        totalStroops,
      };
    });
  }

  async releaseSpending(id: number): Promise<void> {
    await this.pool.query(`DELETE FROM spending_records WHERE id = $1`, [id]);
  }

  async saveTrackedSpendingRecord(
    record: TrackedSpendingRecord & { assetKey: string }
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO spending_records (amount, "timestamp", reservation_id, asset_key, stroops)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        Number(record.stroops) / 10_000_000,
        record.timestamp,
        record.id,
        record.assetKey,
        record.stroops.toString(),
      ]
    );
  }

  async getSpendingRecordsSince(sinceMs: number): Promise<TrackedSpendingRecord[]> {
    const { rows } = await this.pool.query(
      `SELECT id, amount, "timestamp", reservation_id, asset_key, stroops
       FROM spending_records
       WHERE "timestamp" >= $1
       ORDER BY "timestamp" ASC`,
      [sinceMs]
    );

    return rows.map((r: any) => ({
      id: r.reservation_id ?? `legacy-${r.id}`,
      assetKey: r.asset_key,
      stroops:
        r.stroops !== null ? BigInt(r.stroops) : BigInt(Math.round(Number(r.amount) * 10_000_000)),
      timestamp: Number(r.timestamp),
    }));
  }

  async deleteTrackedSpendingRecord(reservationId: string): Promise<void> {
    await this.pool.query(`DELETE FROM spending_records WHERE reservation_id = $1`, [
      reservationId,
    ]);
  }

  // ─── Approvals ──────────────────────────────────────────────────────────────

  async savePendingApproval(
    approval: Omit<PendingApproval, 'status' | 'decidedAt'>
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO pending_approvals
         (id, "taskType", payload, amount, "correlationId", status, "createdAt", "expiresAt", "decidedAt")
       VALUES ($1, $2, $3, $4, $5, 'pending_approval', $6, $7, NULL)`,
      [
        approval.id,
        approval.taskType,
        JSON.stringify(approval.payload ?? null),
        approval.amount,
        approval.correlationId ?? null,
        approval.createdAt,
        approval.expiresAt,
      ]
    );
  }

  async getPendingApproval(id: string): Promise<PendingApproval | undefined> {
    const { rows } = await this.pool.query(
      `SELECT id, "taskType", payload, amount, "correlationId", status, "createdAt", "expiresAt", "decidedAt"
       FROM pending_approvals WHERE id = $1`,
      [id]
    );
    if (!rows[0]) return undefined;
    const r = rows[0];
    return {
      id: r.id,
      taskType: r.taskType,
      payload: JSON.parse(r.payload),
      amount: r.amount,
      correlationId: r.correlationId ?? null,
      status: r.status,
      createdAt: Number(r.createdAt),
      expiresAt: Number(r.expiresAt),
      decidedAt: r.decidedAt !== null ? Number(r.decidedAt) : null,
    };
  }

  async listPendingApprovals(): Promise<PendingApproval[]> {
    const { rows } = await this.pool.query(
      `SELECT id, "taskType", payload, amount, "correlationId", status, "createdAt", "expiresAt", "decidedAt"
       FROM pending_approvals WHERE status = 'pending_approval' ORDER BY "createdAt" ASC`
    );
    return rows.map((r: any) => ({
      id: r.id,
      taskType: r.taskType,
      payload: JSON.parse(r.payload),
      amount: r.amount,
      correlationId: r.correlationId ?? null,
      status: r.status,
      createdAt: Number(r.createdAt),
      expiresAt: Number(r.expiresAt),
      decidedAt: r.decidedAt !== null ? Number(r.decidedAt) : null,
    }));
  }

  async decideApproval(
    id: string,
    decision: 'approved' | 'denied',
    now: number = Date.now()
  ): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      const updateRes = await client.query(
        `UPDATE pending_approvals SET status = $1, "decidedAt" = $2
         WHERE id = $3 AND status = 'pending_approval' AND "expiresAt" > $2`,
        [decision, now, id]
      );
      if ((updateRes.rowCount ?? 0) !== 1) return false;
      await client.query(
        `INSERT INTO approval_audit_log ("approvalId", decision, ts) VALUES ($1, $2, $3)`,
        [id, decision, now]
      );
      return true;
    });
  }

  async expirePendingApprovals(now: number = Date.now()): Promise<string[]> {
    return withTransaction(this.pool, async (client) => {
      const { rows } = await client.query(
        `SELECT id FROM pending_approvals WHERE status = 'pending_approval' AND "expiresAt" <= $1`,
        [now]
      );
      if (rows.length === 0) return [];
      const ids = rows.map((r: { id: string }) => r.id);
      await client.query(
        `UPDATE pending_approvals SET status = 'expired', "decidedAt" = $1 WHERE id = ANY($2::text[])`,
        [now, ids]
      );
      for (const id of ids) {
        await client.query(
          `INSERT INTO approval_audit_log ("approvalId", decision, ts) VALUES ($1, 'expired', $2)`,
          [id, now]
        );
      }
      return ids;
    });
  }

  async getApprovalAuditLog(): Promise<ApprovalAuditRow[]> {
    const { rows } = await this.pool.query(
      `SELECT "approvalId", decision, ts FROM approval_audit_log ORDER BY id ASC`
    );
    return rows.map((r: any) => ({
      approvalId: r.approvalId,
      decision: r.decision,
      ts: Number(r.ts),
    }));
  }

  // ─── Idempotency ────────────────────────────────────────────────────────────

  async getIdempotencyResult(
    key: string,
    payload: unknown
  ): Promise<AgentResult | { conflict: true } | null> {
    const { rows } = await this.pool.query(
      `SELECT "payloadHash", "taskType", status, result, "expiresAt"
       FROM idempotency_keys WHERE key = $1`,
      [key]
    );
    if (!rows[0]) return null;
    const row = rows[0];

    if (Date.now() > Number(row.expiresAt)) {
      await this.pool.query(`DELETE FROM idempotency_keys WHERE key = $1`, [key]);
      return null;
    }

    const payloadHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    if (row.payloadHash !== payloadHash) {
      return { conflict: true };
    }

    return JSON.parse(row.result) as AgentResult;
  }

  async saveIdempotencyResult(
    key: string,
    taskType: string,
    payload: unknown,
    result: AgentResult
  ): Promise<void> {
    const now = Date.now();
    const expiresAt = now + 24 * 60 * 60 * 1000;
    const payloadHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');

    await this.pool.query(
      `INSERT INTO idempotency_keys
         (key, "payloadHash", "taskType", status, result, "createdAt", "expiresAt")
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (key) DO UPDATE SET
         "payloadHash" = excluded."payloadHash",
         "taskType" = excluded."taskType",
         status = excluded.status,
         result = excluded.result,
         "expiresAt" = excluded."expiresAt"`,
      [
        key,
        payloadHash,
        taskType,
        result.success ? 'success' : 'failure',
        JSON.stringify(result),
        now,
        expiresAt,
      ]
    );
  }

  async pruneIdempotencyKeys(now: number = Date.now()): Promise<number> {
    const res = await this.pool.query(`DELETE FROM idempotency_keys WHERE "expiresAt" < $1`, [now]);
    return res.rowCount ?? 0;
  }

  // ─── Triggers ───────────────────────────────────────────────────────────────

  async saveTrigger(trigger: Trigger): Promise<void> {
    await this.pool.query(
      `INSERT INTO triggers (id, source, filter, task, enabled, created_at, last_fired_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         source = excluded.source,
         filter = excluded.filter,
         task = excluded.task,
         enabled = excluded.enabled,
         created_at = excluded.created_at,
         last_fired_at = excluded.last_fired_at`,
      [
        trigger.id,
        trigger.source,
        JSON.stringify(trigger.filter),
        JSON.stringify(trigger.task),
        trigger.enabled,
        trigger.createdAt,
        trigger.lastFiredAt ?? null,
      ]
    );
  }

  async loadTriggers(): Promise<Trigger[]> {
    try {
      const { rows } = await this.pool.query(`SELECT * FROM triggers`);
      return rows.map((row: any) => ({
        id: row.id,
        source: row.source as TriggerSource,
        filter: JSON.parse(row.filter),
        task: JSON.parse(row.task),
        enabled: Boolean(row.enabled),
        createdAt: row.created_at,
        ...(row.last_fired_at !== null ? { lastFiredAt: row.last_fired_at } : {}),
      }));
    } catch {
      return [];
    }
  }

  async recordTriggerFired(triggerId: string, eventId: string): Promise<boolean> {
    const key = `trigger:${triggerId}:event:${eventId}`;
    const res = await this.pool.query(
      `INSERT INTO trigger_events (key, fired_at) VALUES ($1, $2)
       ON CONFLICT (key) DO NOTHING`,
      [key, new Date().toISOString()]
    );
    return (res.rowCount ?? 0) === 1;
  }

  async deleteTrigger(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM triggers WHERE id = $1`, [id]);
  }

  // ─── Nonces ─────────────────────────────────────────────────────────────────

  nonceStore(): INonceStore {
    return new PostgresNonceStore(this.pool);
  }

  // ─── MPP Sessions ───────────────────────────────────────────────────────────

  async saveMppSession(channelId: string, state: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_state (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
      [`mpp_session:${channelId}`, state]
    );
  }

  async loadMppSession(channelId: string): Promise<string | undefined> {
    const { rows } = await this.pool.query(`SELECT value FROM agent_state WHERE key = $1`, [
      `mpp_session:${channelId}`,
    ]);
    return rows[0]?.value;
  }

  async listMppSessions(): Promise<MppSessionRecord[]> {
    const prefix = 'mpp_session:';
    const { rows } = await this.pool.query(
      `SELECT key, value FROM agent_state WHERE starts_with(key, $1)`,
      [prefix]
    );
    return rows.map((r: { key: string; value: string }) => ({
      channelId: r.key.slice(prefix.length),
      state: r.value,
    }));
  }

  // ─── X402 Rate Limiter ───────────────────────────────────────────────────────

  async saveX402RateRecord(timestamp: number): Promise<void> {
    await this.pool.query(`INSERT INTO x402_rate_records (timestamp) VALUES ($1)`, [timestamp]);
  }

  async loadX402RateRecords(sinceMs: number): Promise<number[]> {
    const { rows } = await this.pool.query(
      `SELECT timestamp FROM x402_rate_records WHERE timestamp >= $1 ORDER BY timestamp ASC`,
      [sinceMs]
    );
    return rows.map((r: { timestamp: number }) => r.timestamp);
  }

  async pruneX402RateRecords(cutoffMs: number): Promise<void> {
    await this.pool.query(`DELETE FROM x402_rate_records WHERE timestamp < $1`, [cutoffMs]);
  }

  async clearX402RateRecords(): Promise<void> {
    await this.pool.query(`DELETE FROM x402_rate_records`);
  }
}

/**
 * Postgres-backed x402 nonce store, shared by every instance using the same
 * database. Same semantics as SqliteNonceStore: expired nonces are evicted on
 * every access and add() is idempotent.
 */
export class PostgresNonceStore implements INonceStore {
  constructor(
    private readonly pool: Pick<PgPool, 'query'>,
    private readonly ttlMs: () => number = configuredTtlMs
  ) {}

  async has(nonce: string): Promise<boolean> {
    await this.prune();
    const { rows } = await this.pool.query(`SELECT 1 FROM x402_used_nonces WHERE nonce = $1`, [
      nonce,
    ]);
    return rows.length > 0;
  }

  async add(nonce: string): Promise<void> {
    await this.prune();
    await this.pool.query(
      `INSERT INTO x402_used_nonces (nonce, used_at_ms) VALUES ($1, $2)
       ON CONFLICT (nonce) DO NOTHING`,
      [nonce, Date.now()]
    );
  }

  async prune(ttlMs: number = this.ttlMs()): Promise<void> {
    await this.pool.query(`DELETE FROM x402_used_nonces WHERE used_at_ms < $1`, [
      Date.now() - ttlMs,
    ]);
  }
}
