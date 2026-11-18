/**
 * backend/planner.ts
 *
 * AI-powered planner using function calling.
 * agent.plan("swap 50 XLM to USDC and send half to GB...") returns a structured Plan.
 *
 * Policy enforcement (issue #A):
 *   Any task that fails `validateTaskPolicy` causes the WHOLE plan to be
 *   rejected immediately.  `plan()` throws a `PlanPolicyError` that carries
 *   per-task rejection reasons so callers can surface them to the user rather
 *   than silently dropping tasks.
 *
 * Plan integrity (issue #B):
 *   `createPlan` computes `planHash = sha256(canonicalJSON(tasks))` and deep-
 *   freezes the returned Plan object so it cannot be mutated after creation.
 *   `executePlan` recomputes the hash and throws `PlanIntegrityError` on
 *   mismatch.  `createApprovalToken` binds {planId, planHash, expiresAt} into
 *   an opaque token that expires with the plan.
 */

import { createHash } from 'crypto';
import { z } from 'zod';
import { PayFiAgent, AgentTask, TaskType, VALUE_MOVING_TASK_TYPES, Plan, PlanApprovalToken } from './agent';
import { createLogger } from './utils/logger';

const log = createLogger('planner');

// ─── Canonical JSON (key-order independent) ───────────────────────────────────

/**
 * Recursively sort object keys so two objects that differ only in insertion
 * order produce identical JSON — and therefore identical hashes.
 */
function canonicalise(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalise);
  const obj = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = canonicalise(obj[key]);
  }
  return sorted;
}

/**
 * Compute SHA-256 over the canonical JSON representation of `tasks`.
 * Key order in each task payload does not affect the result.
 */
export function computePlanHash(tasks: readonly AgentTask[]): string {
  const canonical = JSON.stringify(canonicalise(tasks));
  return createHash('sha256').update(canonical).digest('hex');
}

// ─── Deep freeze ─────────────────────────────────────────────────────────────

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  Object.freeze(value);
  for (const v of Object.values(value as Record<string, unknown>)) {
    deepFreeze(v);
  }
  return value;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

/** Thrown when one or more tasks fail the policy check (issue #A). */
export class PlanPolicyError extends Error {
  /** Per-task rejection details keyed by task type (may repeat if same type appears multiple times). */
  readonly rejections: ReadonlyArray<{ taskType: string; reason: string }>;

  constructor(rejections: ReadonlyArray<{ taskType: string; reason: string }>) {
    const lines = rejections.map((r) => `  ${r.taskType}: ${r.reason}`).join('\n');
    super(`Plan rejected — ${rejections.length} task(s) failed policy:\n${lines}`);
    this.name = 'PlanPolicyError';
    this.rejections = rejections;
    Object.setPrototypeOf(this, PlanPolicyError.prototype);
  }
}

/** Thrown when `executePlan` detects that the plan was mutated after approval (issue #B). */
export class PlanIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanIntegrityError';
    Object.setPrototypeOf(this, PlanIntegrityError.prototype);
  }
}

// ─── Tool schemas ─────────────────────────────────────────────────────────────

const TOOL_SCHEMAS = {
  stellar_payment: {
    name: 'stellar_payment',
    description: 'Send a payment in XLM or any Stellar asset',
    inputSchema: z.object({
      destination: z.string().describe('Recipient Stellar address'),
      amount: z.string().describe('Amount to send'),
      assetCode: z.string().optional().describe('Asset code (e.g., USDC)'),
      assetIssuer: z.string().optional().describe('Asset issuer'),
      memo: z.string().optional().describe('Memo to attach'),
    }),
  },
  x402_respond: {
    name: 'x402_respond',
    description: 'Respond to an x402 payment challenge',
    inputSchema: z.object({
      resource: z.string(),
      amount: z.string(),
      assetCode: z.string().optional(),
      assetIssuer: z.string().optional(),
      payTo: z.string(),
      nonce: z.string(),
      expiresAt: z.string(),
    }),
  },
  soroban_invoke: {
    name: 'soroban_invoke',
    description: 'Invoke a Soroban smart contract',
    inputSchema: z.object({
      contractId: z.string(),
      method: z.string(),
      args: z.array(z.unknown()),
      simulateOnly: z.boolean().optional(),
    }),
  },
  soroban_query: {
    name: 'soroban_query',
    description: 'Read-only query to a Soroban contract',
    inputSchema: z.object({
      contractId: z.string(),
      method: z.string(),
      args: z.array(z.unknown()).optional(),
    }),
  },
  account_info: {
    name: 'account_info',
    description: 'Get account balances and details',
    inputSchema: z.object({
      publicKey: z.string().optional(),
    }),
  },
  balance_check: {
    name: 'balance_check',
    description: 'Check balance for a specific asset',
    inputSchema: z.object({
      assetCode: z.string(),
      assetIssuer: z.string().optional(),
      publicKey: z.string().optional(),
    }),
  },
  path_payment: {
    name: 'path_payment',
    description: 'Cross-asset path payment through Stellar DEX',
    inputSchema: z.object({
      destination: z.string(),
      sendAsset: z.union([z.string(), z.object({ code: z.string(), issuer: z.string() })]),
      sendMax: z.string(),
      destAsset: z.union([z.string(), z.object({ code: z.string(), issuer: z.string() })]),
      destAmount: z.string(),
    }),
  },
  swap: {
    name: 'swap',
    description: 'Swap one asset for another via DEX',
    inputSchema: z.object({
      sellAsset: z.object({ code: z.string(), issuer: z.string().optional() }),
      buyAsset: z.object({ code: z.string(), issuer: z.string().optional() }),
      sellAmount: z.string(),
      maxSlippagePct: z.number().min(0).max(100),
    }),
  },
  offer_book: {
    name: 'offer_book',
    description: 'Query Stellar DEX order book',
    inputSchema: z.object({
      sellingAsset: z.union([
        z.string(),
        z.object({ code: z.string(), issuer: z.string().optional() }),
      ]),
      buyingAsset: z.union([
        z.string(),
        z.object({ code: z.string(), issuer: z.string().optional() }),
      ]),
      limit: z.number().min(1).max(200).optional(),
    }),
  },
  dex_offer: {
    name: 'dex_offer',
    description: 'Place, update, or delete a DEX offer',
    inputSchema: z.object({
      action: z.enum(['create', 'update', 'delete']),
      selling: z.object({ code: z.string(), issuer: z.string().optional() }),
      buying: z.object({ code: z.string(), issuer: z.string().optional() }),
      amount: z.string(),
      price: z.string(),
      offerId: z.union([z.string(), z.number()]).optional(),
    }),
  },
} as const;

// Read-only tools that can run during planning
const READONLY_TOOLS = new Set([
  'account_info',
  'balance_check',
  'soroban_query',
  'offer_book',
  'ledger_info',
  'network_status',
]);

// ─── Prompt ───────────────────────────────────────────────────────────────────

const PLANNER_PROMPT = `You are a financial planning assistant for the Stellar blockchain. 
Given a user request, produce a sequence of tasks to execute.

Available tools:
${Object.values(TOOL_SCHEMAS)
  .map((t) => `- ${t.name}: ${t.description}`)
  .join('\n')}

Rules:
1. Only use value-moving tools (payment, swap, invoke) if explicitly requested
2. For financial swaps, first check the offer_book to find the best path
3. Validate all amounts are positive numbers
4. Output a JSON array of tasks, each with 'type' and 'payload'
5. Do NOT execute transactions during planning - only plan them

User request: {request}

Respond with JSON array of tasks:`;

// ─── Task parsing ─────────────────────────────────────────────────────────────

function parseTasks(response: string): AgentTask[] {
  try {
    const parsed = JSON.parse(response);
    const tasks = Array.isArray(parsed) ? parsed : [parsed];

    return tasks.map((task: { type: string; payload: unknown }) => {
      const taskType = task.type as TaskType;
      const schema = TOOL_SCHEMAS[taskType as keyof typeof TOOL_SCHEMAS];

      if (schema) {
        const validated = schema.inputSchema.parse(task.payload);
        return { type: taskType, payload: validated };
      }

      return { type: taskType, payload: task.payload };
    });
  } catch (err) {
    log.error({ error: err, response }, 'Failed to parse planner response');
    throw new Error('Failed to parse planner response');
  }
}

// ─── Policy validation ────────────────────────────────────────────────────────

/**
 * Validate a single task against policy.
 *
 * NOTE: The planner intentionally blocks value-moving tasks here — they should
 * only run during *execution*, not planning.  Read-only tasks are always
 * allowed.  Unknown types that are neither in TOOL_SCHEMAS nor READONLY_TOOLS
 * are rejected so the LLM cannot smuggle unexpected operations through.
 */
function validateTaskPolicy(task: AgentTask): { valid: boolean; reason?: string } {
  if (VALUE_MOVING_TASK_TYPES.has(task.type)) {
    return {
      valid: false,
      reason: `Value-moving tool ${task.type} cannot execute during planning`,
    };
  }

  const knownTypes = Object.keys(TOOL_SCHEMAS);
  if (!knownTypes.includes(task.type) && !READONLY_TOOLS.has(task.type)) {
    return { valid: false, reason: `Unknown task type: ${task.type}` };
  }

  return { valid: true };
}

// ─── Plan creation helpers ────────────────────────────────────────────────────

/**
 * Build a frozen Plan from a validated task list.
 *
 * The returned object is deep-frozen so callers cannot mutate it after the
 * hash is computed (issue #B).
 */
export function buildPlan(tasks: AgentTask[], expirationMs = 5 * 60 * 1000): Plan {
  const planHash = computePlanHash(tasks);
  const now = new Date();
  const plan: Plan = {
    id: `plan_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    tasks,
    summary: tasks.map((t) => `${t.type}`).join('; '),
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + expirationMs).toISOString(),
    planHash,
  };
  return deepFreeze(plan);
}

/**
 * Create an approval token bound to the plan's id, hash, and expiry.
 * Pass this token to `executePlan` to prove the plan was reviewed and has not
 * been tampered with.
 */
export function createApprovalToken(plan: Plan): PlanApprovalToken {
  return Object.freeze<PlanApprovalToken>({
    planId: plan.id,
    planHash: plan.planHash,
    expiresAt: plan.expiresAt,
  });
}

/**
 * Re-derive the hash from a plan and verify it matches the approval token.
 *
 * @throws PlanIntegrityError when:
 *   - The token is for a different plan.
 *   - The token is expired.
 *   - The recomputed hash does not match the token hash (tasks were mutated).
 */
export function verifyApprovalToken(plan: Plan, token: PlanApprovalToken): void {
  if (token.planId !== plan.id) {
    throw new PlanIntegrityError(
      `Approval token is for plan ${token.planId}, not ${plan.id}`
    );
  }
  if (new Date(token.expiresAt) < new Date()) {
    throw new PlanIntegrityError(
      `Approval token for plan ${plan.id} has expired`
    );
  }
  const recomputed = computePlanHash(plan.tasks);
  if (recomputed !== token.planHash) {
    throw new PlanIntegrityError(
      `Plan ${plan.id} hash mismatch: tasks were mutated after approval`
    );
  }
}

// ─── Planner class ────────────────────────────────────────────────────────────

/**
 * Planner — generates structured, frozen, integrity-stamped Plans from natural
 * language requests.
 */
export class Planner {
  private agent: PayFiAgent;
  private llmEndpoint?: string | undefined;
  private llmApiKey?: string | undefined;

  constructor(agent: PayFiAgent, options: { llmEndpoint?: string; llmApiKey?: string } = {}) {
    this.agent = agent;
    this.llmEndpoint = options.llmEndpoint ?? process.env.LLM_ENDPOINT;
    this.llmApiKey = options.llmApiKey ?? process.env.LLM_API_KEY;
  }

  /**
   * Generate a plan from a natural language request.
   *
   * Policy enforcement (issue #A):
   *   If ANY task fails `validateTaskPolicy`, the whole plan is rejected and a
   *   `PlanPolicyError` is thrown with per-task rejection reasons.  Dropping a
   *   task silently would produce a plan that does something different from what
   *   the user asked (e.g. keeping the payment while dropping the swap).
   *
   * @param request - User's natural-language request.
   * @param options.runReadonly - Whether to run read-only tools during planning (default: true).
   * @throws PlanPolicyError when any task fails policy.
   * @throws Error when the LLM is not configured or returns unparseable output.
   */
  async plan(request: string, options: { runReadonly?: boolean } = {}): Promise<Plan> {
    const { runReadonly = true } = options;

    log.info({ request }, 'Generating plan');

    const prompt = PLANNER_PROMPT.replace('{request}', request);

    let tasks: AgentTask[];
    if (this.llmEndpoint) {
      tasks = await this.callLLM(prompt);
    } else {
      throw new Error('LLM not configured. Set LLM_ENDPOINT environment variable.');
    }

    // ── Policy validation (issue #A) ─────────────────────────────────────────
    // Collect ALL rejections first so the error message is complete, then fail
    // the whole plan in one shot instead of silently dropping tasks.
    const rejections: Array<{ taskType: string; reason: string }> = [];
    for (const task of tasks) {
      const policy = validateTaskPolicy(task);
      if (!policy.valid) {
        log.warn({ taskType: task.type, reason: policy.reason }, 'Task failed policy check');
        rejections.push({ taskType: task.type, reason: policy.reason ?? 'policy violation' });
      }
    }

    if (rejections.length > 0) {
      throw new PlanPolicyError(rejections);
    }

    // ── Optional read-only pre-flight ────────────────────────────────────────
    for (const task of tasks) {
      if (runReadonly && READONLY_TOOLS.has(task.type)) {
        try {
          const result = await this.agent.run(task);
          if (result.success) {
            log.debug(
              { taskType: task.type, data: result.data },
              'Read-only tool executed during planning'
            );
          }
        } catch (err) {
          log.warn({ taskType: task.type, error: err }, 'Read-only tool failed during planning');
        }
      }
    }

    // ── Build frozen, hashed plan (issue #B) ─────────────────────────────────
    const plan = buildPlan(tasks);

    log.info({ planId: plan.id, taskCount: tasks.length, planHash: plan.planHash }, 'Plan generated');
    return plan;
  }

  private async callLLM(prompt: string): Promise<AgentTask[]> {
    if (!this.llmEndpoint) {
      throw new Error('LLM endpoint not configured');
    }

    const response = await fetch(this.llmEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.llmApiKey ? { Authorization: `Bearer ${this.llmApiKey}` } : {}),
      },
      body: JSON.stringify({
        model: process.env.LLM_MODEL ?? 'gpt-4',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
      }),
    });

    if (!response.ok) {
      throw new Error(`LLM call failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content ?? '';

    return parseTasks(content);
  }
}

export { PayFiAgent, AgentTask, Plan, TaskType };
