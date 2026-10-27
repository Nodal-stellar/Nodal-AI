/**
 * tests/telemetry.test.ts
 *
 * Closes #454 — withSpan() had no test coverage confirming it actually
 * creates spans with the right name/attributes, or that nested calls relate
 * correctly. Uses the OTel in-memory span exporter so spans are asserted
 * directly rather than inferred from mocked SDK calls.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

// telemetry.ts imports config at module load, and loadConfig() calls
// process.exit(1) when required env vars are absent — so importing the
// module under test would kill the run before a single assertion. withSpan()
// only reads config.OTLP_ENDPOINT (and only inside initTelemetry(), which
// these tests never call), so an otherwise-empty mock is enough.
vi.mock('../backend/config', () => ({
  config: {
    HORIZON_URL: 'https://horizon-testnet.stellar.org',
    SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
    STELLAR_NETWORK: 'testnet',
  },
}));

import {
  withSpan,
  markSpanError,
  setTxHashAttribute,
  extractTxHash,
  SPAN_ATTR,
} from '../backend/telemetry';

// `trace.getTracer()` (called once at module load inside telemetry.ts) returns
// a ProxyTracer that delegates to whatever provider is *currently* registered
// globally at call time — so registering the in-memory provider here, after
// telemetry.ts has already been imported, still lets us capture its spans.
let exporter: InMemorySpanExporter;

beforeAll(() => {
  exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  trace.setGlobalTracerProvider(provider);
  // withSpan() activates its span; a real context manager is needed for that
  // to propagate across awaits (NodeSDK registers the same one in production).
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
});

beforeEach(() => {
  exporter.reset();
});

describe('withSpan', () => {
  it('creates a span named after the given operation', async () => {
    await withSpan('myOp', async () => 'result');

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe('myOp');
  });

  it("returns the wrapped function's result and marks the span OK", async () => {
    const result = await withSpan('myOp', async () => 42);

    expect(result).toBe(42);
    const [span] = exporter.getFinishedSpans();
    expect(span!.status.code).toBe(1); // SpanStatusCode.OK
  });

  it('records an exception and ERROR status when the wrapped function throws', async () => {
    await expect(
      withSpan('failingOp', async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    const [span] = exporter.getFinishedSpans();
    expect(span!.status.code).toBe(2); // SpanStatusCode.ERROR
    expect(span!.status.message).toBe('boom');
  });

  it('applies custom attributes passed as the third argument', async () => {
    await withSpan('myOp', async () => 'result', {
      'http.method': 'GET',
      'retry.count': 3,
      cached: true,
    });

    const [span] = exporter.getFinishedSpans();
    expect(span!.attributes['http.method']).toBe('GET');
    expect(span!.attributes['retry.count']).toBe(3);
    expect(span!.attributes.cached).toBe(true);
  });

  it('creates no attributes when none are passed', async () => {
    await withSpan('myOp', async () => 'result');

    const [span] = exporter.getFinishedSpans();
    expect(Object.keys(span!.attributes)).toHaveLength(0);
  });

  it('links nested calls as parent/child within one trace', async () => {
    await withSpan('outer', async () => {
      await withSpan('inner', async () => 'done');
    });

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(2);

    const outer = spans.find((s) => s.name === 'outer')!;
    const inner = spans.find((s) => s.name === 'inner')!;

    expect(outer.parentSpanContext).toBeUndefined();
    expect(inner.parentSpanContext?.spanId).toBe(outer.spanContext().spanId);
    expect(inner.spanContext().traceId).toBe(outer.spanContext().traceId);
  });

  it('keeps an ERROR status set via markSpanError() when fn returns normally', async () => {
    await withSpan('softFail', async (span) => {
      markSpanError(span, 'task failed');
      return { success: false };
    });

    const [span] = exporter.getFinishedSpans();
    expect(span!.status.code).toBe(2); // SpanStatusCode.ERROR
    expect(span!.status.message).toBe('task failed');
  });
});

// ─── Task / tool span hierarchy (#823) ─────────────────────────────────────────

describe('task and tool spans', () => {
  afterEach(() => {
    delete process.env.OTEL_REDACT_TX_HASH;
  });

  const runTask = () =>
    withSpan(
      'agent.executeTask',
      async (taskSpan) => {
        const data = await withSpan(
          'tool.stellar_payment',
          async (toolSpan) => {
            const result = { hash: 'abc123', amount: '10', destination: 'GDEST' };
            setTxHashAttribute(toolSpan, result);
            return result;
          },
          { [SPAN_ATTR.TASK_TYPE]: 'stellar_payment', [SPAN_ATTR.CORRELATION_ID]: 'corr-1' }
        );
        setTxHashAttribute(taskSpan, data);
        return data;
      },
      { [SPAN_ATTR.TASK_TYPE]: 'stellar_payment', [SPAN_ATTR.CORRELATION_ID]: 'corr-1' }
    );

  it('nests the tool span under the task span with task attributes', async () => {
    await runTask();

    const spans = exporter.getFinishedSpans();
    const task = spans.find((s) => s.name === 'agent.executeTask')!;
    const tool = spans.find((s) => s.name === 'tool.stellar_payment')!;

    expect(tool.parentSpanContext?.spanId).toBe(task.spanContext().spanId);
    for (const span of [task, tool]) {
      expect(span.attributes[SPAN_ATTR.TASK_TYPE]).toBe('stellar_payment');
      expect(span.attributes[SPAN_ATTR.CORRELATION_ID]).toBe('corr-1');
      expect(span.attributes[SPAN_ATTR.TX_HASH]).toBe('abc123');
    }
  });

  it('never records amounts or addresses on spans', async () => {
    await runTask();

    for (const span of exporter.getFinishedSpans()) {
      const values = Object.values(span.attributes);
      expect(values).not.toContain('10');
      expect(values).not.toContain('GDEST');
    }
  });

  it('omits the tx hash when OTEL_REDACT_TX_HASH=true', async () => {
    process.env.OTEL_REDACT_TX_HASH = 'true';
    await runTask();

    for (const span of exporter.getFinishedSpans()) {
      expect(span.attributes[SPAN_ATTR.TX_HASH]).toBeUndefined();
    }
  });

  it('extracts the tx hash from the field names tools use', () => {
    expect(extractTxHash({ hash: 'a' })).toBe('a');
    expect(extractTxHash({ txHash: 'b' })).toBe('b');
    expect(extractTxHash({ transactionHash: 'c' })).toBe('c');
    expect(extractTxHash({ unsignedXDR: 'x' })).toBeUndefined();
    expect(extractTxHash(null)).toBeUndefined();
  });
});
