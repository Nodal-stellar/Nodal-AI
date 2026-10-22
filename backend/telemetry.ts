/**
 * backend/telemetry.ts
 *
 * Optional OpenTelemetry setup module.
 *
 * Reads config.OTLP_ENDPOINT — if set, initialises an OTLP trace/metric
 * exporter and instruments `withRetry` calls with trace spans.
 *
 * Task-level tracing (#823): `PayFiAgent.executeTask` opens an
 * `agent.executeTask` span and each tool call a `tool.<task_type>` child span,
 * so a slow payment can be followed end to end (task → tool → RPC calls).
 * Spans carry only {@link SPAN_ATTR} attributes — task type, correlation ID and
 * transaction hash — never amounts or account addresses. Because a transaction
 * hash can be looked up on-chain (revealing the amount and both parties), set
 * OTEL_REDACT_TX_HASH=true when traces are exported somewhere public.
 *
 * Called once from backend/main.ts at startup.
 */

import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { trace, Tracer, Span, SpanStatusCode, Attributes } from '@opentelemetry/api';
import { config } from './config';
import { createLogger } from './utils/logger';

const log = createLogger('telemetry');

const tracer: Tracer = trace.getTracer('stellar-agent-kit');
let sdk: NodeSDK | null = null;

/** Span attribute keys used for task- and tool-level spans (#823). */
export const SPAN_ATTR = {
  TASK_TYPE: 'nodal.task_type',
  CORRELATION_ID: 'nodal.correlation_id',
  TX_HASH: 'stellar.tx_hash',
} as const;

/**
 * Whether transaction hashes must be kept out of exported spans. A hash links a
 * trace to an on-chain transaction — and so to its amount and parties — which
 * must not leak into publicly visible traces.
 */
export function isTxHashRedacted(): boolean {
  return process.env.OTEL_REDACT_TX_HASH === 'true';
}

/**
 * Pull a transaction hash out of a tool result, if it has one. Tools report it
 * as `hash`, `txHash` or `transactionHash` depending on their origin.
 */
export function extractTxHash(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const record = data as Record<string, unknown>;
  for (const key of ['txHash', 'transactionHash', 'hash']) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Tag `span` with the transaction hash found in `data`, unless hashes are
 * redacted via OTEL_REDACT_TX_HASH.
 */
export function setTxHashAttribute(span: Span, data: unknown): void {
  if (isTxHashRedacted()) return;
  const hash = extractTxHash(data);
  if (hash) span.setAttribute(SPAN_ATTR.TX_HASH, hash);
}

/**
 * Initialise the OpenTelemetry SDK with OTLP HTTP exporters if
 * config.OTLP_ENDPOINT is defined.  Idempotent — subsequent calls
 * are no-ops.
 */
export function initTelemetry(): void {
  const otlpEndpoint: string | undefined = (config as unknown as Record<string, unknown>)
    .OTLP_ENDPOINT as string | undefined;
  if (!otlpEndpoint) {
    log.info('OTLP_ENDPOINT not configured, skipping OpenTelemetry initialisation');
    return;
  }

  if (sdk) {
    log.warn('initTelemetry called but SDK is already running');
    return;
  }

  const traceExporter = new OTLPTraceExporter({
    url: `${otlpEndpoint}/v1/traces`,
  });

  const metricReader = new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      url: `${otlpEndpoint}/v1/metrics`,
    }),
    exportIntervalMillis: 10_000,
  });

  sdk = new NodeSDK({
    traceExporter,
    metricReaders: [metricReader],
    serviceName: 'stellar-agent-kit',
  });

  sdk.start();
  log.info({ endpoint: otlpEndpoint }, 'OpenTelemetry initialised');
}

/**
 * Return the active tracer (no-op tracer when telemetry is disabled).
 */
export function getTracer(): Tracer {
  return tracer;
}

// Spans the wrapped function flagged as failed without throwing — withSpan()
// must not overwrite their ERROR status with OK once the function returns.
const erroredSpans = new WeakSet<Span>();

/**
 * Mark a span as failed when the operation reports failure through its return
 * value rather than by throwing (e.g. an `AgentResult` with `success: false`).
 */
export function markSpanError(span: Span, message: string): void {
  erroredSpans.add(span);
  span.setStatus({ code: SpanStatusCode.ERROR, message });
}

/**
 * Create a trace span wrapping an async operation.
 *
 * The span is made the *active* span while `fn` runs, so spans started inside
 * it (nested `withSpan` calls, auto-instrumented HTTP requests) become its
 * children and share its trace ID.
 *
 * @param name      - The span name (e.g. "withRetry")
 * @param fn        - The async function to instrument; receives the span so it
 *                    can add attributes discovered while running (e.g. a tx hash)
 * @param attrs     - Optional key-value attributes to set on the span
 * @returns         - The return value of `fn`
 */
export async function withSpan<T>(
  name: string,
  fn: (span: Span) => Promise<T>,
  attrs: Attributes = {}
): Promise<T> {
  return tracer.startActiveSpan(name, async (span: Span) => {
    try {
      for (const [key, value] of Object.entries(attrs)) {
        if (value !== undefined) span.setAttribute(key, value);
      }
      const result = await fn(span);
      if (!erroredSpans.has(span)) span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Gracefully shut down telemetry, flushing pending spans.
 * Safe to call even when telemetry was never initialised.
 */
export async function shutdownTelemetry(): Promise<void> {
  if (sdk) {
    await sdk.shutdown();
    sdk = null;
    log.info('OpenTelemetry shut down');
  }
}
