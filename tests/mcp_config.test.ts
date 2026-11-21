/**
 * tests/mcp_config.test.ts
 *
 * The MCP tool list is gated by the validated config, not by a raw
 * process.env string, and the registry/set agreement no longer has a dead
 * empty block (#916).
 */
import { describe, it, expect, vi } from 'vitest';

const cfg = vi.hoisted(() => ({
  MCP_ALLOW_PAYMENTS: false,
  HORIZON_URL: 'https://horizon-testnet.stellar.org',
  SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
  STELLAR_NETWORK: 'testnet',
}));
vi.mock('../backend/config', () => ({ config: cfg }));

import { getMCPTools } from '../backend/mcp/server';
import type { PayFiAgent } from '../backend/agent';

const tools = [
  { name: 'ledger_info', description: 'read', inputSchema: {}, valueMoving: false },
  { name: 'payment', description: 'pay', inputSchema: {}, valueMoving: true },
];

function agent(): PayFiAgent {
  return { getTools: () => tools } as unknown as PayFiAgent;
}

describe('MCP tool gating', () => {
  it('hides value-moving tools when the config disallows payments', () => {
    cfg.MCP_ALLOW_PAYMENTS = false;
    expect(getMCPTools(agent()).map(t => t.name)).toEqual(['ledger_info']);
  });

  it('exposes value-moving tools from the config value alone', () => {
    cfg.MCP_ALLOW_PAYMENTS = true;
    expect(getMCPTools(agent()).map(t => t.name)).toEqual(['ledger_info', 'payment']);
  });
});
