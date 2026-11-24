/**
 * tests/storage.test.ts
 *
 * One behavioural suite for the Storage interface (#822), run against every
 * backend: SQLite always (in-memory), Postgres when TEST_DATABASE_URL points
 * at a database the suite may freely truncate, e.g.
 *
 *   docker compose --profile postgres run --rm test-runner-postgres
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';

vi.mock('../backend/config', () => ({
  config: {
    X402_NONCE_TTL_MS: 60_000,
  },
}));

import Database from 'better-sqlite3';
import { Pool } from 'pg';
import { _setDb, computeAuditHash, AUDIT_GENESIS_HASH } from '../backend/persistence';
import type { AuditEntry } from '../backend/persistence';
import { SqliteStorage } from '../backend/db/storage';
import type { Storage } from '../backend/db/storage';
import { PostgresStorage } from '../backend/db/postgres';

interface Backend {
  name: string;
  /** Create (or reuse) the storage and migrate it. */
  setup(): Promise<Storage>;
  /** Empty every table so each test starts from a clean store. */
  reset(storage: Storage): Promise<void>;
  teardown(storage: Storage): Promise<void>;
}

const sqliteBackend: Backend = {
  name: 'sqlite',
  async setup() {
    _setDb(new Database(':memory:'));
    const storage = new SqliteStorage();
    await storage.migrate();
    return storage;
  },
  async reset() {
    // A brand-new in-memory database per test.
    _setDb(new Database(':memory:'));
  },
  async teardown(storage) {
    await storage.close();
  },
};

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
let pgPool: Pool | null = null;

const postgresBackend: Backend = {
  name: 'postgres',
  async setup() {
    pgPool = new Pool({ connectionString: TEST_DATABASE_URL });
    const storage = new PostgresStorage(pgPool);
    await storage.migrate();
    return storage;
  },
  async reset() {
    // TRUNCATE does not fire the audit_log row triggers.
    await pgPool!.query(
      `TRUNCATE agent_results, spending_records, agent_state, x402_used_nonces, audit_log,
       pending_approvals, approval_audit_log, triggers, trigger_events, idempotency_keys
       RESTART IDENTITY`
    );
  },
  async teardown(storage) {
    await storage.close();
  },
};

const backends = [sqliteBackend, ...(TEST_DATABASE_URL ? [postgresBackend] : [])];

function makeAuditEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    ts: '2026-10-16T12:00:00.000Z',
    correlationId: 'corr-1',
    taskType: 'stellar_payment',
    txHash: 'a'.repeat(64),
    envelopeHash: null,
    destination: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    asset: 'XLM',
    amount: '10',
    ...overrides,
  };
}

describe.each(backends)('Storage ($name)', (backend) => {
  let storage: Storage;

  beforeAll(async () => {
    storage = await backend.setup();
  });

  beforeEach(async () => {
    await backend.reset(storage);
  });

  afterAll(async () => {
    await backend.teardown(storage);
  });

  it('answers the health probe', async () => {
    await expect(storage.probe()).resolves.toBeUndefined();
  });

  it('applies nothing when migrated again', async () => {
    expect(await storage.migrate()).toBe(0);
  });

  describe('agent results', () => {
    it('round-trips results, newest first', async () => {
      await storage.saveResult({
        timestamp: '2026-01-01T00:00:00.000Z',
        taskType: 'stellar_payment',
        success: true,
        data: { txHash: 'abc' },
        correlationId: 'corr-1',
      });
      await storage.saveResult({
        timestamp: '2026-01-01T00:00:01.000Z',
        taskType: 'stellar_payment',
        success: false,
        error: 'boom',
      });

      const results = await storage.getResults();

      expect(results).toEqual([
        {
          timestamp: '2026-01-01T00:00:01.000Z',
          taskType: 'stellar_payment',
          success: false,
          data: undefined,
          error: 'boom',
        },
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          taskType: 'stellar_payment',
          success: true,
          data: { txHash: 'abc' },
          correlationId: 'corr-1',
        },
      ]);
    });

    it('honours limit and offset', async () => {
      for (let i = 0; i < 3; i++) {
        await storage.saveResult({
          timestamp: `2026-01-01T00:00:0${i}.000Z`,
          taskType: 'stellar_payment',
          success: true,
        });
      }

      const page = await storage.getResults(1, 1);

      expect(page.map((r) => r.timestamp)).toEqual(['2026-01-01T00:00:01.000Z']);
    });
  });

  describe('audit log', () => {
    it('chains each row to the previous one', async () => {
      const first = await storage.appendAuditEntry(makeAuditEntry());
      const second = await storage.appendAuditEntry(makeAuditEntry({ amount: '20' }));

      expect(first.prevHash).toBe(AUDIT_GENESIS_HASH);
      expect(first.hash).toBe(computeAuditHash(AUDIT_GENESIS_HASH, makeAuditEntry()));
      expect(second.prevHash).toBe(first.hash);

      const log = await storage.getAuditLog();
      expect(log.map((r) => r.id)).toEqual([first.id, second.id]);
      expect(log[1]).toEqual(second);
    });

    it('keeps one unbroken chain under concurrent appends', async () => {
      await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          storage.appendAuditEntry(makeAuditEntry({ amount: String(i) }))
        )
      );

      const log = await storage.getAuditLog();
      let prev = AUDIT_GENESIS_HASH;
      for (const row of log) {
        expect(row.prevHash).toBe(prev);
        prev = row.hash;
      }
      expect(log).toHaveLength(5);
    });
  });

  describe('agent state', () => {
    it('returns undefined for a key that was never set', async () => {
      expect(await storage.loadAgentState('paused')).toBeUndefined();
    });

    it('replaces an existing value', async () => {
      await storage.saveAgentState('paused', 'true');
      await storage.saveAgentState('paused', 'false');

      expect(await storage.loadAgentState('paused')).toBe('false');
    });
  });

  describe('spending window', () => {
    it('saves, loads, prunes and clears records', async () => {
      await storage.saveSpendingRecord({ amount: 1.5, timestamp: 1_000 });
      await storage.saveSpendingRecord({ amount: 2.5, timestamp: 2_000 });

      expect(await storage.loadSpendingRecords(1_500)).toEqual([{ amount: 2.5, timestamp: 2_000 }]);

      await storage.pruneSpendingRecords(1_500);
      expect(await storage.loadSpendingRecords(0)).toEqual([{ amount: 2.5, timestamp: 2_000 }]);

      await storage.clearSpendingRecords();
      expect(await storage.loadSpendingRecords(0)).toEqual([]);
    });

    it('reserves within the limit and rejects past it without writing', async () => {
      const first = await storage.reserveSpending(60, 100, 0, 1_000);
      expect(first.total).toBe(60);

      await expect(storage.reserveSpending(50, 100, 0, 2_000)).rejects.toThrow(/exceeds limit/);
      expect(await storage.loadSpendingRecords(0)).toEqual([{ amount: 60, timestamp: 1_000 }]);
    });

    it('frees capacity when a reservation is released', async () => {
      const held = await storage.reserveSpending(80, 100, 0, 1_000);
      await storage.releaseSpending(held.id);

      await expect(storage.reserveSpending(80, 100, 0, 2_000)).resolves.toMatchObject({
        total: 80,
      });
    });

    it('ignores records older than the window', async () => {
      await storage.saveSpendingRecord({ amount: 90, timestamp: 1_000 });

      await expect(storage.reserveSpending(90, 100, 5_000, 6_000)).resolves.toMatchObject({
        total: 90,
      });
    });

    it('never lets concurrent reservations exceed the limit', async () => {
      const outcomes = await Promise.allSettled(
        Array.from({ length: 10 }, () => storage.reserveSpending(10, 50, 0, 1_000))
      );

      expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(5);
      const records = await storage.loadSpendingRecords(0);
      expect(records.reduce((sum, r) => sum + r.amount, 0)).toBe(50);
    });

    describe('per-asset atomic reservations (#959)', () => {
      it('enforces limits per asset and isolates different assets', async () => {
        const usdc1 = await storage.reserveSpending({
          assetKey: 'USDC',
          amountStroops: 40_000_000n,
          limitStroops: 100_000_000n,
          sinceMs: 0,
          now: 1_000,
        });
        expect(usdc1.totalStroops).toBe(40_000_000n);

        // Different asset has its own limit and succeeds
        const xlm1 = await storage.reserveSpending({
          assetKey: 'XLM',
          amountStroops: 80_000_000n,
          limitStroops: 100_000_000n,
          sinceMs: 0,
          now: 1_000,
        });
        expect(xlm1.totalStroops).toBe(80_000_000n);

        // Second USDC spend would breach USDC limit (40 + 70 = 110 > 100)
        await expect(
          storage.reserveSpending({
            assetKey: 'USDC',
            amountStroops: 70_000_000n,
            limitStroops: 100_000_000n,
            sinceMs: 0,
            now: 2_000,
          })
        ).rejects.toThrow(/exceeds limit/);
      });

      it('never lets concurrent per-asset reservations exceed the limit', async () => {
        const outcomes = await Promise.allSettled(
          Array.from({ length: 8 }, () =>
            storage.reserveSpending({
              assetKey: 'USDC',
              amountStroops: 20_000_000n,
              limitStroops: 60_000_000n,
              sinceMs: 0,
              now: 1_000,
            })
          )
        );

        const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
        expect(fulfilled).toHaveLength(3); // 20 * 3 = 60
      });
    });

    describe('tracked spending records', () => {
      it('saves, queries since, and deletes tracked records', async () => {
        await storage.saveTrackedSpendingRecord({
          id: 'res-1',
          assetKey: 'USDC',
          stroops: 50_000_000n,
          timestamp: 1_000,
        });
        await storage.saveTrackedSpendingRecord({
          id: 'res-2',
          assetKey: 'XLM',
          stroops: 10_000_000n,
          timestamp: 2_000,
        });

        const records = await storage.getSpendingRecordsSince(500);
        expect(records).toHaveLength(2);
        expect(records[0]?.id).toBe('res-1');
        expect(records[1]?.id).toBe('res-2');

        await storage.deleteTrackedSpendingRecord('res-1');
        const afterDelete = await storage.getSpendingRecordsSince(500);
        expect(afterDelete).toHaveLength(1);
        expect(afterDelete[0]?.id).toBe('res-2');
      });
    });
  });

  describe('approvals', () => {
    it('saves, retrieves, lists, decides and audits approvals', async () => {
      const now = Date.now();
      await storage.savePendingApproval({
        id: 'app-1',
        taskType: 'stellar_payment',
        payload: { amount: '10' },
        amount: '10',
        correlationId: 'corr-app',
        createdAt: now,
        expiresAt: now + 60_000,
      });

      const retrieved = await storage.getPendingApproval('app-1');
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe('app-1');
      expect(retrieved?.status).toBe('pending_approval');

      const list = await storage.listPendingApprovals();
      expect(list.some((a) => a.id === 'app-1')).toBe(true);

      const decided = await storage.decideApproval('app-1', 'approved', now + 1_000);
      expect(decided).toBe(true);

      // Second decision cannot change state
      const reDecided = await storage.decideApproval('app-1', 'denied', now + 2_000);
      expect(reDecided).toBe(false);

      const audit = await storage.getApprovalAuditLog();
      expect(audit.some((row) => row.approvalId === 'app-1' && row.decision === 'approved')).toBe(
        true
      );
    });

    it('expires overdue approvals and audits expiration', async () => {
      const now = 10_000;
      await storage.savePendingApproval({
        id: 'app-expired',
        taskType: 'stellar_payment',
        payload: { amount: '5' },
        amount: '5',
        correlationId: null,
        createdAt: now,
        expiresAt: now + 1_000,
      });

      const expired = await storage.expirePendingApprovals(now + 2_000);
      expect(expired).toContain('app-expired');

      const app = await storage.getPendingApproval('app-expired');
      expect(app?.status).toBe('expired');
    });
  });

  describe('idempotency', () => {
    it('returns stored result on matching payload and conflict on mismatched payload', async () => {
      const result: any = { success: true, taskType: 'stellar_payment', data: { tx: 'tx1' } };
      await storage.saveIdempotencyResult('idem-key-1', 'stellar_payment', { amount: '10' }, result);

      const match = await storage.getIdempotencyResult('idem-key-1', { amount: '10' });
      expect(match).toEqual(result);

      const conflict = await storage.getIdempotencyResult('idem-key-1', { amount: '20' });
      expect(conflict).toEqual({ conflict: true });
    });
  });

  describe('triggers', () => {
    it('saves, loads, dedupes and deletes triggers', async () => {
      const trigger: any = {
        id: 'trig-1',
        source: 'payment',
        filter: { assetCode: 'USDC' },
        task: { type: 'stellar_payment', payload: { amount: '1' } },
        enabled: true,
        createdAt: new Date().toISOString(),
      };

      await storage.saveTrigger(trigger);
      const loaded = await storage.loadTriggers();
      expect(loaded.some((t) => t.id === 'trig-1')).toBe(true);

      const firstFire = await storage.recordTriggerFired('trig-1', 'event-1');
      expect(firstFire).toBe(true);
      const duplicateFire = await storage.recordTriggerFired('trig-1', 'event-1');
      expect(duplicateFire).toBe(false);

      await storage.deleteTrigger('trig-1');
      const afterDelete = await storage.loadTriggers();
      expect(afterDelete.some((t) => t.id === 'trig-1')).toBe(false);
    });
  });
  });

  describe('nonce store', () => {
    it('remembers used nonces and treats repeat adds as no-ops', async () => {
      const nonces = storage.nonceStore();

      expect(await nonces.has('nonce-1')).toBe(false);
      await nonces.add('nonce-1');
      await nonces.add('nonce-1');
      expect(await nonces.has('nonce-1')).toBe(true);
      expect(await nonces.has('nonce-2')).toBe(false);
    });
  });

  describe('approvals (#958)', () => {
    it('saves, retrieves, lists, decides and audits approvals', async () => {
      const now = Date.now();
      await storage.savePendingApproval({
        id: 'app-1',
        taskType: 'stellar_payment',
        payload: { amount: '10' },
        amount: '10',
        correlationId: 'corr-app',
        createdAt: now,
        expiresAt: now + 60_000,
      });

      const retrieved = await storage.getPendingApproval('app-1');
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe('app-1');
      expect(retrieved?.status).toBe('pending_approval');

      const list = await storage.listPendingApprovals();
      expect(list.some((a) => a.id === 'app-1')).toBe(true);

      const decided = await storage.decideApproval('app-1', 'approved', now + 1_000);
      expect(decided).toBe(true);

      const reDecided = await storage.decideApproval('app-1', 'denied', now + 2_000);
      expect(reDecided).toBe(false);

      const audit = await storage.getApprovalAuditLog();
      expect(audit.some((row) => row.approvalId === 'app-1' && row.decision === 'approved')).toBe(
        true
      );
    });

    it('expires overdue approvals and audits expiration', async () => {
      const now = 10_000;
      await storage.savePendingApproval({
        id: 'app-expired',
        taskType: 'stellar_payment',
        payload: { amount: '5' },
        amount: '5',
        correlationId: null,
        createdAt: now,
        expiresAt: now + 1_000,
      });

      const expired = await storage.expirePendingApprovals(now + 2_000);
      expect(expired).toContain('app-expired');

      const app = await storage.getPendingApproval('app-expired');
      expect(app?.status).toBe('expired');
    });
  });

  describe('idempotency (#958)', () => {
    it('returns stored result on matching payload and conflict on mismatched payload', async () => {
      const result: any = { success: true, taskType: 'stellar_payment', data: { tx: 'tx1' } };
      await storage.saveIdempotencyResult('idem-key-1', 'stellar_payment', { amount: '10' }, result);

      const match = await storage.getIdempotencyResult('idem-key-1', { amount: '10' });
      expect(match).toEqual(result);

      const conflict = await storage.getIdempotencyResult('idem-key-1', { amount: '20' });
      expect(conflict).toEqual({ conflict: true });
    });
  });

  describe('triggers (#958)', () => {
    it('saves, loads, dedupes and deletes triggers', async () => {
      const trigger: any = {
        id: 'trig-1',
        source: 'payment',
        filter: { assetCode: 'USDC' },
        task: { type: 'stellar_payment', payload: { amount: '1' } },
        enabled: true,
        createdAt: new Date().toISOString(),
      };

      await storage.saveTrigger(trigger);
      const loaded = await storage.loadTriggers();
      expect(loaded.some((t) => t.id === 'trig-1')).toBe(true);

      const firstFire = await storage.recordTriggerFired('trig-1', 'event-1');
      expect(firstFire).toBe(true);
      const duplicateFire = await storage.recordTriggerFired('trig-1', 'event-1');
      expect(duplicateFire).toBe(false);

      await storage.deleteTrigger('trig-1');
      const afterDelete = await storage.loadTriggers();
      expect(afterDelete.some((t) => t.id === 'trig-1')).toBe(false);
    });
  });

  describe('kill-switch state (#958)', () => {
    it('persists paused state and reports correctly', async () => {
      expect(await storage.isPaused()).toBe(false);
      await storage.setPaused(true);
      expect(await storage.isPaused()).toBe(true);
      await storage.setPaused(false);
      expect(await storage.isPaused()).toBe(false);
    });
  });
});

describe('Multi-instance Postgres sharing integration test (#957)', () => {
  it('two instances sharing one database share the spending window and limit', async () => {
    let s1: Storage;
    let s2: Storage;
    if (TEST_DATABASE_URL && pgPool) {
      s1 = new PostgresStorage(pgPool);
      s2 = new PostgresStorage(pgPool);
    } else {
      s1 = new SqliteStorage();
      s2 = new SqliteStorage();
    }

    await s1.clearSpendingRecords();

    const res1 = await s1.reserveSpending({
      assetKey: 'USDC',
      amountStroops: 60_000_000n,
      limitStroops: 100_000_000n,
      sinceMs: 0,
    });
    expect(res1.totalStroops).toBe(60_000_000n);

    await expect(
      s2.reserveSpending({
        assetKey: 'USDC',
        amountStroops: 50_000_000n,
        limitStroops: 100_000_000n,
        sinceMs: 0,
      })
    ).rejects.toThrow(/exceeds limit/);

    const res2 = await s2.reserveSpending({
      assetKey: 'USDC',
      amountStroops: 30_000_000n,
      limitStroops: 100_000_000n,
      sinceMs: 0,
    });
    expect(res2.totalStroops).toBe(90_000_000n);
  });
});
