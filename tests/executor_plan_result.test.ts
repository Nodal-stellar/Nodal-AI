/**
 * tests/executor_plan_result.test.ts
 *
 * Regression tests for issue #909:
 *   - executePlan returns a PlanResult (no `as any` task types in AgentResult).
 *   - The confirmation timer is always cleared (no pending timers after return).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executePlan, createPlan, PlanResult } from '../backend/executor';
import type { AgentTask } from '../backend/agent';
import { expectLoggedError } from './helpers/expectLoggedError';

// ─── Fake timer infrastructure ────────────────────────────────────────────────

// ─── Minimal agent stub ───────────────────────────────────────────────────────

function makeAgent(opts: { runSequenceResult?: unknown[]; runSequenceThrows?: boolean } = {}) {
  return {
    getTools: () => [],
    run: vi.fn().mockResolvedValue({ success: true, taskType: 'account_info', data: {} }),
    runSequence: opts.runSequenceThrows
      ? vi.fn().mockRejectedValue(new Error('simulated failure'))
      : vi
          .fn()
          .mockResolvedValue(
            opts.runSequenceResult ?? [{ success: true, taskType: 'stellar_payment', data: {} }]
          ),
  } as any;
}

// ─── Shared tasks ─────────────────────────────────────────────────────────────

const VALUE_MOVING_TASK: AgentTask = {
  type: 'stellar_payment',
  payload: { destination: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', amount: '1' },
};

const READONLY_TASK: AgentTask = {
  type: 'account_info',
  payload: {},
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('executePlan — issue #909', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    // If the timer was not cleared, this will throw "1 timer(s) still pending"
    // in Vitest's fake-timer mode — which is exactly the regression we're guarding.
    vi.useRealTimers();
  });

  describe('PlanResult shape — no as-any task types', () => {
    it('returns status:"executed" and results when approved', async () => {
      const plan = createPlan([VALUE_MOVING_TASK]);
      const agent = makeAgent();

      const confirmAlwaysApprove = vi.fn().mockResolvedValue(true);
      const resultPromise = executePlan(agent, plan, { confirm: confirmAlwaysApprove });
      await vi.runAllTimersAsync();
      const result: PlanResult = await resultPromise;

      expect(result.planId).toBe(plan.id);
      expect(result.status).toBe('executed');
      expect(Array.isArray(result.results)).toBe(true);
    });

    it('returns status:"denied" (not a fake AgentResult) when user denies', async () => {
      const plan = createPlan([VALUE_MOVING_TASK]);
      const agent = makeAgent();

      const confirmDeny = vi.fn().mockResolvedValue(false);
      const resultPromise = executePlan(agent, plan, { confirm: confirmDeny });
      await vi.runAllTimersAsync();
      const result: PlanResult = await resultPromise;

      expect(result.planId).toBe(plan.id);
      expect(result.status).toBe('denied');
      expect(result.results).toHaveLength(0);
      // The old code returned an AgentResult with taskType:'stellar_payment' as any
      // — verify no such fake AgentResult leaks through.
      expect((result as any).taskType).toBeUndefined();
      expect((result as any).error).toBeUndefined();
    });

    it('returns status:"expired" for an expired plan', async () => {
      // Create a plan that is already expired.
      const pastDate = new Date(Date.now() - 1000).toISOString();
      const plan = {
        ...createPlan([VALUE_MOVING_TASK]),
        expiresAt: pastDate,
      };
      const agent = makeAgent();

      const result: PlanResult = await executePlan(agent, plan);

      expect(result.status).toBe('expired');
      expect(result.results).toHaveLength(0);
      expect((result as any).taskType).toBeUndefined();
    });

    it('returns status:"failed" when runSequence throws', async () => {
      expectLoggedError(/Plan execution failed/);
      const plan = createPlan([READONLY_TASK]);
      const agent = makeAgent({ runSequenceThrows: true });

      const result: PlanResult = await executePlan(agent, plan);

      expect(result.status).toBe('failed');
      expect(result.results).toHaveLength(0);
    });
  });

  describe('Confirmation timer cleanup — no pending timers after return', () => {
    it('clears the timeout handle after a successful confirmation', async () => {
      const plan = createPlan([VALUE_MOVING_TASK]);
      const agent = makeAgent();

      const confirmApprove = vi.fn().mockResolvedValue(true);
      const resultPromise = executePlan(agent, plan, {
        confirm: confirmApprove,
        confirmationTimeoutMs: 300_000,
      });
      await vi.runAllTimersAsync();
      await resultPromise;

      // If the timer were still pending, Vitest's fake-timer tracking would
      // show pending timers here. The afterEach hook calls useRealTimers()
      // which in Vitest surfaces pending fake timers as a test failure.
      expect(vi.getTimerCount()).toBe(0);
    });

    it('clears the timeout handle after a denial', async () => {
      const plan = createPlan([VALUE_MOVING_TASK]);
      const agent = makeAgent();

      const confirmDeny = vi.fn().mockResolvedValue(false);
      const resultPromise = executePlan(agent, plan, {
        confirm: confirmDeny,
        confirmationTimeoutMs: 300_000,
      });
      await vi.runAllTimersAsync();
      await resultPromise;

      expect(vi.getTimerCount()).toBe(0);
    });

    it('resolves with status:"denied" when the confirmation timer fires', async () => {
      const plan = createPlan([VALUE_MOVING_TASK]);
      const agent = makeAgent();

      // confirm never resolves — only the timeout fires.
      const confirmHangs = vi.fn().mockReturnValue(new Promise(() => {}));
      const resultPromise = executePlan(agent, plan, {
        confirm: confirmHangs,
        confirmationTimeoutMs: 5_000,
      });

      // Advance time past the timeout.
      await vi.advanceTimersByTimeAsync(6_000);
      const result: PlanResult = await resultPromise;

      expect(result.status).toBe('denied');
      expect(vi.getTimerCount()).toBe(0);
    });

    it('skips confirmation for read-only plans (no timer created)', async () => {
      const plan = createPlan([READONLY_TASK]);
      const agent = makeAgent();

      // No confirm callback supplied — plan should execute directly.
      const result: PlanResult = await executePlan(agent, plan);

      expect(result.status).toBe('executed');
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
