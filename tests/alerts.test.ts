/**
 * tests/alerts.test.ts
 *
 * Closes #824 — spending-threshold alerts fire once per window, repeated
 * failures and an opening RPC breaker notify, and notifier failures never
 * propagate.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import axios from 'axios';

vi.mock('../backend/config', () => ({
  config: {
    SPENDING_WINDOW_MS: 60_000,
    AGENT_SPENDING_LIMIT: '100',
  },
}));

// Persistence is irrelevant here; keep the tracker in memory only.
vi.mock('../backend/persistence', () => ({
  loadSpendingRecords: vi.fn(() => []),
  saveSpendingRecord: vi.fn(),
  pruneSpendingRecords: vi.fn(),
  clearSpendingRecords: vi.fn(),
}));

import {
  AlertEvent,
  Notifier,
  registerNotifier,
  clearNotifiers,
  emitAlert,
  SpendingAlertMonitor,
  FailureAlertMonitor,
  alertBreakerOpen,
  spendingAlerts,
  SlackNotifier,
  DiscordNotifier,
  WebhookNotifier,
  EmailNotifier,
} from '../backend/alerts';
import { SpendingTracker } from '../backend/spending_tracker';

const WINDOW_MS = 60_000;

let received: AlertEvent[];

const capture: Notifier = {
  name: 'capture',
  notify: async (event) => {
    received.push(event);
  },
};

beforeEach(() => {
  received = [];
  clearNotifiers();
  registerNotifier(capture);
  spendingAlerts.reset();
});

afterEach(() => {
  clearNotifiers();
});

// Notifiers are invoked synchronously by emitAlert(); awaiting a microtask is
// enough to let their (async) bodies settle. setImmediate would stall under
// the fake timers some tests install.
const flush = () => Promise.resolve();

describe('SpendingAlertMonitor', () => {
  it('fires the 80% alert once, however many spends land above it', () => {
    const monitor = new SpendingAlertMonitor([0.8, 1]);

    expect(monitor.check(85, 100, WINDOW_MS)).toHaveLength(1);
    expect(monitor.check(90, 100, WINDOW_MS)).toHaveLength(0);
    expect(monitor.check(95, 100, WINDOW_MS)).toHaveLength(0);
  });

  it('fires the 100% alert once, separately from the 80% one', () => {
    const monitor = new SpendingAlertMonitor([0.8, 1]);

    const first = monitor.check(85, 100, WINDOW_MS);
    const second = monitor.check(100, 100, WINDOW_MS);
    const third = monitor.check(120, 100, WINDOW_MS);

    expect(first.map((e) => e.details.thresholdPercent)).toEqual([80]);
    expect(second.map((e) => e.details.thresholdPercent)).toEqual([100]);
    expect(second[0]!.severity).toBe('critical');
    expect(third).toHaveLength(0);
  });

  it('fires both thresholds at once when a single spend jumps past both', () => {
    const monitor = new SpendingAlertMonitor([0.8, 1]);
    const raised = monitor.check(100, 100, WINDOW_MS);
    expect(raised.map((e) => e.details.thresholdPercent)).toEqual([80, 100]);
  });

  it('re-arms once the window drains back below the threshold', () => {
    const monitor = new SpendingAlertMonitor([0.8, 1]);

    expect(monitor.check(85, 100, WINDOW_MS)).toHaveLength(1);
    // Window rolled over: the old spends aged out.
    expect(monitor.check(10, 100, WINDOW_MS)).toHaveLength(0);
    expect(monitor.check(82, 100, WINDOW_MS)).toHaveLength(1);
  });

  it('dispatches raised alerts to registered notifiers', async () => {
    new SpendingAlertMonitor([0.8]).check(85, 100, WINDOW_MS);
    await flush();

    expect(received).toHaveLength(1);
    expect(received[0]!.type).toBe('spending_threshold');
  });

  it('ignores a non-positive or non-numeric limit', () => {
    const monitor = new SpendingAlertMonitor([0.8, 1]);
    expect(monitor.check(85, 0, WINDOW_MS)).toHaveLength(0);
    expect(monitor.check(NaN, 100, WINDOW_MS)).toHaveLength(0);
  });
});

describe('SpendingTracker alerting', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('alerts at 80% and 100% exactly once per window', async () => {
    const tracker = new SpendingTracker(WINDOW_MS);

    tracker.record('50');
    tracker.record('35'); // 85% → 80% alert
    tracker.record('5'); // 90% → nothing new
    tracker.record('10'); // 100% → limit alert
    expect(() => tracker.record('1')).toThrow(/exceeds limit/); // nothing new
    await flush();

    const percents = received
      .filter((e) => e.type === 'spending_threshold')
      .map((e) => e.details.thresholdPercent);
    expect(percents).toEqual([80, 100]);
  });

  it('alerts again in the next window', async () => {
    const tracker = new SpendingTracker(WINDOW_MS);

    tracker.record('85');
    vi.advanceTimersByTime(WINDOW_MS + 1);
    tracker.record('85');
    await flush();

    expect(received.filter((e) => e.details.thresholdPercent === 80)).toHaveLength(2);
  });

  it('raises the 100% alert when a spend is rejected for breaching the limit', async () => {
    const tracker = new SpendingTracker(WINDOW_MS);

    tracker.record('70');
    expect(() => tracker.reserve('40')).toThrow(/exceeds limit/);
    await flush();

    expect(received.map((e) => e.details.thresholdPercent)).toEqual([80, 100]);
    expect(tracker.total()).toBe(70);
  });

  it('counts committed reservations toward the thresholds', async () => {
    const tracker = new SpendingTracker(WINDOW_MS);

    const id = tracker.reserve('90');
    expect(received).toHaveLength(0);
    tracker.commit(id);
    await flush();

    expect(received.map((e) => e.details.thresholdPercent)).toEqual([80]);
  });
});

describe('FailureAlertMonitor', () => {
  it('alerts once when the consecutive-failure threshold is reached', () => {
    const monitor = new FailureAlertMonitor(3, 60_000);

    expect(monitor.recordFailure('stellar_payment', 0)).toBeNull();
    expect(monitor.recordFailure('stellar_payment', 1)).toBeNull();
    const event = monitor.recordFailure('x402_respond', 2);
    expect(event?.type).toBe('repeated_failures');
    expect(event?.details.taskTypes).toBe('stellar_payment,x402_respond');
    expect(monitor.recordFailure('stellar_payment', 3)).toBeNull();
  });

  it('re-arms after a success', () => {
    const monitor = new FailureAlertMonitor(2, 60_000);

    monitor.recordFailure('swap', 0);
    expect(monitor.recordFailure('swap', 1)).not.toBeNull();
    monitor.recordSuccess();
    monitor.recordFailure('swap', 2);
    expect(monitor.recordFailure('swap', 3)).not.toBeNull();
  });

  it('ignores failures that fall outside the window', () => {
    const monitor = new FailureAlertMonitor(2, 1_000);

    monitor.recordFailure('swap', 0);
    expect(monitor.recordFailure('swap', 5_000)).toBeNull();
  });
});

describe('breaker-open alert', () => {
  it('notifies with the circuit name and stats', async () => {
    const event = alertBreakerOpen('horizon', { failures: 7, successes: 2 });
    await flush();

    expect(event.type).toBe('breaker_open');
    expect(event.severity).toBe('critical');
    expect(received).toHaveLength(1);
    expect(received[0]!.details).toEqual({ circuit: 'horizon', failures: 7, successes: 2 });
  });
});

describe('notifier delivery', () => {
  it('a failing notifier does not stop the others or throw', async () => {
    registerNotifier({
      name: 'broken',
      notify: async () => {
        throw new Error('down');
      },
    });
    const event: AlertEvent = {
      type: 'breaker_open',
      severity: 'critical',
      message: 'test',
      details: {},
      timestamp: new Date().toISOString(),
    };

    await expect(emitAlert(event)).resolves.toBeUndefined();
    expect(received).toHaveLength(1);
  });

  it('Slack, Discord and webhook notifiers post the expected bodies', async () => {
    const post = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200 });
    const event: AlertEvent = {
      type: 'breaker_open',
      severity: 'critical',
      message: 'RPC circuit "horizon" opened',
      details: { circuit: 'horizon' },
      timestamp: new Date().toISOString(),
    };

    await new SlackNotifier('https://slack.example/hook').notify(event);
    await new DiscordNotifier('https://discord.example/hook').notify(event);
    await new WebhookNotifier('https://alerts.example/hook').notify(event);

    expect(post.mock.calls[0]![0]).toBe('https://slack.example/hook');
    expect((post.mock.calls[0]![1] as { text: string }).text).toContain('horizon');
    expect((post.mock.calls[1]![1] as { content: string }).content).toContain('horizon');
    expect(post.mock.calls[2]![1]).toEqual(event);
  });

  it('EmailNotifier hands a subject and body to the supplied transport', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    await new EmailNotifier(send).notify({
      type: 'spending_threshold',
      severity: 'warning',
      message: 'Approaching spending limit (80% of limit)',
      details: { thresholdPercent: 80 },
      timestamp: new Date().toISOString(),
    });

    expect(send).toHaveBeenCalledWith({
      subject: '[Nodal AI] WARNING: spending_threshold',
      text: expect.stringContaining('Approaching spending limit'),
    });
  });
});
