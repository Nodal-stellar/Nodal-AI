/**
 * backend/webhook.ts
 * Fire-and-forget webhook dispatcher called after every agent task.
 * Signs the payload with HMAC-SHA256 if WEBHOOK_SECRET is set.
 *
 * Signature scheme: X-Nodal-Signature = hex(HMAC-SHA256(secret, `${timestamp}.${body}`)),
 * where `timestamp` is the Unix-seconds value sent in X-Nodal-Timestamp. Receivers
 * should reject timestamps outside a tolerance window and dedupe on X-Nodal-Delivery-Id.
 * Setting WEBHOOK_LEGACY_SIGNATURE=true keeps the old body-only signature for one release.
 *
 * Durability (#803): every outgoing webhook is first written to the `webhook_outbox`
 * SQLite table. A background worker retries PENDING rows with exponential backoff +
 * jitter and moves rows to DEAD after MAX_WEBHOOK_ATTEMPTS failures. A restart picks
 * up exactly where the previous process left off — nothing is lost in memory.
 */

import crypto, { createHmac } from 'crypto';
import axios from 'axios';
import { config } from './config';
import { AgentResult } from './agent';
import { createLogger } from './utils/logger';
import { handleRateLimitResponse } from './network';
import {
  enqueueWebhook,
  pendingWebhooks,
  markWebhookDelivered,
  markWebhookFailed,
} from './persistence';

const log = createLogger('webhook');

export function signPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export const DEFAULT_WEBHOOK_TOLERANCE_SEC = 300;

export function signWebhookPayload(
  timestamp: number | string,
  payload: string,
  secret: string
): string {
  return signPayload(`${timestamp}.${payload}`, secret);
}

export interface VerifyWebhookOptions {
  /** Value of the X-Nodal-Timestamp header (Unix seconds). Omit only for legacy body-only signatures. */
  timestamp?: number | string;
  /** Maximum allowed clock skew between sender and receiver, in seconds. Defaults to 300. */
  toleranceSec?: number;
  /** Current time in Unix seconds — overridable for tests. */
  nowSec?: number;
}

export function verifyWebhookSignature(
  payload: string,
  sig: string,
  secret: string,
  options: VerifyWebhookOptions = {}
): boolean {
  if (typeof sig !== 'string' || !/^[0-9a-fA-F]{64}$/.test(sig)) return false;
  const { timestamp, toleranceSec = DEFAULT_WEBHOOK_TOLERANCE_SEC } = options;
  let signed: string;
  if (timestamp === undefined) {
    // Legacy body-only signature (WEBHOOK_LEGACY_SIGNATURE) — no replay protection.
    signed = signPayload(payload, secret);
  } else {
    const ts = Number(timestamp);
    if (!Number.isInteger(ts)) return false;
    const nowSec = options.nowSec ?? Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - ts) > toleranceSec) return false;
    signed = signWebhookPayload(ts, payload, secret);
  }
  const expected = Buffer.from(signed, 'hex');
  const received = Buffer.from(sig, 'hex');
  if (expected.length !== received.length) return false;
  return crypto.timingSafeEqual(expected, received);
}

interface HttpResponseLike {
  status?: number;
  headers?: Record<string, string>;
}

interface HttpErrorLike {
  status?: number;
  response?: HttpResponseLike;
}

export function isRetryableWebhookError(errOrStatus: unknown): boolean {
  let status: number | undefined;
  if (typeof errOrStatus === 'number') {
    status = errOrStatus;
  } else if (errOrStatus && typeof errOrStatus === 'object') {
    const httpErr = errOrStatus as HttpErrorLike;
    status = httpErr.response?.status ?? httpErr.status;
  }

  if (status !== undefined) {
    if (status >= 200 && status < 300) return false;
    if (status === 429) return true;
    if (status >= 400 && status < 500) return false;
    if (status >= 500 && status < 600) return true;
  }
  // Connection errors, network drops, or unclassified errors default to retryable
  return true;
}

/** Operator-state event (kill switch) delivered through the same webhook as task results. */
export interface AgentStateEvent {
  event: 'agent.paused' | 'agent.resumed';
  paused: boolean;
  reason?: string;
  timestamp: string;
}

export interface WebhookDispatchOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
}

// ─── Outbox worker (#803) ─────────────────────────────────────────────────────

/** Maximum delivery attempts before a row is moved to dead-letter. */
export const MAX_WEBHOOK_ATTEMPTS = 8;

/** Axios request timeout in milliseconds (#803 — previously unbounded). */
export const WEBHOOK_REQUEST_TIMEOUT_MS = 10_000;

/** How often the background worker polls for due PENDING rows. */
const WORKER_POLL_MS = 5_000;

/** Jitter factor: actual delay = baseDelay * uniform(1 - JITTER, 1 + JITTER). */
const JITTER = 0.2;

function withJitter(delayMs: number): number {
  const factor = 1 - JITTER + Math.random() * JITTER * 2;
  return Math.round(delayMs * factor);
}

/** Compute the next retry timestamp (ms) for a given attempt number (1-based). */
export function nextRetryDelayMs(attempt: number, initialDelayMs = 1_000): number {
  const base = initialDelayMs * Math.pow(2, attempt - 1);
  return withJitter(Math.min(base, 30_000));
}

/**
 * Build the signed HTTP headers for a webhook delivery.
 * The deliveryId is stable across retries so receivers can deduplicate.
 */
function buildHeaders(body: string, deliveryId: string): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Nodal-Timestamp': String(timestamp),
    'X-Nodal-Delivery-Id': deliveryId,
  };
  if (config.WEBHOOK_SECRET) {
    headers['X-Nodal-Signature'] = config.WEBHOOK_LEGACY_SIGNATURE
      ? signPayload(body, config.WEBHOOK_SECRET)
      : signWebhookPayload(timestamp, body, config.WEBHOOK_SECRET);
  }
  return headers;
}

/** Attempt one HTTP POST to the configured WEBHOOK_URL. Resolves on 2xx, throws otherwise. */
async function attemptDelivery(body: string, deliveryId: string): Promise<void> {
  if (!config.WEBHOOK_URL) return;
  const headers = buildHeaders(body, deliveryId);
  const response = await axios.post(config.WEBHOOK_URL, body, {
    headers,
    timeout: WEBHOOK_REQUEST_TIMEOUT_MS,
  });
  const status = response?.status;
  if (status !== undefined && (status < 200 || status >= 300)) {
    const err = Object.assign(new Error(`Webhook responded with status ${status}`), {
      status,
      response,
    });
    throw err;
  }
}

let _workerTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Process all PENDING webhook rows that are due for delivery.
 * Called on a recurring timer and also immediately after enqueuing a new row
 * so low-latency delivery is preserved when the process is healthy.
 */
export async function runWebhookWorker(): Promise<void> {
  if (!config.WEBHOOK_URL) return;

  const due = pendingWebhooks(Date.now());
  for (const row of due) {
    try {
      await attemptDelivery(row.payload, row.deliveryId);
      markWebhookDelivered(row.id);
      log.info({ deliveryId: row.deliveryId, attempts: row.attempts + 1 }, 'Webhook delivered');
    } catch (err) {
      const httpErr = (err && typeof err === 'object' ? err : {}) as HttpErrorLike;
      const status = httpErr.response?.status ?? httpErr.status;

      if (status === 429) {
        const retryAfter = httpErr.response?.headers?.['retry-after'];
        handleRateLimitResponse(retryAfter);
      }

      const nextAttempt = row.attempts + 1;
      const dead = !isRetryableWebhookError(err) || nextAttempt >= MAX_WEBHOOK_ATTEMPTS;
      const delay = dead ? 0 : nextRetryDelayMs(nextAttempt);
      const nextRetryAt = Date.now() + delay;
      const lastError = err instanceof Error ? err.message : String(err);

      markWebhookFailed(row.id, lastError, nextRetryAt, dead);

      if (dead) {
        log.warn(
          { deliveryId: row.deliveryId, attempts: nextAttempt, lastError },
          'Webhook dead-lettered after max attempts'
        );
      } else {
        log.warn(
          { deliveryId: row.deliveryId, attempts: nextAttempt, nextRetryAt, lastError },
          'Webhook delivery attempt failed — will retry'
        );
      }
    }
  }
}

/** Start the background outbox worker. Idempotent — safe to call multiple times. */
export function startWebhookWorker(): void {
  if (_workerTimer !== null) return;
  const tick = async () => {
    try {
      await runWebhookWorker();
    } catch (err) {
      log.error({ error: String(err) }, 'Webhook worker tick failed');
    } finally {
      _workerTimer = setTimeout(tick, WORKER_POLL_MS);
    }
  };
  _workerTimer = setTimeout(tick, WORKER_POLL_MS);
}

/** Stop the background outbox worker. */
export function stopWebhookWorker(): void {
  if (_workerTimer !== null) {
    clearTimeout(_workerTimer);
    _workerTimer = null;
  }
}

// ─── Public dispatch entry-point ──────────────────────────────────────────────

/**
 * Enqueue a webhook delivery to the durable outbox and kick off an immediate
 * delivery attempt. Crashes and restarts will not lose the notification because
 * the row is committed to SQLite before any network I/O happens.
 */
export async function dispatchWebhook(
  result: AgentResult | AgentStateEvent,
  _options?: WebhookDispatchOptions
): Promise<void> {
  if (!config.WEBHOOK_URL) return;

  const taskType = 'event' in result ? result.event : result.taskType;
  const body = JSON.stringify(result);
  const deliveryId = crypto.randomUUID();

  // Persist first — survives a crash before any delivery is attempted.
  enqueueWebhook(deliveryId, body);
  log.info({ taskType, deliveryId }, 'Webhook enqueued');

  // Attempt immediate delivery; the outbox worker will retry on failure.
  void runWebhookWorker();
}
