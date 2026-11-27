/**
 * backend/kill_switch.ts
 *
 * Global kill switch that halts every value-moving task without stopping the
 * process, so health checks and read-only tasks keep working during an incident.
 *
 * The agent starts paused when PAUSED=true or when it was paused before the last
 * restart (the state is persisted in the agent database). Pausing and resuming
 * emit an `agent.paused` / `agent.resumed` webhook event.
 *
 * ## Multi-instance sync (#960)
 * `isPaused()` reads an in-memory cache so every call site stays synchronous.
 * `pauseAgent`/`resumeAgent` write through to the shared storage backend
 * (SQLite or Postgres — whichever STORAGE_BACKEND selects) and update the
 * cache immediately, so the pausing instance halts right away. Other
 * instances sharing that store only see the change once `startKillSwitchSync`
 * next polls it — bounded by KILL_SWITCH_SYNC_INTERVAL_MS (default 2s).
 */

import { config } from './config';
import { loadAgentState } from './persistence';
import { getStorage } from './db/storage';
import { dispatchWebhook } from './webhook';
import { createLogger } from './utils/logger';

const log = createLogger('kill-switch');

const PAUSED_STATE_KEY = 'paused';

let _paused: boolean | null = null;
let _syncTimer: ReturnType<typeof setInterval> | undefined;

function loadInitialState(): boolean {
  if (config.PAUSED) return true;
  try {
    // Synchronous, local read (loadAgentState) — correct for the common
    // single-instance/SQLite case and for the restart-survival guarantee.
    // A multi-instance deployment sharing Postgres gets the authoritative
    // value shortly after, from startKillSwitchSync's first poll.
    return loadAgentState(PAUSED_STATE_KEY) === 'true';
  } catch (err) {
    log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      'Could not read persisted paused state — assuming not paused'
    );
    return false;
  }
}

function setPaused(paused: boolean, reason?: string): void {
  _paused = paused;
  // Fire-and-forget: writes through the configured Storage backend so a
  // Postgres deployment's shared state actually changes (previously this
  // wrote only to the local SQLite side-file, regardless of STORAGE_BACKEND).
  // The local cache above already reflects the change synchronously, so a
  // slow or failed write never delays this instance's own pause/resume.
  getStorage()
    .saveAgentState(PAUSED_STATE_KEY, String(paused))
    .catch((err) => {
      log.error(
        { paused, error: err instanceof Error ? err.message : String(err) },
        'Failed to persist paused state'
      );
    });
  log.warn({ paused, reason }, paused ? 'Agent paused' : 'Agent resumed');
  void dispatchWebhook({
    event: paused ? 'agent.paused' : 'agent.resumed',
    paused,
    ...(reason ? { reason } : {}),
    timestamp: new Date().toISOString(),
  });
}

/** True while value-moving tasks are halted. */
export function isPaused(): boolean {
  if (_paused === null) _paused = loadInitialState();
  return _paused;
}

/** Halt value-moving tasks. No-op (no event) when already paused. */
export function pauseAgent(reason?: string): void {
  if (isPaused()) return;
  setPaused(true, reason);
}

/** Resume value-moving tasks. No-op (no event) when not paused. */
export function resumeAgent(reason?: string): void {
  if (!isPaused()) return;
  setPaused(false, reason);
}

/**
 * Re-read the paused state from the shared storage backend and update the
 * local cache when it disagrees — how a pause/resume issued on another
 * instance reaches this one (#960).
 */
async function syncFromSharedStorage(): Promise<void> {
  try {
    const stored = await getStorage().loadAgentState(PAUSED_STATE_KEY);
    const remotePaused = stored === 'true';
    if (_paused !== null && remotePaused !== _paused) {
      log.warn(
        { paused: remotePaused },
        remotePaused
          ? 'Agent paused (synced from shared storage)'
          : 'Agent resumed (synced from shared storage)'
      );
    }
    _paused = remotePaused;
  } catch (err) {
    log.warn(
      { error: err instanceof Error ? err.message : String(err) },
      'Could not sync paused state from shared storage'
    );
  }
}

/**
 * Start polling the shared storage backend for the paused state on
 * KILL_SWITCH_SYNC_INTERVAL_MS, so a pause/resume issued on another instance
 * reaches this one within that bound. Returns a stop function.
 */
export function startKillSwitchSync(
  intervalMs: number = config.KILL_SWITCH_SYNC_INTERVAL_MS
): () => void {
  if (_syncTimer) clearInterval(_syncTimer);
  _syncTimer = setInterval(() => void syncFromSharedStorage(), intervalMs);
  return () => {
    if (_syncTimer) {
      clearInterval(_syncTimer);
      _syncTimer = undefined;
    }
  };
}

/** Drop the cached state so the next read reloads it — used in tests. */
export function _resetKillSwitch(): void {
  _paused = null;
  if (_syncTimer) {
    clearInterval(_syncTimer);
    _syncTimer = undefined;
  }
}
