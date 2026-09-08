/**
 * MockNetworkConditions - declarative latency / failure injection for Vitest.
 *
 * Wraps Vitest mocks (or object methods) so tests can simulate slow or
 * flaky networks without touching production code:
 *
 *   const submit = vi.fn(async () => ({ ok: true }));
 *   applyConditions({ latencyMs: 1500 }, submit);
 *   applyConditions({ failureRate: 1, errorType: NetworkError }, submit);
 *   reset(); // restores every wrapped mock
 *
 * Fake-timers compatible: latency uses a plain setTimeout promise, so drive
 * it with `vi.advanceTimersByTimeAsync()` under `vi.useFakeTimers()`.
 */
import { vi } from 'vitest';

export interface NetworkConditions {
  /** Artificial delay (ms) applied before each call resolves. */
  readonly latencyMs?: number;
  /** Probability 0..1 that a call throws instead of resolving. */
  readonly failureRate?: number;
  /** Error class thrown on injected failures. Defaults to Error. */
  readonly errorType?: new (message?: string) => Error;
}

export interface MethodTarget {
  readonly object: Record<string, unknown>;
  readonly method: string;
}

type MockLike = {
  getMockImplementation?: () => ((...args: Array<never>) => unknown) | undefined;
  mockImplementation?: (fn: (...args: Array<never>) => unknown) => unknown;
  mockRestore?: () => unknown;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyMock = any;

const registry: Array<{ restore: () => void }> = [];

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const isMock = (value: unknown): value is MockLike =>
  typeof value === 'function' && typeof (value as MockLike).getMockImplementation === 'function';

const toMock = (target: AnyMock | MethodTarget): AnyMock => {
  if (isMock(target)) return target;
  const t = target as MethodTarget;
  if (t && typeof t === 'object' && typeof t.method === 'string') {
    return vi.spyOn(t.object as Record<string, (...a: Array<never>) => unknown>, t.method as never);
  }
  throw new Error('MockNetworkConditions: target must be a vi.fn() mock or { object, method }');
};

const normalizeRate = (rate: number | undefined): number => {
  if (rate === undefined) return 0;
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
    throw new Error(`MockNetworkConditions: failureRate must be between 0 and 1, got ${rate}`);
  }
  return rate;
};

export function applyConditions(
  conditions: NetworkConditions,
  ...targets: Array<AnyMock | MethodTarget>
): void {
  const latencyMs = conditions.latencyMs ?? 0;
  if (latencyMs < 0) throw new Error('MockNetworkConditions: latencyMs must be >= 0');
  const failureRate = normalizeRate(conditions.failureRate);
  const ErrorType = conditions.errorType ?? Error;
  if (targets.length === 0)
    throw new Error('MockNetworkConditions: at least one target is required');

  for (const target of targets) {
    const mock = toMock(target);
    const original = mock.getMockImplementation?.();
    mock.mockImplementation?.((async (...args: Array<never>) => {
      if (latencyMs > 0) await sleep(latencyMs);
      if (Math.random() < failureRate) {
        throw new ErrorType(`injected network failure (rate=${failureRate})`);
      }
      if (original) return original(...args);
      return undefined;
    }) as (...args: Array<never>) => unknown);
    registry.push({
      restore: () => {
        mock.mockRestore?.();
      },
    });
  }
}

export function reset(): void {
  while (registry.length > 0) {
    const entry = registry.pop();
    try {
      entry?.restore();
    } catch {
      // best-effort: a mock may already be restored by its own suite
    }
  }
}
