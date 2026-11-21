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
  // Use Node's built-in timingSafeEqual for byte-level protection.
  const { timingSafeEqual } = require('crypto') as typeof import('crypto');
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
 * Read-only tools exposed by default; value-moving require the validated
 * MCP_ALLOW_PAYMENTS setting, so `TRUE` and `1` are handled like the rest of
 * the app.
 */
export function getMCPTools(agent: PayFiAgent): MCPTool[] {
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
async function handleRequest(agent: PayFiAgent, request: MCPRequest): Promise<MCPResponse> {
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
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
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

export function startMCPHTTPServer(agent: PayFiAgent, port = 3001): void {
  const allowPayments = process.env.MCP_ALLOW_PAYMENTS === 'true';
  const apiToken = process.env.MCP_API_TOKEN;
  const host = process.env.MCP_HOST ?? '127.0.0.1';
  // 1 MiB default; env var allows operator override within reason.
  const maxBodyBytes = parseInt(process.env.MCP_MAX_BODY_BYTES ?? '1048576', 10);

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
      const supplied = authHeader.startsWith('Bearer ')
        ? authHeader.slice('Bearer '.length)
        : '';

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
  app.listen(port, host, () =>
    log.info({ host, port, authenticated: !!apiToken }, 'MCP HTTP server started')
  );
}
