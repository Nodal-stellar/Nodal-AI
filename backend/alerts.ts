/**
 * backend/alerts.ts
 *
 * Alerting hooks (#824). The spending tracker used to log "Approaching
 * spending limit" at 80% and nothing else, so nobody was actually told. This
 * module turns the conditions an operator needs to act on into alert events
 * and routes them to pluggable notifiers (generic webhook, Slack, Discord,
 * email, or anything implementing {@link Notifier}).
 *
 * Alert types:
 *   - `spending_threshold` — cumulative spend crossed a configured fraction of
 *     AGENT_SPENDING_LIMIT (80% and 100% by default). Each threshold fires once
 *     per spending window: it re-arms only after the rolling window drains back
 *     below it.
 *   - `repeated_failures`  — N consecutive task failures within a time window.
 *     Fires once per streak; a successful task re-arms it.
 *   - `breaker_open`       — an RPC circuit breaker tripped open.
 *
 * Configuration (all optional, read from the environment):
 *   ALERT_WEBHOOK_URL           generic JSON webhook receiving the raw event
 *   ALERT_SLACK_WEBHOOK_URL     Slack incoming-webhook URL
 *   ALERT_DISCORD_WEBHOOK_URL   Discord webhook URL
 *   ALERT_SPENDING_THRESHOLDS   comma-separated fractions of the limit (default "0.8,1")
 *   ALERT_FAILURE_THRESHOLD     consecutive failures before alerting (default 5)
 *   ALERT_FAILURE_WINDOW_MS     window the failures must fall within (default 300000)
 *
 * Email has no built-in transport (that would mean a new dependency): register
 * an {@link EmailNotifier} with your own `send` function.
 *
 * Delivery is fire-and-forget: a notifier that throws or times out is logged
 * and never affects the payment or task that triggered the alert.
 */

import axios from 'axios';
import { createLogger } from './utils/logger';

const log = createLogger('alerts');

// ─── Event model ──────────────────────────────────────────────────────────────

export type AlertType = 'spending_threshold' | 'repeated_failures' | 'breaker_open';
export type AlertSeverity = 'warning' | 'critical';

export interface AlertEvent {
  type: AlertType;
  severity: AlertSeverity;
  message: string;
  /** Structured context for the alert. Never contains secrets. */
  details: Record<string, string | number | boolean>;
  /** ISO-8601 time the alert was raised. */
  timestamp: string;
}

/** A destination for alert events. */
export interface Notifier {
  readonly name: string;
  notify(event: AlertEvent): Promise<void>;
}

// ─── Built-in notifiers ──────────────────────────────────────────────────────

const NOTIFIER_TIMEOUT_MS = 5_000;

function formatText(event: AlertEvent): string {
  const icon = event.severity === 'critical' ? '🚨' : '⚠️';
  const details = Object.entries(event.details)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  return `${icon} [Nodal AI] ${event.message}${details ? ` (${details})` : ''}`;
}

/** POSTs the raw {@link AlertEvent} as JSON to an arbitrary URL. */
export class WebhookNotifier implements Notifier {
  readonly name = 'webhook';
  constructor(private readonly url: string) {}

  async notify(event: AlertEvent): Promise<void> {
    await axios.post(this.url, event, { timeout: NOTIFIER_TIMEOUT_MS });
  }
}

/** Posts a formatted message to a Slack incoming webhook. */
export class SlackNotifier implements Notifier {
  readonly name = 'slack';
  constructor(private readonly webhookUrl: string) {}

  async notify(event: AlertEvent): Promise<void> {
    await axios.post(this.webhookUrl, { text: formatText(event) }, { timeout: NOTIFIER_TIMEOUT_MS });
  }
}

/** Posts a formatted message to a Discord webhook. */
export class DiscordNotifier implements Notifier {
  readonly name = 'discord';
  constructor(private readonly webhookUrl: string) {}

  async notify(event: AlertEvent): Promise<void> {
    await axios.post(
      this.webhookUrl,
      { content: formatText(event) },
      { timeout: NOTIFIER_TIMEOUT_MS }
    );
  }
}

export interface EmailMessage {
  subject: string;
  text: string;
}

/**
 * Sends alerts by email through a caller-supplied transport (e.g. a nodemailer
 * or SES wrapper), so the kit does not take a mail dependency.
 */
export class EmailNotifier implements Notifier {
  readonly name = 'email';
  constructor(private readonly send: (message: EmailMessage) => Promise<void>) {}

  async notify(event: AlertEvent): Promise<void> {
    await this.send({
      subject: `[Nodal AI] ${event.severity.toUpperCase()}: ${event.type}`,
      text: formatText(event),
    });
  }
}

// ─── Registry & dispatch ─────────────────────────────────────────────────────

const notifiers: Notifier[] = [];
let envNotifiersLoaded = false;

/** Add a notifier. All registered notifiers receive every alert. */
export function registerNotifier(notifier: Notifier): void {
  notifiers.push(notifier);
}

/** Remove every registered notifier (including the env-configured ones). */
export function clearNotifiers(): void {
  notifiers.length = 0;
  envNotifiersLoaded = true;
}

/** Register the notifiers configured through ALERT_* env vars, once. */
function loadEnvNotifiers(): void {
  if (envNotifiersLoaded) return;
  envNotifiersLoaded = true;
  const { ALERT_WEBHOOK_URL, ALERT_SLACK_WEBHOOK_URL, ALERT_DISCORD_WEBHOOK_URL } = process.env;
  if (ALERT_WEBHOOK_URL) notifiers.push(new WebhookNotifier(ALERT_WEBHOOK_URL));
  if (ALERT_SLACK_WEBHOOK_URL) notifiers.push(new SlackNotifier(ALERT_SLACK_WEBHOOK_URL));
  if (ALERT_DISCORD_WEBHOOK_URL) notifiers.push(new DiscordNotifier(ALERT_DISCORD_WEBHOOK_URL));
}

/**
 * Deliver an alert to every registered notifier. Resolves once all deliveries
 * have settled; individual notifier failures are logged, never thrown.
 */
export async function emitAlert(event: AlertEvent): Promise<void> {
  loadEnvNotifiers();
  log.warn({ alert: event.type, severity: event.severity, ...event.details }, event.message);
  const results = await Promise.allSettled(notifiers.map((n) => n.notify(event)));
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      log.error(
        { notifier: notifiers[i]?.name, error: String(r.reason) },
        'Alert notifier failed'
      );
    }
  });
}

function buildEvent(
  type: AlertType,
  severity: AlertSeverity,
  message: string,
  details: AlertEvent['details']
): AlertEvent {
  return { type, severity, message, details, timestamp: new Date().toISOString() };
}

// ─── Thresholds ──────────────────────────────────────────────────────────────

function parseThresholds(raw: string | undefined): number[] {
  const parsed = (raw ?? '0.8,1')
    .split(',')
    .map((s) => parseFloat(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  return [...new Set(parsed)].sort((a, b) => a - b);
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = raw === undefined ? NaN : parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// ─── Spending threshold alerts ───────────────────────────────────────────────

/**
 * Tracks which spending thresholds have already fired so each one alerts once
 * per window. A threshold re-arms when the rolling total drops back below it,
 * i.e. once the spends that crossed it have aged out of the window.
 */
export class SpendingAlertMonitor {
  private readonly thresholds: number[];
  private readonly fired = new Set<number>();

  constructor(thresholds: number[] = parseThresholds(process.env.ALERT_SPENDING_THRESHOLDS)) {
    this.thresholds = thresholds;
  }

  /**
   * Evaluate the current window total against the limit.
   *
   * @param total     - cumulative spend in the active window (including any
   *                    attempted amount that was rejected for breaching the limit)
   * @param limit     - AGENT_SPENDING_LIMIT
   * @param windowMs  - window length, included in the alert for context
   * @returns the alerts raised by this call (already dispatched)
   */
  check(total: number, limit: number, windowMs: number): AlertEvent[] {
    if (!Number.isFinite(total) || !Number.isFinite(limit) || limit <= 0) return [];
    const raised: AlertEvent[] = [];
    for (const threshold of this.thresholds) {
      const reached = total >= limit * threshold;
      if (!reached) {
        this.fired.delete(threshold);
        continue;
      }
      if (this.fired.has(threshold)) continue;
      this.fired.add(threshold);
      const percent = Math.round(threshold * 100);
      const event = buildEvent(
        'spending_threshold',
        threshold >= 1 ? 'critical' : 'warning',
        threshold >= 1
          ? `Spending limit reached (${percent}% of limit)`
          : `Approaching spending limit (${percent}% of limit)`,
        {
          thresholdPercent: percent,
          total,
          limit,
          percent: Number(((total / limit) * 100).toFixed(1)),
          windowMs,
        }
      );
      raised.push(event);
      void emitAlert(event);
    }
    return raised;
  }

  /** Re-arm every threshold (used when the spending window is cleared). */
  reset(): void {
    this.fired.clear();
  }
}

// ─── Repeated failure alerts ─────────────────────────────────────────────────

/**
 * Raises one alert when `threshold` consecutive task failures land within
 * `windowMs`. A success (or the failures ageing out) re-arms it.
 */
export class FailureAlertMonitor {
  private failures: { taskType: string; timestamp: number }[] = [];
  private alerted = false;

  constructor(
    private readonly threshold: number = parsePositiveInt(process.env.ALERT_FAILURE_THRESHOLD, 5),
    private readonly windowMs: number = parsePositiveInt(
      process.env.ALERT_FAILURE_WINDOW_MS,
      300_000
    )
  ) {}

  recordFailure(taskType: string, now: number = Date.now()): AlertEvent | null {
    this.failures = this.failures.filter((f) => f.timestamp >= now - this.windowMs);
    this.failures.push({ taskType, timestamp: now });
    if (this.failures.length < this.threshold) {
      this.alerted = false;
      return null;
    }
    if (this.alerted) return null;
    this.alerted = true;
    const taskTypes = [...new Set(this.failures.map((f) => f.taskType))].join(',');
    const event = buildEvent(
      'repeated_failures',
      'critical',
      `${this.failures.length} consecutive task failures`,
      { failures: this.failures.length, windowMs: this.windowMs, taskTypes }
    );
    void emitAlert(event);
    return event;
  }

  recordSuccess(): void {
    this.failures = [];
    this.alerted = false;
  }
}

// ─── Circuit breaker alerts ──────────────────────────────────────────────────

/** Raise a `breaker_open` alert for the named RPC circuit. */
export function alertBreakerOpen(
  circuit: string,
  stats: { failures: number; successes: number }
): AlertEvent {
  const event = buildEvent('breaker_open', 'critical', `RPC circuit "${circuit}" opened`, {
    circuit,
    failures: stats.failures,
    successes: stats.successes,
  });
  void emitAlert(event);
  return event;
}

// ─── Process-wide monitors ───────────────────────────────────────────────────

/** Singleton used by the spending tracker. */
export const spendingAlerts = new SpendingAlertMonitor();

/** Singleton used by the agent orchestrator. */
export const failureAlerts = new FailureAlertMonitor();
