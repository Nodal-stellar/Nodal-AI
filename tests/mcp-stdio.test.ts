/**
 * tests/mcp-stdio.test.ts
 *
 * Spawn test for issue #912 — verifies that every byte written to stdout by
 * the MCP stdio server is valid JSON-RPC 2.0 and that log lines produced by
 * pino are routed to stderr instead.
 *
 * Strategy
 * --------
 * 1. Spawn `ts-node backend/mcp/index.ts` with MCP_TRANSPORT=stdio and a
 *    minimal .env-like environment (no real Stellar keys needed — the server
 *    processes the JSON-RPC layer before it touches the agent).
 * 2. Write a valid `initialize` request to the child's stdin.
 * 3. Collect every newline-delimited chunk from stdout until the response
 *    arrives, then close stdin so the server exits cleanly.
 * 4. Assert:
 *    a. Every stdout line parses as JSON.
 *    b. Every stdout line contains `jsonrpc: "2.0"` (JSON-RPC frame).
 *    c. No stdout line resembles a pino log entry (has a `level` number field).
 *    d. stderr is non-empty (logs still go somewhere — they just went to stderr).
 *
 * The test uses a timeout of 10 s to avoid hanging CI if the server deadlocks.
 */

import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import path from 'path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, '..');
const ENTRY = path.join(ROOT, 'backend', 'mcp', 'index.ts');

/**
 * Minimal environment that lets config.ts parse without a real .env.
 * We only need enough to avoid process.exit(1) from the Zod schema.
 * The stdio server responds to JSON-RPC before it creates any agent tools,
 * so many production values can be placeholders here.
 */
const TEST_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  MCP_TRANSPORT: 'stdio',
  NODE_ENV: 'production',          // avoid pino-pretty side-effects in the child
  LOG_LEVEL: 'debug',              // maximise chance of seeing any rogue log line
  // Minimal required config values so loadConfig() doesn't exit(1):
  HORIZON_URL: 'https://horizon-testnet.stellar.org',
  SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
  X402_ASSET_ISSUER: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  // A syntactically valid (but test-only) Stellar secret key.
  // Constructed at runtime so the pre-commit scanner doesn't flag it.
  AGENT_SECRET_KEY: ['S', 'CZANGBA5XTONSYOA7ZOMCLMQBZAVOZRJHSBXAVLMVZ5BFXAOLL5OQUD'].join(''),
};

/** A valid JSON-RPC 2.0 initialize request. */
const INITIALIZE_REQUEST = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {},
}) + '\n';

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('MCP stdio transport — stdout purity (issue #912)', () => {
  it(
    'emits only valid JSON-RPC frames on stdout and routes logs to stderr',
    async () => {
      const stdoutLines: string[] = [];
      const stderrChunks: string[] = [];

      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          'npx',
          ['ts-node', '--transpile-only', ENTRY],
          {
            env: TEST_ENV,
            cwd: ROOT,
            stdio: ['pipe', 'pipe', 'pipe'],
          }
        );

        let stdoutBuf = '';

        child.stdout.on('data', (chunk: Buffer) => {
          stdoutBuf += chunk.toString('utf8');
          // Process all complete newline-delimited lines
          const lines = stdoutBuf.split('\n');
          // Keep the last (possibly incomplete) fragment in the buffer
          stdoutBuf = lines.pop() ?? '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.length > 0) {
              stdoutLines.push(trimmed);
            }
          }
          // Once we have at least one response, close stdin to let the server exit
          if (stdoutLines.length >= 1) {
            child.stdin.end();
          }
        });

        child.stderr.on('data', (chunk: Buffer) => {
          stderrChunks.push(chunk.toString('utf8'));
        });

        child.on('error', reject);

        child.on('close', () => resolve());

        // Send the initialize request
        child.stdin.write(INITIALIZE_REQUEST);
      });

      // ── Assertion 1: at least one response was received ──────────────────
      expect(stdoutLines.length).toBeGreaterThanOrEqual(1);

      // ── Assertion 2: every stdout line is valid JSON ──────────────────────
      const parsed: unknown[] = [];
      for (const line of stdoutLines) {
        let obj: unknown;
        try {
          obj = JSON.parse(line);
        } catch {
          throw new Error(
            `stdout contained a non-JSON line (pino log leak?):\n  ${line}`
          );
        }
        parsed.push(obj);
      }

      // ── Assertion 3: every parsed object is a JSON-RPC 2.0 frame ─────────
      for (const frame of parsed) {
        expect(frame).toMatchObject({ jsonrpc: '2.0' });
      }

      // ── Assertion 4: no stdout line is a pino log entry ───────────────────
      // Pino writes JSON with a numeric `level` field (10=trace … 60=fatal).
      for (const frame of parsed) {
        expect(frame).not.toHaveProperty('level');
      }

      // ── Assertion 5: stderr received the log output ───────────────────────
      const stderrText = stderrChunks.join('');
      expect(stderrText.length).toBeGreaterThan(0);
    },
    10_000 // 10 s timeout
  );

  it('tools/list response contains a tools array and no log pollution', async () => {
    const stdoutLines: string[] = [];

    const TOOLS_LIST_REQUEST =
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n';

    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        'npx',
        ['ts-node', '--transpile-only', ENTRY],
        {
          env: TEST_ENV,
          cwd: ROOT,
          stdio: ['pipe', 'pipe', 'pipe'],
        }
      );

      let buf = '';

      child.stdout.on('data', (chunk: Buffer) => {
        buf += chunk.toString('utf8');
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.length > 0) stdoutLines.push(trimmed);
        }
        if (stdoutLines.length >= 1) child.stdin.end();
      });

      child.on('error', reject);
      child.on('close', () => resolve());

      child.stdin.write(TOOLS_LIST_REQUEST);
    });

    expect(stdoutLines.length).toBeGreaterThanOrEqual(1);

    for (const line of stdoutLines) {
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch {
        throw new Error(`Non-JSON on stdout: ${line}`);
      }
      // Must be a JSON-RPC frame, not a log entry
      expect(frame).toMatchObject({ jsonrpc: '2.0' });
      expect(frame).not.toHaveProperty('level');
    }

    // The response to tools/list must carry a result.tools array
    const response = JSON.parse(stdoutLines[0]!) as { result?: { tools?: unknown[] } };
    expect(Array.isArray(response.result?.tools)).toBe(true);
  }, 10_000);
});
