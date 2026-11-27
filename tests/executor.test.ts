/**
 * tests/executor.test.ts
 *
 * Unit tests for backend/executor.ts (issue #910).
 *
 * Coverage targets
 * ────────────────
 *  • Valid plan executes successfully
 *  • Expired plan returns PLAN_EXPIRED error result
 *  • Denied confirmation returns PLAN_DENIED error result
 *  • Confirmation timeout falls through to denied
 *  • Auto-confirms when no confirm handler is provided
 *  • Read-only-only plan skips the confirm gate
 *  • Value-moving detection (planHasValueMovingTasks)
 *  • generatePlanSummary produces deterministic human-readable output
 *  • createPlan uses randomUUID format
 *  • executePlan runs all tasks in sequence (runSequence)
 *  • executePlan stops and reports when a task fails (via runSequence)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  executePlan,
  generatePlanSummary,
  createPlan,
  planHasValueMovingTasks,
  type ConfirmHandler,
} from '../backend/executor';
import type { PayFiAgent, AgentTask, AgentResult, Plan } from '../backend/agent';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeAgent(results: AgentResult[]): PayFiAgent {
  return {
    runSequence: vi.fn().mockResolvedValue(results),
    run: vi.fn(),
  } as unknown as PayFiAgent;
}

function makePlan(overrides: Partial<Plan> = {}): Plan {
  const now = new Date();
  const expires = new Date(now.getTime() + 10 * 60 * 1000); // 10 min from now
  return {
    id: 'test-plan-id',
    tasks: [
      {
        type: 'stellar_payment',
        payload: { destination: 'GABCDEF1234567890', amount: '10', assetCode: 'XLM' },
      },
    ],
    summary: 'Send 10 XLM to GABCDE1...',
    createdAt: now.toISOString(),
    expiresAt: expires.toISOString(),
    ...overrides,
  };
}

function successResult(type = 'stellar_payment'): AgentResult {
  return { success: true, taskType: type as AgentTask['type'], data: { txHash: 'abc123' } };
}

function failResult(type = 'stellar_payment'): AgentResult {
  return { success: false, taskType: type as AgentTask['type'], error: 'Simulated failure', errorType: 'SIMULATED' };
}

// ─── generatePlanSummary ──────────────────────────────────────────────────────

describe('generatePlanSummary', () => {
  it('produces a deterministic string from task data, not LLM text', () => {
    const tasks: AgentTask[] = [
      { type: 'stellar_payment', payload: { destination: 'GABCD1234', amount: '5', assetCode: 'XLM' } },
      { type: 'swap', payload: { sellAsset: { code: 'XLM' }, buyAsset: { code: 'USDC' }, sellAmount: '5' } },
    ];
    const summary = generatePlanSummary(tasks);
    expect(summary).toContain('Send 5 XLM to GABCD123...');
    expect(summary).toContain('Swap 5 XLM to USDC');
  });

  it('handles x402_respond', () => {
    const tasks: AgentTask[] = [
      { type: 'x402_respond', payload: { payTo: 'GXYZ9999', amount: '1', assetCode: 'USDC' } },
    ];
    const summary = generatePlanSummary(tasks);
    expect(summary).toContain('Pay 1 USDC to GXYZ9999...');
  });

  it('handles soroban_invoke', () => {
    const tasks: AgentTask[] = [
      { type: 'soroban_invoke', payload: { contractId: 'CCONTRACT1234', method: 'transfer', args: [] } },
    ];
    const summary = generatePlanSummary(tasks);
    expect(summary).toContain('Invoke transfer on contract CCONTRAC...');
  });

  it('falls back gracefully for unknown task types', () => {
    const tasks: AgentTask[] = [{ type: 'unknown_op', payload: {} }];
    expect(() => generatePlanSummary(tasks)).not.toThrow();
  });
});

// ─── planHasValueMovingTasks ──────────────────────────────────────────────────

describe('planHasValueMovingTasks', () => {
  it('returns true for a plan with stellar_payment', () => {
    const plan = makePlan();
    expect(planHasValueMovingTasks(plan)).toBe(true);
  });

  it('returns false for a plan with only read-only tasks', () => {
    const plan = makePlan({
      tasks: [{ type: 'balance_check', payload: { assetCode: 'XLM' } }],
    });
    expect(planHasValueMovingTasks(plan)).toBe(false);
  });

  it('returns true when any task in a mixed plan is value-moving', () => {
    const plan = makePlan({
      tasks: [
        { type: 'balance_check', payload: { assetCode: 'XLM' } },
        { type: 'swap', payload: { sellAsset: { code: 'XLM' }, buyAsset: { code: 'USDC' }, sellAmount: '1', maxSlippagePct: 0.5 } },
      ],
    });
    expect(planHasValueMovingTasks(plan)).toBe(true);
  });
});

// ─── createPlan ───────────────────────────────────────────────────────────────

describe('createPlan', () => {
  it('generates a UUID v4 id', () => {
    const tasks: AgentTask[] = [
      { type: 'balance_check', payload: { assetCode: 'XLM' } },
    ];
    const plan = createPlan(tasks);
    expect(plan.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it('sets expiresAt to now + expirationMs', () => {
    const before = Date.now();
    const plan = createPlan([], 60_000);
    const after = Date.now();
    const expires = new Date(plan.expiresAt).getTime();
    expect(expires).toBeGreaterThanOrEqual(before + 60_000);
    expect(expires).toBeLessThanOrEqual(after + 60_000);
  });
});

// ─── executePlan ─────────────────────────────────────────────────────────────

describe('executePlan', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // ── Expired plan ───────────────────────────────────────────────────────

  it('returns PLAN_EXPIRED without calling agent when plan is expired', async () => {
    const agent = makeAgent([]);
    const expiredPlan = makePlan({
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    const results = await executePlan(agent, expiredPlan);

    expect(results).toHaveLength(1);
    expect(results[0]!.success).toBe(false);
    expect(results[0]!.errorType).toBe('PLAN_EXPIRED');
    expect(agent.runSequence).not.toHaveBeenCalled();
  });

  // ── Denied confirmation ────────────────────────────────────────────────

  it('returns PLAN_DENIED when confirm handler returns false', async () => {
    const agent = makeAgent([successResult()]);
    const plan = makePlan();
    const deny: ConfirmHandler = async () => false;

    const results = await executePlan(agent, plan, { confirm: deny });

    expect(results[0]!.success).toBe(false);
    expect(results[0]!.errorType).toBe('PLAN_DENIED');
    expect(agent.runSequence).not.toHaveBeenCalled();
  });

  // ── Confirmation timeout ────────────────────────────────────────────────

  it('treats a timeout in the confirm handler as denied', async () => {
    const agent = makeAgent([successResult()]);
    const plan = makePlan();
    // Handler never resolves — simulates a hanging confirmation UI.
    const neverResolves: ConfirmHandler = () => new Promise(() => {});

    const results = await executePlan(agent, plan, {
      confirm: neverResolves,
      confirmationTimeoutMs: 50, // 50 ms
    });

    expect(results[0]!.success).toBe(false);
    expect(results[0]!.errorType).toBe('PLAN_DENIED');
  });

  // ── Auto-confirm (no handler) ──────────────────────────────────────────

  it('auto-confirms and executes when no confirm handler is provided', async () => {
    const agent = makeAgent([successResult()]);
    const plan = makePlan();

    const results = await executePlan(agent, plan);

    expect(agent.runSequence).toHaveBeenCalledOnce();
    expect(results[0]!.success).toBe(true);
  });

  // ── Read-only-only plan skips confirmation ─────────────────────────────

  it('executes a read-only plan without calling the confirm handler', async () => {
    const agent = makeAgent([{ success: true, taskType: 'balance_check' }]);
    const readOnlyPlan = makePlan({
      tasks: [{ type: 'balance_check', payload: { assetCode: 'XLM' } }],
    });
    const confirmSpy = vi.fn().mockResolvedValue(true);

    await executePlan(agent, readOnlyPlan, { confirm: confirmSpy });

    // No value-moving tasks → confirm should never be called
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(agent.runSequence).toHaveBeenCalled();
  });

  // ── Successful execution ───────────────────────────────────────────────

  it('runs all tasks via runSequence and returns all results', async () => {
    const twoResults: AgentResult[] = [successResult('balance_check'), successResult('stellar_payment')];
    const agent = makeAgent(twoResults);
    const plan = makePlan({
      tasks: [
        { type: 'balance_check', payload: { assetCode: 'XLM' } },
        { type: 'stellar_payment', payload: { destination: 'GABCD', amount: '5' } },
      ],
    });

    const results = await executePlan(agent, plan, { confirm: async () => true });

    expect(results).toHaveLength(2);
    expect(results[0]!.success).toBe(true);
    expect(results[1]!.success).toBe(true);
  });

  // ── Task fails mid-sequence ────────────────────────────────────────────

  it('propagates a failure result from runSequence', async () => {
    const agent = makeAgent([failResult()]);
    const plan = makePlan();

    const results = await executePlan(agent, plan, { confirm: async () => true });

    expect(results[0]!.success).toBe(false);
    expect(results[0]!.errorType).toBe('SIMULATED');
  });

  // ── Confirm handler is called with the plan summary ────────────────────

  it('passes the plan summary to the confirm handler', async () => {
    const agent = makeAgent([successResult()]);
    const plan = makePlan({ summary: 'Send 10 XLM to GABCD...' });
    const confirmSpy = vi.fn().mockResolvedValue(true);

    await executePlan(agent, plan, { confirm: confirmSpy });

    expect(confirmSpy).toHaveBeenCalledWith('Send 10 XLM to GABCD...');
  });
});
