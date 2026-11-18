/**
 * backend/executor.ts
 *
 * ExecutePlan: Human-readable summary generation with confirm/deny flow.
 * AI-generated payments must never execute silently.
 *
 * Plan integrity (issue #B):
 *   `createPlan` computes `planHash` over canonical JSON of tasks and deep-
 *   freezes the returned Plan.  `executePlan` accepts an optional
 *   `approvalToken`; when supplied it calls `verifyApprovalToken` and refuses
 *   execution on hash mismatch or expiry.  This guarantees that what the user
 *   reviewed is exactly what runs.
 */

import { PayFiAgent, AgentTask, AgentResult, Plan, PlanApprovalToken, VALUE_MOVING_TASK_TYPES } from './agent';
import {
  buildPlan,
  computePlanHash,
  createApprovalToken,
  verifyApprovalToken,
  PlanIntegrityError,
} from './planner';
import { createLogger } from './utils/logger';

const log = createLogger('executor');

/**
 * Confirmation callback type.
 */
export type ConfirmHandler = (summary: string) => Promise<boolean>;

export interface ExecutePlanOptions {
  /** Callback to confirm/deny execution. If not provided, auto-confirms. */
  confirm?: ConfirmHandler;
  /** Timeout in ms for unconfirmed plans (default: 5 minutes) */
  confirmationTimeoutMs?: number;
  /**
   * Approval token previously returned by `createApprovalToken`.
   * When provided, `executePlan` re-derives the plan hash and refuses
   * execution if the plan was mutated or the token has expired (issue #B).
   */
  approvalToken?: PlanApprovalToken;
}

/**
 * Generate human-readable summary from validated tasks.
 * Built deterministically from task data, not LLM text.
 */
function generateTaskSummary(task: AgentTask): string {
  const p = task.payload as Record<string, unknown>;

  switch (task.type) {
    case 'stellar_payment': {
      const dest = String(p.destination ?? '').slice(0, 8) + '...';
      const amt = String(p.amount ?? '0');
      const code = String(p.assetCode ?? 'XLM');
      return `Send ${amt} ${code} to ${dest}`;
    }
    case 'x402_respond': {
      const dest = String(p.payTo ?? '').slice(0, 8) + '...';
      const amt = String(p.amount ?? '0');
      const code = String(p.assetCode ?? 'XLM');
      return `Pay ${amt} ${code} to ${dest} (x402 response)`;
    }
    case 'soroban_invoke': {
      const cid = String(p.contractId ?? '').slice(0, 8) + '...';
      const method = String(p.method ?? '');
      return `Invoke ${method} on contract ${cid}`;
    }
    case 'batch_payment': {
      const payments = (p.payments as Array<Record<string, unknown>>) ?? [];
      return `Batch payment: ${payments.length} payments`;
    }
    case 'path_payment': {
      const send = String(p.sendAmount ?? '0');
      const sendAsset = String(p.sendAsset ?? '');
      const destAsset = String(p.destAsset ?? '');
      return `Swap ${send} ${sendAsset} to ${destAsset}`;
    }
    case 'dex_offer': {
      const action = String(p.action ?? '');
      const amount = String(p.amount ?? '0');
      return `DEX offer: ${action} ${amount}`;
    }
    case 'swap': {
      const sell = String(p.sellAmount ?? '0');
      const sellAsset = (p.sellAsset as { code: string })?.code ?? '';
      const buyAsset = (p.buyAsset as { code: string })?.code ?? '';
      return `Swap ${sell} ${sellAsset} to ${buyAsset}`;
    }
    case 'multisig_payment': {
      const dest = String(p.destination ?? '').slice(0, 8) + '...';
      const amt = String(p.amount ?? '0');
      return `Multi-sig payment: ${amt} to ${dest}`;
    }
    case 'soroban_deploy': {
      return `Deploy Soroban contract`;
    }
    case 'liquidity_pool': {
      const action = String(p.action ?? '');
      return `Liquidity pool: ${action}`;
    }
    default:
      return `${task.type}`;
  }
}

/**
 * Generate full plan summary from tasks.
 */
export function generatePlanSummary(tasks: readonly AgentTask[]): string {
  return tasks.map(generateTaskSummary).join('; ');
}

/**
 * Create a frozen, integrity-stamped Plan object from tasks.
 *
 * The returned Plan is deep-frozen and carries a `planHash` derived from the
 * canonical (sorted-key) JSON of `tasks`.  Pass the plan to
 * `createApprovalToken` to get a token to supply back to `executePlan`.
 */
export function createPlan(tasks: AgentTask[], expirationMs = 300000): Plan {
  return buildPlan(tasks, expirationMs);
}

/**
 * Check if plan has value-moving tasks.
 */
export function planHasValueMovingTasks(plan: Plan): boolean {
  return plan.tasks.some((t) => VALUE_MOVING_TASK_TYPES.has(t.type));
}

/**
 * Execute a plan with optional confirmation and integrity verification.
 *
 * When `options.approvalToken` is supplied, this function calls
 * `verifyApprovalToken` before doing anything else.  Any hash mismatch or
 * expired token causes an immediate rejection without touching the network
 * (issue #B).
 *
 * @param agent - The PayFiAgent instance
 * @param plan - The plan to execute (must be the frozen object returned by createPlan)
 * @param options - Execution options including confirm callback and approval token
 */
export async function executePlan(
  agent: PayFiAgent,
  plan: Plan,
  options: ExecutePlanOptions = {}
): Promise<AgentResult[]> {
  const { confirm, confirmationTimeoutMs = 5 * 60 * 1000, approvalToken } = options;

  // ── Integrity check (issue #B) ───────────────────────────────────────────
  if (approvalToken) {
    try {
      verifyApprovalToken(plan, approvalToken);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn({ planId: plan.id, error: message }, 'Plan integrity check failed');
      return [
        {
          success: false,
          taskType: 'stellar_payment' as const,
          error: message,
          errorType: 'PLAN_INTEGRITY_VIOLATION',
        },
      ];
    }
  }

  // ── Expiry check ─────────────────────────────────────────────────────────
  if (new Date(plan.expiresAt) < new Date()) {
    log.warn({ planId: plan.id }, 'Plan expired');
    return [
      {
        success: false,
        taskType: 'stellar_payment' as const,
        error: 'Plan has expired',
        errorType: 'PLAN_EXPIRED',
      },
    ];
  }

  // ── Confirmation gate ─────────────────────────────────────────────────────
  const needsConfirmation = planHasValueMovingTasks(plan);

  if (needsConfirmation && confirm) {
    const approved = await Promise.race([
      confirm(plan.summary),
      new Promise<false>((_, reject) =>
        setTimeout(() => reject(new Error('Confirmation timeout')), confirmationTimeoutMs)
      ),
    ]).catch(() => false);

    if (!approved) {
      log.info({ planId: plan.id }, 'Plan denied by user');
      return [
        {
          success: false,
          taskType: 'stellar_payment' as const,
          error: 'Plan denied by user',
          errorType: 'PLAN_DENIED',
        },
      ];
    }
  }

  // ── Execute ───────────────────────────────────────────────────────────────
  log.info({ planId: plan.id, summary: plan.summary }, 'Executing plan');
  const results = await agent.runSequence(plan.tasks as AgentTask[]);

  return results;
}

export {
  PayFiAgent,
  AgentTask,
  AgentResult,
  Plan,
  PlanApprovalToken,
  VALUE_MOVING_TASK_TYPES,
  buildPlan,
  computePlanHash,
  createApprovalToken,
  verifyApprovalToken,
  PlanIntegrityError,
};
