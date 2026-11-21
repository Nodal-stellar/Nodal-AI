/**
 * tests/mcp_value_moving_gating.test.ts
 *
 * Regression tests for issue #948 — the MCP gateway must treat every task in
 * VALUE_MOVING_TASK_TYPES as payment-gated, not just the tools whose registry
 * entry happens to carry `valueMoving: true`. Before the fix, `nano_payment`
 * was missing from VALUE_MOVING_TASK_TYPES, so it stayed reachable over MCP
 * (and through the agent's kill switch) even with MCP_ALLOW_PAYMENTS=false.
 *
 * Covers the gateway paths directly:
 *   - getMCPTools()            (used by /mcp/tools and initialize)
 *   - handleRequest tools/list (stdio + HTTP POST /mcp)
 *   - handleRequest tools/call (must refuse gated tools with -32601)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PayFiAgent, VALUE_MOVING_TASK_TYPES, type AgentTask } from '../backend/agent';
import { getMCPTools, handleRequest } from '../backend/mcp/server';
import { config } from '../backend/config';
import { spendingTracker } from '../backend/agent';

const { log } = vi.hoisted(() => {
  const log: Record<string, ReturnType<typeof vi.fn>> = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
  log.child!.mockReturnValue(log);
  return { log };
});

vi.mock('../backend/utils/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../backend/utils/logger')>()),
  logger: log,
  createLogger: () => log,
}));

vi.mock('../backend/persistence', () => ({
  getDb: vi.fn(() => ({})),
  saveResult: vi.fn(),
  saveTrackedSpendingRecord: vi.fn(),
  deleteTrackedSpendingRecord: vi.fn(),
  clearSpendingRecords: vi.fn(),
  getSpendingRecordsSince: vi.fn(() => []),
  pruneSpendingRecords: vi.fn(),
  loadRecentSpend: vi.fn(() => 0),
  appendAuditEntry: vi.fn(),
  savePendingApproval: vi.fn(),
  getPendingApproval: vi.fn(),
  listPendingApprovals: vi.fn(() => []),
  decideApproval: vi.fn(() => true),
  expirePendingApprovals: vi.fn(() => []),
  getIdempotencyResult: vi.fn(),
  saveIdempotencyResult: vi.fn(),
  pruneIdempotencyKeys: vi.fn(),
  loadAgentState: vi.fn(() => null),
  saveAgentState: vi.fn(),
}));

vi.mock('../backend/webhook', () => ({ dispatchWebhook: vi.fn().mockResolvedValue(undefined) }));

vi.mock('../backend/config', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Keypair } = require('@stellar/stellar-sdk');
  const secret = Keypair.random().secret();
  return {
    config: {
      STELLAR_NETWORK: 'testnet',
      HORIZON_URL: 'https://horizon-testnet.stellar.org',
      SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
      AGENT_PUBLIC_KEY: Keypair.fromSecret(secret).publicKey(),
      X402_ASSET_CODE: 'USDC',
      X402_ASSET_ISSUER: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      MAX_RETRIES: 3,
      RETRY_DELAY_MS: 100,
      AGENT_SPENDING_LIMIT: '1000',
      SPENDING_LIMITS_MAP: new Map<string, string>(),
      SPENDING_LIMITS_ALLOW_UNKNOWN: true,
      SPENDING_WINDOW_MS: 86_400_000,
      QUEUE_CAPACITY: 0,
      MAX_CONCURRENT_TASKS: 10,
      PAYMENT_DESTINATION_POLICY: 'open',
      PAYMENT_DESTINATIONS: [],
      NANO_RPC_URL: 'http://127.0.0.1:7076',
      agentKeypair: () => Keypair.fromSecret(secret),
      // Flipped per test to exercise both sides of the payment gate.
      get MCP_ALLOW_PAYMENTS() {
        return (globalThis as Record<string, unknown>).__mcpAllowPayments === true;
      },
    },
    MAINNET_SPENDING_CAP: 10_000,
    getNanoSeed: () => undefined,
  };
});

const NANO_RECIPIENT = 'nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3';
const nanoTask: AgentTask = {
  type: 'nano_payment',
  payload: { recipient: NANO_RECIPIENT, amountRaw: '1000000' },
};

const mutableConfig = config as unknown as Record<string, unknown>;

describe('MCP gateway — value-moving gating (#948)', () => {
  let agent: PayFiAgent;
  let nanoExecute: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    (globalThis as Record<string, unknown>).__mcpAllowPayments = false;
    spendingTracker.clear();
    vi.clearAllMocks();
    agent = new PayFiAgent();
    nanoExecute = vi.fn().mockResolvedValue({
      blockHash: 'mock_block',
      recipient: NANO_RECIPIENT,
      amountRaw: '1000000',
      network: 'nano',
      precheckPassed: true,
      timestamp: new Date().toISOString(),
    });
    (agent as unknown as Record<string, unknown>).nanoPaymentTool = { execute: nanoExecute };
  });

  afterEach(() => {
    agent.destroy();
    (globalThis as Record<string, unknown>).__mcpAllowPayments = false;
    delete mutableConfig.APPROVAL_THRESHOLD;
  });

  it('registers nano_payment as a value-moving built-in tool', () => {
    const nano = agent.getTools().find((tool) => tool.name === 'nano_payment');
    expect(nano).toBeDefined();
    expect(nano!.valueMoving).toBe(true);
    expect(VALUE_MOVING_TASK_TYPES.has('nano_payment')).toBe(true);
  });

  it('hides every VALUE_MOVING_TASK_TYPES member from MCP by default', () => {
    const names = getMCPTools(agent).map((tool) => tool.name);

    expect(names).toContain('account_info');
    expect(names).toContain('balance_check');
    expect(names).not.toContain('nano_payment');
    expect(names).not.toContain('stellar_payment');
    expect(names).not.toContain('x402_respond');

    // Every registry tool whose type is in the kill-switch set must be gated,
    // even when its registry flag says otherwise (defense in depth).
    for (const tool of agent.getTools()) {
      if (VALUE_MOVING_TASK_TYPES.has(tool.name)) {
        expect(names).not.toContain(tool.name);
      }
    }
  });

  it('marks set members as valueMoving in the MCP catalog even if the registry flag is false', () => {
    (globalThis as Record<string, unknown>).__mcpAllowPayments = true;
    const catalog = new Map(getMCPTools(agent).map((tool) => [tool.name, tool.valueMoving]));

    for (const tool of agent.getTools()) {
      if (VALUE_MOVING_TASK_TYPES.has(tool.name)) {
        expect(catalog.get(tool.name)).toBe(true);
      }
    }
    expect(catalog.get('nano_payment')).toBe(true);
  });

  it('exposes value-moving tools (including nano_payment) when MCP_ALLOW_PAYMENTS=true', () => {
    (globalThis as Record<string, unknown>).__mcpAllowPayments = true;
    const names = getMCPTools(agent).map((tool) => tool.name);

    expect(names).toContain('nano_payment');
    expect(names).toContain('stellar_payment');
  });

  it('tools/list omits nano_payment while payments are disallowed', async () => {
    const response = await handleRequest(agent, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });

    const tools = (response.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).not.toContain('nano_payment');
    expect(tools.map((t) => t.name)).toContain('account_info');
  });

  it('initialize advertises no nano_payment while payments are disallowed', async () => {
    const response = await handleRequest(agent, {
      jsonrpc: '2.0',
      id: 'init',
      method: 'initialize',
    });

    const tools = (response.result as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).not.toContain('nano_payment');
  });

  it('tools/call nano_payment is refused with -32601 while payments are disallowed', async () => {
    const response = await handleRequest(agent, {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'nano_payment', arguments: nanoTask.payload },
    });

    expect(response.error?.code).toBe(-32601);
    expect(response.error?.message).toMatch(/Tool not found: nano_payment/);
    expect(nanoExecute).not.toHaveBeenCalled();
  });

  it('tools/call nano_payment reaches the agent when MCP_ALLOW_PAYMENTS=true', async () => {
    (globalThis as Record<string, unknown>).__mcpAllowPayments = true;

    const response = await handleRequest(agent, {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: { name: 'nano_payment', arguments: nanoTask.payload },
    });

    expect(response.error).toBeUndefined();
    expect(nanoExecute).toHaveBeenCalledTimes(1);
    expect(nanoExecute).toHaveBeenCalledWith(nanoTask.payload);
    const content = (response.result as { content: { text: string }[] }).content;
    expect(JSON.parse(content[0]!.text)).toMatchObject({
      blockHash: 'mock_block',
      network: 'nano',
    });
  });

  it('tools/call on a read-only tool still works while payments are disallowed', async () => {
    const response = await handleRequest(agent, {
      jsonrpc: '2.0',
      id: 9,
      method: 'tools/call',
      params: { name: 'account_info', arguments: {} },
    });

    // account_info runs against the real (unmocked) AccountInfoTool here; what
    // matters for the gateway is that it was NOT refused as a gated tool.
    expect(response.error?.code).not.toBe(-32601);
  });

  it('gateway set and kill-switch set agree for every registered tool (#948 invariant)', () => {
    // The MCP gate keys off VALUE_MOVING_TASK_TYPES, the same set the kill
    // switch uses, so the two can never disagree about a payment rail again.
    for (const tool of agent.getTools()) {
      const inSet = VALUE_MOVING_TASK_TYPES.has(tool.name);
      if (inSet) {
        // Gated by default …
        (globalThis as Record<string, unknown>).__mcpAllowPayments = false;
        expect(getMCPTools(agent).map((t) => t.name)).not.toContain(tool.name);
        // … and exposed only when payments are explicitly allowed.
        (globalThis as Record<string, unknown>).__mcpAllowPayments = true;
        expect(getMCPTools(agent).map((t) => t.name)).toContain(tool.name);
      }
    }
    (globalThis as Record<string, unknown>).__mcpAllowPayments = false;
  });
});
