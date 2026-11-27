/**
 * tests/mcp_server.test.ts
 *
 * Tests for backend/mcp/server.ts (#918): `handleRequest` for every method,
 * the MCP_ALLOW_PAYMENTS exposure rules, unknown / failing tools, plus one run
 * over each transport (stdio and HTTP).
 *
 * The agent is a stub exposing just what the server uses (`getTools`, `run`),
 * so no network or config is needed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'stream';
import type { AddressInfo } from 'net';

vi.mock('../backend/config', () => ({
  config: { STELLAR_NETWORK: 'testnet' },
}));

vi.mock('../backend/agent', () => ({
  PayFiAgent: class {},
  VALUE_MOVING_TASK_TYPES: new Set(['stellar_payment']),
}));

import {
  handleRequest,
  startMCPServer,
  startMCPHTTPServer,
  type MCPRequest,
} from '../backend/mcp/server';
import { ErrorType } from '../backend/errors';
import type { PayFiAgent } from '../backend/agent';

const TOOLS = [
  {
    name: 'balance_check',
    description: 'Check a balance',
    inputSchema: { type: 'object' },
    valueMoving: false,
  },
  {
    name: 'stellar_payment',
    description: 'Send a payment',
    inputSchema: { type: 'object' },
    valueMoving: true,
  },
];

function makeAgent() {
  const run = vi.fn().mockResolvedValue({ success: true, taskType: 'x', data: { ok: true } });
  const agent = { getTools: () => TOOLS, run } as unknown as PayFiAgent;
  return { agent, run };
}

const req = (method: string, params?: object): MCPRequest => ({
  jsonrpc: '2.0',
  id: 1,
  method,
  ...(params ? { params } : {}),
});

const toolNames = (result: unknown): string[] =>
  (result as { tools: { name: string }[] }).tools.map((t) => t.name);

beforeEach(() => {
  delete process.env.MCP_ALLOW_PAYMENTS;
  delete process.env.MCP_PAYMENT_MODE;
});

afterEach(() => {
  delete process.env.MCP_ALLOW_PAYMENTS;
  delete process.env.MCP_PAYMENT_MODE;
});

describe('handleRequest — initialize', () => {
  it('returns server info and only read-only tools by default', async () => {
    const { agent } = makeAgent();
    const res = await handleRequest(agent, req('initialize'));

    expect(res.error).toBeUndefined();
    expect(res.result).toMatchObject({
      protocolVersion: '2024-11-05',
      serverInfo: { name: 'nodal-ai' },
    });
    expect(toolNames(res.result)).toEqual(['balance_check']);
  });
});

describe('handleRequest — tools/list', () => {
  it('hides value-moving tools by default', async () => {
    const { agent } = makeAgent();
    const res = await handleRequest(agent, req('tools/list'));

    expect(toolNames(res.result)).toEqual(['balance_check']);
  });

  it('lists value-moving tools when MCP_ALLOW_PAYMENTS=true', async () => {
    process.env.MCP_ALLOW_PAYMENTS = 'true';
    const { agent } = makeAgent();
    const res = await handleRequest(agent, req('tools/list'));

    expect(toolNames(res.result)).toEqual(['balance_check', 'stellar_payment']);
  });

  it('exposes only name, description and inputSchema', async () => {
    const { agent } = makeAgent();
    const res = await handleRequest(agent, req('tools/list'));

    expect((res.result as { tools: object[] }).tools[0]).toEqual({
      name: 'balance_check',
      description: 'Check a balance',
      inputSchema: { type: 'object' },
    });
  });
});

describe('handleRequest — tools/call', () => {
  it('runs a read-only tool and returns its data as text content', async () => {
    const { agent, run } = makeAgent();
    const res = await handleRequest(
      agent,
      req('tools/call', { name: 'balance_check', arguments: { account: 'GABC' } })
    );

    expect(run).toHaveBeenCalledWith({ type: 'balance_check', payload: { account: 'GABC' } });
    expect(res.result).toEqual({ content: [{ type: 'text', text: '{"ok":true}' }] });
  });

  it('defaults arguments to an empty object', async () => {
    const { agent, run } = makeAgent();
    await handleRequest(agent, req('tools/call', { name: 'balance_check' }));

    expect(run).toHaveBeenCalledWith({ type: 'balance_check', payload: {} });
  });

  it('refuses a value-moving tool when payments are disabled', async () => {
    const { agent, run } = makeAgent();
    const res = await handleRequest(agent, req('tools/call', { name: 'stellar_payment' }));

    expect(res.error).toEqual({ code: -32601, message: 'Tool not found: stellar_payment' });
    expect(run).not.toHaveBeenCalled();
  });

  it('rejects an unknown tool', async () => {
    const { agent, run } = makeAgent();
    const res = await handleRequest(agent, req('tools/call', { name: 'nope' }));

    expect(res.error).toEqual({ code: -32601, message: 'Tool not found: nope' });
    expect(run).not.toHaveBeenCalled();
  });

  it('maps a failed tool result to a JSON-RPC error', async () => {
    const { agent, run } = makeAgent();
    run.mockResolvedValue({ success: false, taskType: 'balance_check', error: 'boom' });
    const res = await handleRequest(agent, req('tools/call', { name: 'balance_check' }));

    expect(res.error).toEqual({ code: -32000, message: 'boom' });
  });

  it('maps a thrown tool error to a JSON-RPC error', async () => {
    const { agent, run } = makeAgent();
    run.mockRejectedValue(new Error('exploded'));
    const res = await handleRequest(agent, req('tools/call', { name: 'balance_check' }));

    expect(res.error).toEqual({ code: -32000, message: 'exploded' });
  });

  it('routes a value-moving call through approval when payments are enabled', async () => {
    process.env.MCP_ALLOW_PAYMENTS = 'true';
    const { agent, run } = makeAgent();
    run.mockResolvedValue({
      success: false,
      taskType: 'stellar_payment',
      data: { status: 'pending_approval', approvalId: 'appr-1' },
      error: 'awaiting approval',
      errorType: ErrorType.PendingApproval,
    });
    const res = await handleRequest(
      agent,
      req('tools/call', {
        name: 'stellar_payment',
        arguments: { destination: 'GDESTINATION', amount: '5' },
      })
    );

    expect(run).toHaveBeenCalledWith(expect.objectContaining({ requireApproval: true }));
    const text = (res.result as { content: { text: string }[] }).content[0]!.text;
    expect(JSON.parse(text)).toMatchObject({
      status: 'pending_approval',
      approvalId: 'appr-1',
      summary: 'Send 5 XLM to GDESTINA...',
    });
  });
});

describe('handleRequest — unknown method', () => {
  it('returns method not found', async () => {
    const { agent } = makeAgent();
    const res = await handleRequest(agent, req('resources/list'));

    expect(res).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32601, message: 'Method not found: resources/list' },
    });
  });
});

describe('stdio transport', () => {
  it('reads a JSON-RPC request from stdin and writes the response to stdout', async () => {
    const stdin = new PassThrough();
    const originalStdin = Object.getOwnPropertyDescriptor(process, 'stdin')!;
    Object.defineProperty(process, 'stdin', { value: stdin, configurable: true });
    const written: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    });

    try {
      const { agent } = makeAgent();
      await startMCPServer(agent);
      stdin.write(JSON.stringify(req('tools/list')) + '\n');

      const responses = () =>
        written.filter((line) => line.startsWith('{"jsonrpc"')).map((line) => JSON.parse(line));
      await vi.waitFor(() => expect(responses()).toHaveLength(1));
      const [response] = responses();
      expect(response.id).toBe(1);
      expect(toolNames(response.result)).toEqual(['balance_check']);
    } finally {
      stdin.end();
      Object.defineProperty(process, 'stdin', originalStdin);
    }
  });
});

describe('HTTP transport', () => {
  it('serves POST /mcp and GET /mcp/tools', async () => {
    const { agent } = makeAgent();
    const server = startMCPHTTPServer(agent, 0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    try {
      const post = await fetch(`${base}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req('tools/list')),
      });
      expect(post.status).toBe(200);
      expect(toolNames((await post.json()).result)).toEqual(['balance_check']);

      const get = await fetch(`${base}/mcp/tools`);
      expect(toolNames(await get.json())).toEqual(['balance_check']);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
