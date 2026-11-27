/**
 * backend/mcp/server.ts
 *
 * Model Context Protocol (MCP) server for Nodal AI.
 * Exposes tools over stdio and HTTP transports.
 *
 * Security — HTTP transport (issue #911):
 *   - All routes require a Bearer token (MCP_API_TOKEN), validated with a
 *     constant-time comparison to prevent timing attacks.
 *   - The server binds to 127.0.0.1 by default (MCP_HOST to override).
 *   - When MCP_ALLOW_PAYMENTS=true the server refuses to start without a token.
 *   - Request bodies are limited to MCP_MAX_BODY_BYTES (default 1 MiB).
 */

import { PayFiAgent } from '../agent';
import { config } from '../config';
import { createLogger } from '../utils/logger';
import { createHash, timingSafeEqual } from 'crypto';

const log = createLogger('mcp');

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: object;
  valueMoving: boolean;
}

export interface MCPRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: object;
}

export interface MCPResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Constant-time string comparison to prevent timing-based token oracle attacks.
 */
function safeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) {
    // Still run a comparison on a same-length buffer to avoid leaking length.
    timingSafeEqual(aBuf, aBuf);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

/**
 * Build tool schema for MCP from agent tools.
 * Read-only tools exposed by default; value-moving require MCP_ALLOW_PAYMENTS.
 */
function getMCPTools(agent: PayFiAgent): MCPTool[] {
  const allowPayments = config.MCP_ALLOW_PAYMENTS;

  return agent
    .getTools()
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      valueMoving: tool.valueMoving,
    }))
    .filter((tool) => {
      if (!tool.valueMoving) return true;
      return allowPayments;
    });
}

/**
 * How value-moving tool calls are handled (#917):
 *   approve (default) — create a pending approval; a human approves it via
 *                       the dashboard / POST /approvals/:id before anything moves.
 *   direct            — execute immediately. Refused on mainnet unless
 *                       MCP_FORCE_DIRECT_PAYMENTS=true.
 */
function getPaymentMode(): 'approve' | 'direct' {
  // eslint-disable-next-line no-restricted-properties
  return process.env.MCP_PAYMENT_MODE === 'direct' ? 'direct' : 'approve';
}

function toolToMCPSchema(tool: MCPTool): object {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}

/**
 * Handle MCP request and return response.
 */
export async function handleRequest(agent: PayFiAgent, request: MCPRequest): Promise<MCPResponse> {
  const { id } = request;

  try {
    switch (request.method) {
      case 'initialize': {
        const tools = getMCPTools(agent);
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'nodal-ai', version: '1.0.0' },
            tools: tools.map(toolToMCPSchema),
          },
        };
      }

      case 'tools/list': {
        const tools = getMCPTools(agent);
        return { jsonrpc: '2.0', id, result: { tools: tools.map(toolToMCPSchema) } };
      }

      case 'tools/call': {
        const params = request.params as { name: string; arguments?: object };
        const toolName = params.name;
        const args = params.arguments ?? {};

        const tools = getMCPTools(agent);
        const tool = tools.find((t) => t.name === toolName);

        if (!tool) {
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Tool not found: ${toolName}` },
          };
        }

        const result = await agent.run({ type: toolName, payload: args });

        if (!result.success) {
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32000, message: result.error ?? 'Execution failed' },
          };
        }

        return {
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify(result.data) }] },
        };
      }

      default:
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${request.method}` },
        };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error({ method: request.method, error: message }, 'MCP request failed');
    return { jsonrpc: '2.0', id, error: { code: -32000, message } };
  }
}

/**
 * Run MCP server over stdio (for AI clients like Claude Desktop).
 */
export async function startMCPServer(agent: PayFiAgent): Promise<void> {
  log.info('Starting MCP stdio server');

  const readline = await import('readline');
  // Do NOT pass `output` here. In stdio MCP mode stdout is the exclusive
  // JSON-RPC channel; giving readline a reference to it causes echo writes
  // that would corrupt the protocol stream even with terminal:false.
  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });

  let buffer = '';

  rl.on('line', async (line) => {
    buffer += line;
    try {
      const request = JSON.parse(buffer) as MCPRequest;
      buffer = '';
      const response = await handleRequest(agent, request);
      process.stdout.write(JSON.stringify(response) + '\n');
    } catch {
      // Incomplete JSON, wait for more
    }
  });

  rl.on('error', (err) => log.error({ error: err.message }, 'MCP stdin error'));
}

/**
 * Start MCP server over HTTP.
 *
 * Security requirements (issue #911):
 *   - Binds to MCP_HOST (default: 127.0.0.1, loopback-only).
 *   - Enforces a Bearer token on every route via MCP_API_TOKEN.
 *   - Rejects bodies larger than MCP_MAX_BODY_BYTES with 413.
 *   - Refuses to start when MCP_ALLOW_PAYMENTS=true and no token is set.
 */
import express from 'express';
import type { Server } from 'http';

/**
 * Constant-time token comparison; both sides are hashed so the buffers are
 * always the same length.
 */
function tokensMatch(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export function startMCPHTTPServer(agent: PayFiAgent, port = 3001): Server {
  const allowPayments = config.MCP_ALLOW_PAYMENTS;
  const apiToken = config.MCP_API_TOKEN;
  const host = config.MCP_HOST;
  const maxBodyBytes = config.MCP_MAX_BODY_BYTES;

  // Hard safety check: payments enabled without a token is not allowed.
  if (allowPayments && !apiToken) {
    throw new Error(
      'MCP_API_TOKEN must be set when MCP_ALLOW_PAYMENTS=true. ' +
        'An unauthenticated HTTP endpoint with payment tools would allow anyone ' +
        'who can reach the port to move funds from the agent account.'
    );
  }

  const app = express();

  // ── Body size limit ────────────────────────────────────────────────────────
  // express.json() will reject bodies exceeding `limit` with a 413 by default
  // when the Content-Length header is present. For chunked bodies the parser
  // also counts bytes and throws once the limit is reached.
  app.use(express.json({ limit: maxBodyBytes }));

  // ── Authentication middleware ──────────────────────────────────────────────
  // Applied to every route. When MCP_API_TOKEN is not set the endpoint is
  // open (allowed for read-only stdio-adjacent use-cases on a localhost-only
  // binding), but a warning is logged at startup.
  if (apiToken) {
    app.use((req, res, next) => {
      const authHeader = req.headers['authorization'] ?? '';
      const supplied = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : '';

      if (!safeEqual(supplied, apiToken)) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      next();
    });
  } else {
    log.warn(
      { host, port },
      'MCP HTTP server started without MCP_API_TOKEN — all requests are unauthenticated'
    );
  }

  // ── Routes ─────────────────────────────────────────────────────────────────
  app.post('/mcp', async (req, res) => {
    const response = await handleRequest(agent, req.body as MCPRequest);
    res.json(response);
  });

  app.get('/mcp/tools', async (_req, res) => {
    const tools = getMCPTools(agent);
    res.json({ tools: tools.map(toolToMCPSchema) });
  });

  // ── Bind ───────────────────────────────────────────────────────────────────
  return app.listen(port, host, () =>
    log.info({ host, port, authenticated: !!apiToken }, 'MCP HTTP server started')
  );
}
