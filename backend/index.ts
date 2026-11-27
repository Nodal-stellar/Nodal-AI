/**
 * backend/index.ts
 * Agent process entry point.
 * Registers SIGTERM/SIGINT handlers and orchestrates graceful shutdown.
 */

import { PayFiAgent } from './agent';
import { startHealthServer } from './server';
import { db } from './db/client';
import { createLogger } from './utils/logger';
import { initTelemetry, shutdownTelemetry } from './telemetry';
import { configPromise } from './config';
import { startMppSessionSweeper, sweepExpiredChannels } from './payments/mpp_session';

const log = createLogger('process');

let agent: PayFiAgent;
let healthServer: any;
let stopChannelSweeper: (() => void) | undefined;
const HARD_KILL_MS = 10_000;
// Leave headroom inside the hard-kill window for the remaining teardown steps.
export const PENDING_TASKS_TIMEOUT_MS = 8_000;
let isShuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;

  log.info({ msg: 'Graceful shutdown initiated', signal });

  // Hard kill: force exit if shutdown hangs beyond 10 seconds
  const hardKill = setTimeout(() => {
    log.error({ msg: 'Hard kill: graceful shutdown exceeded 10s, forcing exit' });
    process.exit(1);
  }, HARD_KILL_MS);

  try {
    // 1. Stop accepting new tasks
    if (agent) {
      agent.drain();
      // 2. Wait (bounded) for in-flight tasks to settle; queued ones were
      //    already rejected by drain().
      await agent.waitForPendingTasks(PENDING_TASKS_TIMEOUT_MS);
    }

    // 3. Stop the health check server and the MPP channel sweeper
    stopChannelSweeper?.();
    stopChannelSweeper = undefined;
    if (healthServer) {
      await new Promise<void>((resolve, reject) =>
        healthServer.close((err?: Error) => (err ? reject(err) : resolve()))
      );
    }

    // 4. Stop the retention sweep
    stopRetentionJob?.();

    // 5. Close database connection
    await db.close();

    // 6. Shut down telemetry (flushes pending spans)
    await shutdownTelemetry();

    clearTimeout(hardKill);
    log.info({ msg: 'All resources released, exiting cleanly' });
    process.exit(0);
  } catch (err) {
    log.error({
      msg: 'Error during shutdown sequence',
      error: err instanceof Error ? err.message : String(err),
    });
    clearTimeout(hardKill);
    process.exit(1);
  }
}

async function start() {
  await configPromise;

  // Bring the database schema up to date before anything reads or writes it.
  await db.migrate();

  // Initialise OpenTelemetry export (no-op when OTLP_ENDPOINT is unset)
  initTelemetry();

  agent = new PayFiAgent();
  healthServer = startHealthServer(agent);
  stopRetentionJob = startRetentionJob();

  // Sweep MPP channels past their timeout once at boot, then on an interval,
  // so expired channels release their spending reservations and alert operators.
  void sweepExpiredChannels().catch((err) =>
    log.error({ error: String(err) }, 'Startup MPP channel sweep failed')
  );
  stopChannelSweeper = startMppSessionSweeper();

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((err) => {
  log.error({
    msg: 'Failed to start agent process',
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});

export { agent, PayFiAgent };
