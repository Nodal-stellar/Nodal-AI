/**
 * tests/planner_policy.test.ts
 *
 * Tests for the two security improvements in planner.ts / executor.ts:
 *
 * Issue #A — Fail-fast policy enforcement
 *   One rejected task → whole plan rejected with per-task reasons (not silently
 *   dropped).  Rejection reasons are surfaced to the caller via PlanPolicyError.
 *
 * Issue #B — Plan integrity / approval token
 *   buildPlan() freezes the plan and stamps it with planHash.
 *   verifyApprovalToken() rejects mismatched / expired tokens.
 *   executePlan() with an approval token refuses a mutated plan.
 *   Hash is canonical-JSON (key-order independent).
 */

import { describe, it, expect, vi } from 'vitest';
import {
  buildPlan,
  computePlanHash,
  createApprovalToken,
  verifyApprovalToken,
  PlanPolicyError,
  PlanIntegrityError,
  Planner,
} from '../backend/planner';
import { createPlan, executePlan } from '../backend/executor';
import type { AgentTask, PlanApprovalToken } from '../backend/agent';

// ─── Shared fixtures ──────────────────────────────────────────────────────────

const readOnlyTask: AgentTask = {
  type: 'account_info',
  payload: { publicKey: 'GTEST' },
};

const valueMoverTask: AgentTask = {
  type: 'stellar_payment',
  payload: { destination: 'GBOB', amount: '40', assetCode: 'USDC' },
};

const swapTask: AgentTask = {
  type: 'swap',
  payload: {
    sellAsset: { code: 'XLM' },
    buyAsset: { code: 'USDC' },
    sellAmount: '50',
    maxSlippagePct: 1,
  },
};

// ─── Issue #A: Fail-fast policy enforcement ───────────────────────────────────

describe('Planner policy enforcement (issue #A)', () => {
  it('throws PlanPolicyError when a value-moving task is included', async () => {
    // Arrange: set up a mock LLM that returns a swap + payment (both value-movers)
    const mockAgent = {
      run: vi.fn().mockResolvedValue({ success: true, data: {} }),
    } as unknown as Parameters<typeof Planner>[0];

    const planner = new Planner(mockAgent, { llmEndpoint: 'http://mock-llm' });

    // Patch the private callLLM to return tasks that include a value-mover
    const tasks: AgentTask[] = [swapTask, valueMoverTask];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(planner as any, 'callLLM').mockResolvedValue(tasks);

    // Act
    await expect(planner.plan('swap 50 XLM to USDC then pay 40 USDC to Bob')).rejects.toThrow(
      PlanPolicyError
    );
  });

  it('PlanPolicyError carries per-task rejection reasons', async () => {
    const mockAgent = {
      run: vi.fn(),
    } as unknown as Parameters<typeof Planner>[0];
    const planner = new Planner(mockAgent, { llmEndpoint: 'http://mock-llm' });

    // Two value-movers → two rejections
    const tasks: AgentTask[] = [swapTask, valueMoverTask];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(planner as any, 'callLLM').mockResolvedValue(tasks);

    let caughtError: PlanPolicyError | undefined;
    try {
      await planner.plan('swap and pay');
    } catch (err) {
      if (err instanceof PlanPolicyError) caughtError = err;
    }

    expect(caughtError).toBeDefined();
    expect(caughtError!.rejections).toHaveLength(2);
    expect(caughtError!.rejections[0]?.taskType).toBe('swap');
    expect(caughtError!.rejections[1]?.taskType).toBe('stellar_payment');
    // Reasons must be non-empty strings
    for (const r of caughtError!.rejections) {
      expect(typeof r.reason).toBe('string');
      expect(r.reason.length).toBeGreaterThan(0);
    }
  });

  it('succeeds when all tasks are read-only', async () => {
    const mockAgent = {
      run: vi.fn().mockResolvedValue({ success: true, data: { balance: '100' } }),
    } as unknown as Parameters<typeof Planner>[0];
    const planner = new Planner(mockAgent, { llmEndpoint: 'http://mock-llm' });

    const tasks: AgentTask[] = [readOnlyTask];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(planner as any, 'callLLM').mockResolvedValue(tasks);

    const plan = await planner.plan('what is my balance?');
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0]?.type).toBe('account_info');
  });

  it('a single rejected task rejects the whole plan (not just that task)', async () => {
    const mockAgent = {
      run: vi.fn(),
    } as unknown as Parameters<typeof Planner>[0];
    const planner = new Planner(mockAgent, { llmEndpoint: 'http://mock-llm' });

    // One read-only + one value-mover
    const tasks: AgentTask[] = [readOnlyTask, swapTask];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(planner as any, 'callLLM').mockResolvedValue(tasks);

    // The error message must mention the failing task, not just the first task
    let caughtError: PlanPolicyError | undefined;
    try {
      await planner.plan('check balance then swap');
    } catch (err) {
      if (err instanceof PlanPolicyError) caughtError = err;
    }

    expect(caughtError).toBeDefined();
    // Only the value-mover should appear in rejections
    expect(caughtError!.rejections).toHaveLength(1);
    expect(caughtError!.rejections[0]?.taskType).toBe('swap');
  });
});

// ─── Issue #B: Plan integrity ─────────────────────────────────────────────────

describe('Plan integrity — buildPlan / computePlanHash (issue #B)', () => {
  it('buildPlan attaches a planHash field', () => {
    const tasks: AgentTask[] = [readOnlyTask];
    const plan = buildPlan(tasks);
    expect(typeof plan.planHash).toBe('string');
    expect(plan.planHash).toHaveLength(64); // SHA-256 hex
  });

  it('planHash is deterministic for the same tasks', () => {
    const tasks: AgentTask[] = [readOnlyTask];
    expect(computePlanHash(tasks)).toBe(computePlanHash(tasks));
  });

  it('planHash is key-order independent (canonical JSON)', () => {
    // Two tasks that differ only in payload key-insertion order
    const taskA: AgentTask = { type: 'account_info', payload: { a: 1, b: 2 } };
    const taskB: AgentTask = { type: 'account_info', payload: { b: 2, a: 1 } };
    expect(computePlanHash([taskA])).toBe(computePlanHash([taskB]));
  });

  it('planHash changes when tasks change', () => {
    const original: AgentTask[] = [readOnlyTask];
    const modified: AgentTask[] = [{ ...readOnlyTask, payload: { publicKey: 'GDIFFERENT' } }];
    expect(computePlanHash(original)).not.toBe(computePlanHash(modified));
  });

  it('buildPlan freezes the returned plan object', () => {
    const tasks: AgentTask[] = [readOnlyTask];
    const plan = buildPlan(tasks);

    expect(Object.isFrozen(plan)).toBe(true);
    // Mutation must throw in strict mode (which Vitest runs with)
    expect(() => {
      (plan as { summary: string }).summary = 'hacked';
    }).toThrow();
  });

  it('buildPlan freezes nested tasks array', () => {
    const tasks: AgentTask[] = [readOnlyTask];
    const plan = buildPlan(tasks);

    expect(Object.isFrozen(plan.tasks)).toBe(true);
  });
});

describe('createApprovalToken / verifyApprovalToken (issue #B)', () => {
  it('createApprovalToken returns a frozen token with planId, planHash, expiresAt', () => {
    const plan = buildPlan([readOnlyTask]);
    const token = createApprovalToken(plan);

    expect(token.planId).toBe(plan.id);
    expect(token.planHash).toBe(plan.planHash);
    expect(token.expiresAt).toBe(plan.expiresAt);
    expect(Object.isFrozen(token)).toBe(true);
  });

  it('verifyApprovalToken passes for a valid token', () => {
    const plan = buildPlan([readOnlyTask]);
    const token = createApprovalToken(plan);
    expect(() => verifyApprovalToken(plan, token)).not.toThrow();
  });

  it('verifyApprovalToken throws PlanIntegrityError for a different planId', () => {
    const plan = buildPlan([readOnlyTask]);
    const badToken: PlanApprovalToken = {
      planId: 'plan_wrong',
      planHash: plan.planHash,
      expiresAt: plan.expiresAt,
    };
    expect(() => verifyApprovalToken(plan, badToken)).toThrow(PlanIntegrityError);
  });

  it('verifyApprovalToken throws PlanIntegrityError for an expired token', () => {
    const plan = buildPlan([readOnlyTask]);
    const expiredToken: PlanApprovalToken = {
      planId: plan.id,
      planHash: plan.planHash,
      expiresAt: new Date(0).toISOString(), // already expired
    };
    expect(() => verifyApprovalToken(plan, expiredToken)).toThrow(PlanIntegrityError);
    expect(() => verifyApprovalToken(plan, expiredToken)).toThrow(/expired/i);
  });

  it('verifyApprovalToken throws PlanIntegrityError when planHash does not match', () => {
    const plan = buildPlan([readOnlyTask]);
    const tamperedToken: PlanApprovalToken = {
      planId: plan.id,
      planHash: 'a'.repeat(64), // wrong hash
      expiresAt: plan.expiresAt,
    };
    expect(() => verifyApprovalToken(plan, tamperedToken)).toThrow(PlanIntegrityError);
    expect(() => verifyApprovalToken(plan, tamperedToken)).toThrow(/mismatch/i);
  });
});

describe('executePlan approval token integration (issue #B)', () => {
  // Minimal mock agent
  const makeAgent = () =>
    ({
      runSequence: vi.fn().mockResolvedValue([{ success: true, taskType: 'account_info' }]),
    }) as unknown as Parameters<typeof executePlan>[0];

  it('executes successfully with a valid approval token', async () => {
    const agent = makeAgent();
    const plan = createPlan([readOnlyTask]);
    const token = createApprovalToken(plan);

    const results = await executePlan(agent, plan, { approvalToken: token });
    expect(results[0]?.success).toBe(true);
  });

  it('refuses execution when planHash in token does not match the plan', async () => {
    const agent = makeAgent();
    const plan = createPlan([readOnlyTask]);

    // Build token for a different plan (hash mismatch)
    const differentPlan = createPlan([{ type: 'balance_check', payload: { assetCode: 'XLM' } }]);
    const wrongToken = createApprovalToken(differentPlan);
    // Override planId so only hash mismatches (not the id check)
    const badToken: PlanApprovalToken = {
      planId: plan.id,
      planHash: wrongToken.planHash,
      expiresAt: plan.expiresAt,
    };

    const results = await executePlan(agent, plan, { approvalToken: badToken });
    expect(results[0]?.success).toBe(false);
    expect(results[0]?.errorType).toBe('PLAN_INTEGRITY_VIOLATION');
    // runSequence must NOT have been called
    expect(agent.runSequence).not.toHaveBeenCalled();
  });

  it('refuses execution when approval token has expired', async () => {
    const agent = makeAgent();
    const plan = createPlan([readOnlyTask]);
    const expiredToken: PlanApprovalToken = {
      planId: plan.id,
      planHash: plan.planHash,
      expiresAt: new Date(0).toISOString(),
    };

    const results = await executePlan(agent, plan, { approvalToken: expiredToken });
    expect(results[0]?.success).toBe(false);
    expect(results[0]?.errorType).toBe('PLAN_INTEGRITY_VIOLATION');
    expect(agent.runSequence).not.toHaveBeenCalled();
  });

  it('executes without approval token (backward-compatible path)', async () => {
    const agent = makeAgent();
    const plan = createPlan([readOnlyTask]);

    // No approvalToken → no integrity check; plain expiry + confirm flow
    const results = await executePlan(agent, plan);
    expect(results[0]?.success).toBe(true);
    expect(agent.runSequence).toHaveBeenCalledOnce();
  });
});
