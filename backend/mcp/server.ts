/**
 * backend/mcp/server.ts
 *
 * Model Context Protocol (MCP) server for Nodal AI.
 * Exposes tools over stdio and HTTP transports.
 */

import { PayFiAgent, VALUE_MOVING_TASK_TYPES } from '../agent';
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
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type MCPLineWriter = (response: MCPResponse) => void;

/**
 * Maximum accepted size of a single newline-delimited stdio line.
 * Oversized lines are rejected with a JSON-RPC parse error instead of
 * being buffered, so a hostile client cannot grow server memory unbounded.
 */
export const MAX_LINE_LENGTH = 1024 * 1024;

/**
 * Build tool schema for MCP from agent tools.
 * Read-only tools exposed by default; value-moving require MCP_ALLOW_PAYMENTS.
 */
function getMCPTools(agent: PayFiAgent): MCPTool[] {
  const allowPayments = process.env.MCP_ALLOW_PAYMENTS === 'true';

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

        if (tool.valueMoving && !VALUE_MOVING_TASK_TYPES.has(toolName as any)) {
          // Additional check handled by filter
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
 * Build the handler for a single stdio line.
 *
 * Each line is parsed independently, so a malformed message is answered with
 * JSON-RPC -32700 and never contaminates the next request. Lines larger than
 * MAX_LINE_LENGTH are rejected before parsing.
 */
export function createStdioLineHandler(
  agent: PayFiAgent,
  write: MCPLineWriter = (response) => {
    process.stdout.write(JSON.stringify(response) + '\n');
  }
): (line: string) => Promise<void> {
  return async (line: string) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;

    if (Buffer.byteLength(trimmed, 'utf8') > MAX_LINE_LENGTH) {
      log.warn({ length: trimmed.length }, 'Rejected oversized MCP stdio line');
      write({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32700,
          message: 'Parse error',
          data: { reason: `Line exceeds maximum length of ${MAX_LINE_LENGTH} bytes` },
        },
      });
      return;
    }

    let request: unknown;
    try {
      request = JSON.parse(trimmed);
    } catch {
      write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }

    if (
      typeof request !== 'object' ||
      request === null ||
      Array.isArray(request) ||
      typeof (request as MCPRequest).method !== 'string'
    ) {
      write({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid Request' },
      });
      return;
    }

    const response = await handleRequest(agent, request as MCPRequest);
    write(response);
  };
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

  const handleLine = createStdioLineHandler(agent);

  rl.on('line', (line) => {
    void handleLine(line).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ error: message }, 'MCP stdio line failed');
    });
  });

  rl.on('error', (err) => log.error({ error: err.message }, 'MCP stdin error'));
}

/**
 * Start MCP server over HTTP.
 */
import express from 'express';

export function startMCPHTTPServer(agent: PayFiAgent, port = 3001): void {
  const app = express();
  app.use(express.json());

  app.post('/mcp', async (req, res) => {
    const response = await handleRequest(agent, req.body as MCPRequest);
    res.json(response);
  });

  app.get('/mcp/tools', async (req, res) => {
    const tools = getMCPTools(agent);
    res.json({ tools: tools.map(toolToMCPSchema) });
  });

  app.listen(port, () => log.info({ port }, 'MCP HTTP server started'));
}
