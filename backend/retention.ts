/**
 * backend/retention.ts
 *
 * Data retention (#963): several tables grow without bound for a
 * long-running agent — agent_results, decided/expired pending_approvals,
 * trigger_events dedupe rows, and idempotency keys past their TTL. This
 * module prunes all of them on a daily timer.
 *
 * The hash-chained audit log (`audit_log`) is never touched — it is the
 * tamper-evident record and pruning it would break the chain.
 */

import { config } from './config';
import { getStorage } from './db/storage';
import { pruneDecidedApprovals, pruneIdempotencyKeys } from './persistence';
import { pruneTriggerEvents } from './triggers';
import { x402RateLimiter } from './x402_rate_limiter';
import { createLogger } from './utils/logger';

const log = createLogger('retention');
const MS_PER_DAY = 86_400_000;

export interface RetentionSummary {
  prunedResults: boolean;
  prunedApprovals: number;
  prunedTriggerEvents: number;
  prunedIdempotencyKeys: number;
}

/**
 * Delete rows past their configured retention window. Each table is pruned
 * independently so a failure in one (e.g. a missing table in a fresh
 * deployment) does not block the others.
 */
export async function runRetention(now: number = Date.now()): Promise<RetentionSummary> {
  const summary: RetentionSummary = {
    prunedResults: false,
    prunedApprovals: 0,
    prunedTriggerEvents: 0,
    prunedIdempotencyKeys: 0,
  };

  try {
    const cutoffIso = new Date(now - config.RETENTION_DAYS_RESULTS * MS_PER_DAY).toISOString();
    await getStorage().pruneResults(cutoffIso);
    summary.prunedResults = true;
  } catch (err) {
    log.error({ msg: 'Failed to prune agent_results', err: String(err) });
  }

  try {
    const cutoffMs = now - config.RETENTION_DAYS_APPROVALS * MS_PER_DAY;
    summary.prunedApprovals = pruneDecidedApprovals(cutoffMs);
  } catch (err) {
    log.error({ msg: 'Failed to prune pending_approvals', err: String(err) });
  }

  try {
    const cutoffIso = new Date(
      now - config.RETENTION_DAYS_TRIGGER_EVENTS * MS_PER_DAY
    ).toISOString();
    summary.prunedTriggerEvents = pruneTriggerEvents(cutoffIso);
  } catch (err) {
    log.error({ msg: 'Failed to prune trigger_events', err: String(err) });
  }

  try {
    summary.prunedIdempotencyKeys = pruneIdempotencyKeys();
  } catch (err) {
    log.error({ msg: 'Failed to prune idempotency_keys', err: String(err) });
  }

  try {
    // Side effect: evicts records past the sliding window, same as a live check.
    x402RateLimiter.getWindowStatus();
  } catch (err) {
    log.error({ msg: 'Failed to prune x402 rate records', err: String(err) });
  }

  log.info({ msg: 'Retention sweep complete', ...summary });
  return summary;
}

/**
 * Start the daily (configurable via RETENTION_JOB_INTERVAL_MS) retention
 * sweep. Returns a stop function for graceful shutdown.
 */
export function startRetentionJob(
  intervalMs: number = config.RETENTION_JOB_INTERVAL_MS
): () => void {
  const timer = setInterval(() => {
    void runRetention();
  }, intervalMs);
  return () => clearInterval(timer);
}
