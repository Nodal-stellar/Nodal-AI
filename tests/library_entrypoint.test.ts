/**
 * tests/library_entrypoint.test.ts
 *
 * Issue #833: `backend/index.ts` is the library entry point, so importing it
 * must not boot the process. Before the fix it called `start()` at import
 * time, which awaited config, migrated the database, initialised telemetry,
 * constructed the agent, opened the health server and installed SIGTERM/SIGINT
 * handlers on whatever process happened to import it — which is also why the
 * `agent` it exported was always `undefined` at import time.
 *
 * Strategy: mock the same dependency set `tests/shutdown.test.ts` mocks, so the
 * import can never open a real socket or database handle, then assert that
 * importing the entry point leaves every one of them untouched while still
 * exposing the public API. The process-startup behaviour the old file had is
 * covered by `tests/shutdown.test.ts`, which now imports `backend/main.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const started = vi.hoisted(() => ({
  agentConstructor: 0,
  healthServer: 0,
  migrate: 0,
  initTelemetry: 0,
}));

vi.mock('../backend/agent', () => ({
  PayFiAgent: vi.fn(function (this: any) {
    started.agentConstructor++;
    this.drain = vi.fn();
    this.waitForPendingTasks = vi.fn(async () => {});
  }),
}));

vi.mock('../backend/server', () => ({
  startHealthServer: vi.fn(() => {
    started.healthServer++;
    return { close: (cb: (err?: Error) => void) => cb() };
  }),
}));

vi.mock('../backend/db/client', () => ({
  db: {
    migrate: vi.fn(async () => {
      started.migrate++;
    }),
    close: vi.fn(async () => {}),
  },
}));

vi.mock('../backend/telemetry', () => ({
  initTelemetry: vi.fn(() => {
    started.initTelemetry++;
  }),
  shutdownTelemetry: vi.fn(async () => {}),
}));

vi.mock('../backend/config', () => ({
  configPromise: Promise.resolve({}),
}));

vi.mock('../backend/utils/logger', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn() })),
}));

describe('backend/index.ts is a side-effect-free library entry point', () => {
  let signalHandlers: string[];
  let exitSpy: any;

  /** Import the entry point, then let any queued microtasks/timers run. */
  async function importLibrary(): Promise<unknown> {
    const mod = await import('../backend/index');
    await new Promise((resolve) => setTimeout(resolve, 50));
    return mod;
  }

  beforeEach(() => {
    vi.resetModules();
    started.agentConstructor = 0;
    started.healthServer = 0;
    started.migrate = 0;
    started.initTelemetry = 0;

    signalHandlers = [];
    vi.spyOn(process, 'on').mockImplementation(((event: string) => {
      signalHandlers.push(event);
      return process;
    }) as any);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts no health server, runs no migration, builds no telemetry and constructs no agent', async () => {
    await importLibrary();

    expect(started.healthServer).toBe(0);
    expect(started.migrate).toBe(0);
    expect(started.initTelemetry).toBe(0);
    expect(started.agentConstructor).toBe(0);
  });

  it('installs no signal handlers and never exits the importing process', async () => {
    await importLibrary();

    expect(signalHandlers).not.toContain('SIGTERM');
    expect(signalHandlers).not.toContain('SIGINT');
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('still exports the agent class', async () => {
    const mod: any = await importLibrary();

    expect(typeof mod.PayFiAgent).toBe('function');
  });

  it('stays inert when imported more than once', async () => {
    await importLibrary();
    await importLibrary();

    expect(started.healthServer).toBe(0);
    expect(signalHandlers).toEqual([]);
  });
});
