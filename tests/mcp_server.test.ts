/**
 * tests/mcp_server.test.ts
 *
 * Closes #913 — a malformed stdio line must not poison the JSON-RPC stream.
 * Each newline-delimited line is parsed on its own; bad input is answered with
 * -32700 / id: null, and later valid requests still get served.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../backend/config', () => ({
  config: {
    STELLAR_NETWORK: 'testnet',
    HORIZON_URL: 'https://horizon-testnet.stellar.org',
    SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
    AGENT_PUBLIC_KEY: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
    X402_ASSET_CODE: 'USDC',
    X402_ASSET_ISSUER: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    MAX_RETRIES: 3,
    RETRY_DELAY_MS: 100,
    AGENT_SPENDING_LIMIT: '100',
    QUEUE_CAPACITY: 5,
    MAX_CONCURRENT_TASKS: 1,
    agentKeypair: () => {
      throw new Error('not used in this test');
    },
  },
  MAINNET_SPENDING_CAP: 10_000,
}));

import type { PayFiAgent } from '../backend/agent';
import { createStdioLineHandler, MAX_LINE_LENGTH, type MCPResponse } from '../backend/mcp/server';

function makeAgent(): PayFiAgent {
  return {
    getTools: () => [],
    run: vi.fn(),
  } as unknown as PayFiAgent;
}

function collect(): { responses: MCPResponse[]; write: (r: MCPResponse) => void } {
  const responses: MCPResponse[] = [];
  return { responses, write: (r) => responses.push(r) };
}

describe('MCP stdio line handling', () => {
  it('answers a parse error and keeps serving the next valid request', async () => {
    const { responses, write } = collect();
    const handleLine = createStdioLineHandler(makeAgent(), write);

    await handleLine('{"jsonrpc":"2.0","id":1,'); // truncated JSON
    await handleLine('{"jsonrpc":"2.0","id":2,"method":"tools/list"}');

    expect(responses).toHaveLength(2);
    expect(responses[0]).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
    expect(responses[1]).toMatchObject({ jsonrpc: '2.0', id: 2, result: { tools: [] } });
    expect(responses[1]?.error).toBeUndefined();
  });

  it('rejects an oversized line with -32700 and keeps serving', async () => {
    const { responses, write } = collect();
    const handleLine = createStdioLineHandler(makeAgent(), write);

    await handleLine('x'.repeat(MAX_LINE_LENGTH + 1));
    await handleLine('{"jsonrpc":"2.0","id":3,"method":"tools/list"}');

    expect(responses).toHaveLength(2);
    expect(responses[0]).toMatchObject({ jsonrpc: '2.0', id: null });
    expect(responses[0]?.error?.code).toBe(-32700);
    expect(responses[1]).toMatchObject({ jsonrpc: '2.0', id: 3, result: { tools: [] } });
  });

  it('rejects valid JSON that is not a JSON-RPC request', async () => {
    const { responses, write } = collect();
    const handleLine = createStdioLineHandler(makeAgent(), write);

    await handleLine('[1,2,3]');

    expect(responses).toHaveLength(1);
    expect(responses[0]).toMatchObject({ jsonrpc: '2.0', id: null });
    expect(responses[0]?.error?.code).toBe(-32600);
  });
});
