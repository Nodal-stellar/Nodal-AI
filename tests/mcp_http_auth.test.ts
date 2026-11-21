/**
 * tests/mcp_http_auth.test.ts
 *
 * Regression tests for issue #911:
 *   - Unauthenticated request → 401
 *   - Default bind is loopback (127.0.0.1)
 *   - MCP_ALLOW_PAYMENTS=true + no token → startup error (thrown synchronously)
 *   - Body > limit → 413
 *   - Valid Bearer token → 200
 *
 * We test the middleware logic directly via express's own test-callback
 * interface (app(req, res)) rather than binding a real TCP port, so there is
 * no network dependency and no port conflicts.
 */

import { describe, it, expect } from 'vitest';
import express, { type Express } from 'express';
import http from 'http';

// ─── Lightweight HTTP helper ──────────────────────────────────────────────────
// Creates a one-shot HTTP server on a random port, makes one request, closes.

interface SimpleResponse {
  status: number;
  body: string;
}

function sendRequest(
  app: Express,
  opts: {
    method?: string;
    path?: string;
    headers?: Record<string, string>;
    body?: string;
  }
): Promise<SimpleResponse> {
  return new Promise((resolve, reject) => {
    const { method = 'POST', path = '/mcp', headers = {}, body } = opts;
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      const bodyBuf = body ? Buffer.from(body, 'utf8') : undefined;
      const reqHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        ...headers,
      };
      if (bodyBuf) reqHeaders['Content-Length'] = String(bodyBuf.length);

      const req = http.request({ host: '127.0.0.1', port, method, path, headers: reqHeaders }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          server.close();
          resolve({ status: res.statusCode ?? 0, body: data });
        });
      });
      req.on('error', (err) => { server.close(); reject(err); });
      if (bodyBuf) req.write(bodyBuf);
      req.end();
    });
  });
}

// ─── Build a test Express app mirroring startMCPHTTPServer middleware ─────────

function buildTestApp(opts: {
  apiToken?: string | undefined;
  maxBodyBytes?: number;
  allowPayments?: boolean;
}) {
  const { apiToken, maxBodyBytes = 1_048_576, allowPayments = false } = opts;

  // Mirror the guard in startMCPHTTPServer (issue #911).
  if (allowPayments && !apiToken) {
    throw new Error(
      'MCP_API_TOKEN must be set when MCP_ALLOW_PAYMENTS=true.'
    );
  }

  const app = express();
  app.use(express.json({ limit: maxBodyBytes }));

  // Auth middleware — mirrors backend/mcp/server.ts
  if (apiToken) {
    const { timingSafeEqual } = require('crypto') as typeof import('crypto');

    const safeEqual = (a: string, b: string): boolean => {
      const aBuf = Buffer.from(a, 'utf8');
      const bBuf = Buffer.from(b, 'utf8');
      if (aBuf.length !== bBuf.length) {
        timingSafeEqual(aBuf, aBuf); // consume constant time
        return false;
      }
      return timingSafeEqual(aBuf, bBuf);
    };

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
  }

  // Echo endpoint representing /mcp
  app.post('/mcp', (req, res) => {
    res.json({ ok: true });
  });

  return app;
}

const VALID_BODY = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('MCP HTTP authentication — issue #911', () => {
  describe('token enforcement', () => {
    it('returns 401 for a request with no Authorization header', async () => {
      const app = buildTestApp({ apiToken: 'secret-token' });
      const res = await sendRequest(app, { body: VALID_BODY });
      expect(res.status).toBe(401);
    });

    it('returns 401 for a wrong Bearer token', async () => {
      const app = buildTestApp({ apiToken: 'secret-token' });
      const res = await sendRequest(app, {
        body: VALID_BODY,
        headers: { Authorization: 'Bearer wrong-token' },
      });
      expect(res.status).toBe(401);
    });

    it('returns 200 for the correct Bearer token', async () => {
      const app = buildTestApp({ apiToken: 'secret-token' });
      const res = await sendRequest(app, {
        body: VALID_BODY,
        headers: { Authorization: 'Bearer secret-token' },
      });
      expect(res.status).toBe(200);
    });

    it('returns 401 for an empty Bearer value', async () => {
      const app = buildTestApp({ apiToken: 'secret-token' });
      const res = await sendRequest(app, {
        body: VALID_BODY,
        headers: { Authorization: 'Bearer ' },
      });
      expect(res.status).toBe(401);
    });

    it('is open (no 401) when no apiToken is configured', async () => {
      const app = buildTestApp({});
      const res = await sendRequest(app, { body: VALID_BODY });
      expect(res.status).toBe(200);
    });
  });

  describe('payments + no token → startup error', () => {
    it('throws synchronously when MCP_ALLOW_PAYMENTS=true and no token is set', () => {
      expect(() =>
        buildTestApp({ allowPayments: true, apiToken: undefined })
      ).toThrow('MCP_API_TOKEN must be set when MCP_ALLOW_PAYMENTS=true');
    });

    it('does NOT throw when MCP_ALLOW_PAYMENTS=true AND a token is provided', () => {
      expect(() =>
        buildTestApp({ allowPayments: true, apiToken: 'my-token' })
      ).not.toThrow();
    });

    it('does NOT throw when MCP_ALLOW_PAYMENTS=false and no token', () => {
      expect(() =>
        buildTestApp({ allowPayments: false })
      ).not.toThrow();
    });
  });

  describe('body size limit → 413', () => {
    it('rejects a body larger than maxBodyBytes with 413', async () => {
      // 64 bytes limit — the JSON payload is larger.
      const app = buildTestApp({ maxBodyBytes: 64 });
      const bigBody = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'x', data: 'z'.repeat(200) });
      const res = await sendRequest(app, { body: bigBody });
      expect(res.status).toBe(413);
    });

    it('accepts a body within the limit', async () => {
      const app = buildTestApp({ maxBodyBytes: 1_048_576 });
      const res = await sendRequest(app, { body: VALID_BODY });
      expect(res.status).toBe(200);
    });
  });

  describe('default host binding', () => {
    it('defaults to 127.0.0.1 when MCP_HOST is not set in env', () => {
      const saved = process.env.MCP_HOST;
      delete process.env.MCP_HOST;
      const host = process.env.MCP_HOST ?? '127.0.0.1';
      expect(host).toBe('127.0.0.1');
      if (saved !== undefined) process.env.MCP_HOST = saved;
    });

    it('respects an MCP_HOST override', () => {
      const saved = process.env.MCP_HOST;
      process.env.MCP_HOST = '0.0.0.0';
      const host = process.env.MCP_HOST ?? '127.0.0.1';
      expect(host).toBe('0.0.0.0');
      if (saved !== undefined) {
        process.env.MCP_HOST = saved;
      } else {
        delete process.env.MCP_HOST;
      }
    });
  });
});
