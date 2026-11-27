/**
 * scripts/db_prune.ts
 *
 * One-shot data retention sweep (#963): deletes agent_results,
 * pending_approvals and trigger_events rows past their configured retention
 * window, plus expired idempotency keys and x402 rate records past the
 * sliding window. The hash-chained audit log is never touched.
 *
 * Runs the same sweep the daily retention job (backend/retention.ts) performs
 * in the live agent process — useful for a one-off cleanup, or for running
 * the sweep from a separate cron/task runner instead of in-process.
 *
 * Usage:
 *   npm run db:prune
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { configPromise } from '../backend/config';
import { getStorage } from '../backend/db/storage';
import { runRetention } from '../backend/retention';

async function main(): Promise<void> {
  await configPromise;
  const summary = await runRetention();
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  await getStorage().close();
}

main().catch((err) => {
  process.stderr.write(`❌ [db:prune] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
