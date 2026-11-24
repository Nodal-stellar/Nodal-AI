/**
 * tests/kill_switch.test.ts
 * Tests for the global kill switch (#743): PAUSED env flag, persistence across
 * restarts, and pause/resume webhook events. Also #960: pause/resume writes
 * through the shared Storage backend and startKillSwitchSync polls it, so a
 * pause issued on one instance reaches another sharing the same store.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { _setDb, loadAgentState } from '../backend/persistence';
import { dispatchWebhook } from '../backend/webhook';
import {
  _resetKillSwitch,
  isPaused,
  pauseAgent,
  resumeAgent,
  startKillSwitchSync,
} from '../backend/kill_switch';

vi.mock('../backend/config', () => ({
  config: {
    get PAUSED() {
      return (globalThis as any).__pausedEnv ?? false;
    },
    KILL_SWITCH_SYNC_INTERVAL_MS: 2_000,
  },
}));

vi.mock('../backend/webhook', () => ({
  dispatchWebhook: vi.fn().mockResolvedValue(undefined),
}));

describe('kill switch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (globalThis as any).__pausedEnv = undefined;
    _setDb(new Database(':memory:'));
    _resetKillSwitch();
  });

  afterEach(() => {
    _setDb(null);
  });

  it('is not paused by default', () => {
    expect(isPaused()).toBe(false);
  });

  it('starts paused when PAUSED=true', () => {
    (globalThis as any).__pausedEnv = true;
    expect(isPaused()).toBe(true);
  });

  it('pauses and resumes', () => {
    pauseAgent();
    expect(isPaused()).toBe(true);
    resumeAgent();
    expect(isPaused()).toBe(false);
  });

  it('persists the paused state across a restart', () => {
    pauseAgent();
    expect(loadAgentState('paused')).toBe('true');

    // Simulate a process restart: drop the in-memory state, keep the DB.
    _resetKillSwitch();
    expect(isPaused()).toBe(true);

    resumeAgent();
    _resetKillSwitch();
    expect(isPaused()).toBe(false);
  });

  it('emits an agent.paused webhook event on pause', () => {
    pauseAgent('incident #42');

    expect(dispatchWebhook).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dispatchWebhook).mock.calls[0]![0]).toMatchObject({
      event: 'agent.paused',
      paused: true,
      reason: 'incident #42',
    });
  });

  it('emits an agent.resumed webhook event on resume', () => {
    pauseAgent();
    vi.mocked(dispatchWebhook).mockClear();

    resumeAgent();

    expect(dispatchWebhook).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dispatchWebhook).mock.calls[0]![0]).toMatchObject({
      event: 'agent.resumed',
      paused: false,
    });
  });

  it('does not emit duplicate events when the state does not change', () => {
    resumeAgent();
    pauseAgent();
    pauseAgent();

    expect(dispatchWebhook).toHaveBeenCalledTimes(1);
  });
});

// ── #960: multi-instance sync via the shared storage backend ────────────────

describe('kill switch — multi-instance sync (#960)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    (globalThis as any).__pausedEnv = undefined;
    _setDb(new Database(':memory:'));
    _resetKillSwitch();
  });

  afterEach(() => {
    _resetKillSwitch();
    _setDb(null);
    vi.useRealTimers();
  });

  it('pauseAgent() writes the paused state to the shared storage backend', async () => {
    pauseAgent();

    // Give the fire-and-forget storage write (a resolved Promise, no real
    // async work for SQLite) a tick to settle.
    await Promise.resolve();

    expect(loadAgentState('paused')).toBe('true');
  });

  it("picks up another instance's pause within KILL_SWITCH_SYNC_INTERVAL_MS", async () => {
    // Instance A: not paused yet, matching this instance's own cache.
    expect(isPaused()).toBe(false);

    // Instance B pauses — writes straight to the shared store, bypassing
    // instance A's in-memory cache entirely (as a separate process would).
    const { saveAgentState } = await import('../backend/persistence');
    saveAgentState('paused', 'true');

    // Instance A hasn't polled yet — still sees its own stale cache.
    expect(isPaused()).toBe(false);

    const stop = startKillSwitchSync(2_000);
    await vi.advanceTimersByTimeAsync(2_000);

    // Within one sync interval, instance A's cache now reflects the pause.
    expect(isPaused()).toBe(true);

    stop();
  });

  it("picks up another instance's resume within KILL_SWITCH_SYNC_INTERVAL_MS", async () => {
    pauseAgent();
    await Promise.resolve();
    expect(isPaused()).toBe(true);

    // Instance B resumes — writes straight to the shared store.
    const { saveAgentState } = await import('../backend/persistence');
    saveAgentState('paused', 'false');

    // Instance A hasn't polled yet — still sees its own stale "paused" cache.
    expect(isPaused()).toBe(true);

    const stop = startKillSwitchSync(2_000);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(isPaused()).toBe(false);
    stop();
  });

  it('startKillSwitchSync stop() halts further polling', async () => {
    expect(isPaused()).toBe(false); // caches the initial state

    const stop = startKillSwitchSync(1_000);
    stop();

    const { saveAgentState } = await import('../backend/persistence');
    saveAgentState('paused', 'true');

    await vi.advanceTimersByTimeAsync(10_000);

    // No poll ran after stop(), so the cache never picked up the write.
    expect(isPaused()).toBe(false);
  });
});
