/**
 * tests/retention.test.ts
 *
 * Data retention (#963): agent_results, decided/expired pending_approvals and
 * trigger_events rows past their configured retention window are deleted by
 * the retention sweep; the hash-chained audit_log is never touched.
 */

import Database from 'better-sqlite3';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../backend/config', () => ({
  config: {
    STORAGE_BACKEND: 'sqlite',
    DB_PATH: ':memory:',
    RETENTION_DAYS_RESULTS: 30,
    RETENTION_DAYS_APPROVALS: 30,
    RETENTION_DAYS_TRIGGER_EVENTS: 30,
    RETENTION_JOB_INTERVAL_MS: 86_400_000,
    MAX_X402_PAYMENTS_PER_MINUTE: 10,
    X402_NONCE_TTL_MS: 86_400_000,
  },
}));

import { _setDb, appendAuditEntry, getResults, getApprovalAuditLog } from '../backend/persistence';
import { _setStorage } from '../backend/db/storage';
import { runRetention, startRetentionJob } from '../backend/retention';

const NOW = new Date('2026-06-01T00:00:00.000Z').getTime();
const OLD = NOW - 40 * 86_400_000; // 40 days ago — past every 30-day window
const RECENT = NOW - 5 * 86_400_000; // 5 days ago — inside every window

let db: Database.Database;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  db = new Database(':memory:');
  _setDb(db);
  _setStorage(null); // force a fresh SqliteStorage bound to the new db
});

afterEach(() => {
  vi.useRealTimers();
  _setStorage(null);
});

function insertResult(timestampMs: number): void {
  db.prepare(
    `INSERT INTO agent_results (timestamp, taskType, success) VALUES (?, 'stellar_payment', 1)`
  ).run(new Date(timestampMs).toISOString());
}

function insertApproval(id: string, status: string, decidedAt: number | null): void {
  db.prepare(
    `INSERT INTO pending_approvals (id, taskType, payload, amount, status, createdAt, expiresAt, decidedAt)
     VALUES (?, 'stellar_payment', '{}', '10', ?, ?, ?, ?)`
  ).run(id, status, OLD, OLD + 60_000, decidedAt);
}

function insertTriggerEvent(key: string, firedAtMs: number): void {
  db.prepare(`INSERT INTO trigger_events (key, fired_at) VALUES (?, ?)`).run(
    key,
    new Date(firedAtMs).toISOString()
  );
}

describe('runRetention', () => {
  it('deletes agent_results older than RETENTION_DAYS_RESULTS, keeps recent ones', async () => {
    insertResult(OLD);
    insertResult(RECENT);

    await runRetention(NOW);

    expect(getResults(100)).toHaveLength(1);
  });

  it('deletes decided/expired approvals past the window, keeps pending ones', async () => {
    insertApproval('old-approved', 'approved', OLD);
    insertApproval('old-expired', 'expired', OLD);
    insertApproval('still-pending', 'pending_approval', null);

    const summary = await runRetention(NOW);

    expect(summary.prunedApprovals).toBe(2);
    const remaining = db.prepare(`SELECT id FROM pending_approvals`).all() as Array<{
      id: string;
    }>;
    expect(remaining.map((r) => r.id)).toEqual(['still-pending']);
  });

  it('does not delete a decided approval still inside the retention window', async () => {
    insertApproval('recently-approved', 'approved', RECENT);

    const summary = await runRetention(NOW);

    expect(summary.prunedApprovals).toBe(0);
  });

  it('deletes trigger_events older than RETENTION_DAYS_TRIGGER_EVENTS, keeps recent ones', async () => {
    insertTriggerEvent('old-key', OLD);
    insertTriggerEvent('recent-key', RECENT);

    const summary = await runRetention(NOW);

    expect(summary.prunedTriggerEvents).toBe(1);
    const remaining = db.prepare(`SELECT key FROM trigger_events`).all() as Array<{
      key: string;
    }>;
    expect(remaining).toEqual([{ key: 'recent-key' }]);
  });

  it('never touches the hash-chained audit log', async () => {
    appendAuditEntry({
      ts: new Date(OLD).toISOString(),
      correlationId: 'corr-1',
      taskType: 'stellar_payment',
      txHash: 'a'.repeat(64),
      envelopeHash: null,
      destination: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      asset: 'XLM',
      amount: '10',
    });

    await runRetention(NOW);

    const rows = db.prepare(`SELECT * FROM audit_log`).all();
    expect(rows).toHaveLength(1);
  });

  it('never deletes approval_audit_log decision history', async () => {
    insertApproval('old-denied', 'denied', OLD);
    db.prepare(
      `INSERT INTO approval_audit_log (approvalId, decision, ts) VALUES (?, 'denied', ?)`
    ).run('old-denied', OLD);

    await runRetention(NOW);

    expect(getApprovalAuditLog()).toHaveLength(1);
  });

  it('keeps sweeping independent tables when one prune fails', async () => {
    // Drop trigger_events to simulate a table that cannot be pruned; the
    // other, unrelated prunes must still run to completion.
    db.exec(`DROP TABLE trigger_events`);
    insertResult(OLD);

    const summary = await runRetention(NOW);

    expect(summary.prunedTriggerEvents).toBe(0);
    expect(getResults(100)).toHaveLength(0);
  });
});

describe('startRetentionJob', () => {
  it('runs a sweep on the configured interval and stops cleanly', async () => {
    insertResult(OLD);

    const stop = startRetentionJob(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(getResults(100)).toHaveLength(0);

    stop();
    insertResult(OLD);
    await vi.advanceTimersByTimeAsync(10_000);

    // No further sweep ran after stop() — the row planted post-stop survives.
    expect(getResults(100)).toHaveLength(1);
  });
});
