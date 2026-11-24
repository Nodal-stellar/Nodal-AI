/**
 * tests/server.test.ts
 *
 * Tests for backend/server.ts — the health-check HTTP server.
 *
 * Strategy:
 *   - Mock `http.createServer` so we can capture the request handler
 *     without opening a real TCP port.
 *   - Mock `config` to provide deterministic values for STELLAR_NETWORK
 *     and AGENT_PUBLIC_KEY.
 *   - Mock `getResults` from persistence to inject controlled data for
 *     the /status endpoint.
 *   - Mock the dependency probes (checkHorizon/checkSoroban/checkDatabase)
 *     so /health can be exercised for both the healthy and degraded paths.
 *   - Invoke the captured handler with mock req/res objects and assert
 *     the response shapes.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock modules before importing the module under test ──────────────────────

// Mock http module to capture the request handler
let capturedHandler: http.RequestListener | null = null;
vi.mock('http', () => ({
  createServer: vi.fn((handler: http.RequestListener) => {
    capturedHandler = handler;
    return {
      listen: vi.fn(),
      close: vi.fn(),
    };
  }),
}));

// Mock config module with deterministic values
vi.mock('../backend/config', () => ({
  config: {
    STELLAR_NETWORK: 'testnet',
    AGENT_PUBLIC_KEY: 'GTEST1234567890123456789012345678901234567890123456',
    HEALTH_PORT: 3000,
    // server.ts pulls in rpc_client, which builds a Horizon.Server at import
    // time; without these the URI constructor throws and the suite cannot load.
    HORIZON_URL: 'https://horizon-testnet.stellar.org',
    SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
    APPROVER_TOKENS_MAP: new Map<string, string>(),
    APPROVAL_MIN_APPROVERS: 2,
  },
  getAdminApiToken: () => process.env.ADMIN_API_TOKEN || process.env.WEBHOOK_SECRET || undefined,
}));

// Mock persistence module — getResults returns controlled data, or throws
// when a test wants to exercise the error path.
let mockResults: any[] = [];
let mockResultsError: unknown = null;
vi.mock('../backend/persistence', () => ({
  getResults: vi.fn((limit?: number) => {
    if (mockResultsError) throw mockResultsError;
    return mockResults.slice(0, limit ?? 100);
  }),
}));

// Mock what handleHealth()'s probes call. Each defaults to healthy; individual
// tests override them to exercise the degraded path. Plain functions, because
// restoreMocks would strip a vi.fn() implementation after the first test.
let horizonOk = true;
let sorobanOk = true;
let databaseOk = true;
vi.mock('../backend/rpc_client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  horizonServer: {
    fetchBaseFee: async () => {
      if (!horizonOk) throw new Error('horizon down');
      return 100;
    },
  },
  sorobanServer: {
    getNetwork: async () => {
      if (!sorobanOk) throw new Error('soroban down');
      return {};
    },
  },
}));
vi.mock('../backend/db/client', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  db: { healthCheck: async () => databaseOk },
}));

// Mock the kill switch with an in-memory flag so the admin routes can be
// exercised without a database or webhook.
let mockPaused = false;
vi.mock('../backend/kill_switch', () => ({
  isPaused: vi.fn(() => mockPaused),
  pauseAgent: vi.fn(() => {
    mockPaused = true;
  }),
  resumeAgent: vi.fn(() => {
    mockPaused = false;
  }),
}));

import type * as http from 'http';
import { Readable } from 'stream';
import { createHash } from 'crypto';
import { config } from '../backend/config';
import { createHealthServer } from '../backend/server';
import { pauseAgent, resumeAgent } from '../backend/kill_switch';
import {
  ContractError,
  NetworkTimeoutError,
  RateLimitError,
  UnauthorizedError,
  ValidationError,
} from '../backend/errors';
import { getResults } from '../backend/persistence';
import { expectLoggedError } from './helpers/expectLoggedError';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeReq(
  method: string,
  url: string,
  headers: Record<string, string> = {}
): http.IncomingMessage {
  const closeHandlers: (() => void)[] = [];
  return {
    method,
    url,
    headers,
    on: vi.fn((event: string, fn: () => void) => {
      if (event === 'close') closeHandlers.push(fn);
    }),
    // Not part of http.IncomingMessage — a test hook to simulate the client
    // disconnecting (fires every handler registered via `on('close', ...)`).
    _simulateClose: () => closeHandlers.forEach((fn) => fn()),
  } as unknown as http.IncomingMessage;
}

function makeBodyReq(
  method: string,
  url: string,
  body: unknown,
  headers: Record<string, string> = {}
): http.IncomingMessage {
  return Object.assign(Readable.from([JSON.stringify(body)]), {
    method,
    url,
    headers,
  }) as unknown as http.IncomingMessage;
}

/** Lets the async route handlers finish reading the body and responding. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function makeRes(): http.ServerResponse & {
  _statusCode: number;
  _body: string;
  _headers: Record<string, any>;
  _writes: string[];
} {
  const res: any = {
    _statusCode: 0,
    _body: '',
    _headers: {},
    _writes: [],
    writeHead: vi.fn(function (this: any, statusCode: number, headers?: Record<string, any>) {
      this._statusCode = statusCode;
      if (headers) Object.assign(this._headers, headers);
    }),
    setHeader: vi.fn(function (this: any, name: string, value: unknown) {
      this._headers[name] = value;
    }),
    getHeader: vi.fn(function (this: any, name: string) {
      return this._headers[name];
    }),
    write: vi.fn(function (this: any, chunk: string) {
      this._writes.push(chunk);
      this._body += chunk;
    }),
    end: vi.fn(function (this: any, body?: string) {
      this._body += body ?? '';
    }),
  };
  return res;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('backend/server.ts — health check HTTP server', () => {
  beforeEach(() => {
    capturedHandler = null;
    mockResults = [];
    mockResultsError = null;
    horizonOk = true;
    sorobanOk = true;
    databaseOk = true;
    delete process.env.WEBHOOK_SECRET;
    delete process.env.ADMIN_API_TOKEN;
    delete (config as unknown as Record<string, unknown>).CORS_ALLOWED_ORIGINS;
    vi.clearAllMocks();
  });

  it('creates an http server via http.createServer', () => {
    createHealthServer();
    // If createServer was called, our mock would have captured the handler
    expect(capturedHandler).toBeTypeOf('function');
  });

  describe('GET /health', () => {
    it("returns 200 with { status: 'ok', components } when all probes pass", async () => {
      createHealthServer();
      const req = makeReq('GET', '/health');
      const res = makeRes();

      capturedHandler!(req, res);
      await vi.waitFor(() => expect(res._statusCode).not.toBe(0));

      expect(res._statusCode).toBe(200);
      const body = JSON.parse(res._body);
      expect(body.status).toBe('ok');
      expect(body.components).toEqual({
        horizon: 'up',
        soroban: 'up',
        database: 'up',
      });
      expect(res._headers['Content-Type']).toBe('application/json');
    });

    it('health response matches expected shape', async () => {
      createHealthServer();
      const req = makeReq('GET', '/health');
      const res = makeRes();

      capturedHandler!(req, res);
      await vi.waitFor(() => expect(res._statusCode).not.toBe(0));

      expect(res._statusCode).toBe(200);
      const body = JSON.parse(res._body);
      expect(body).toMatchSnapshot();
    });

    it('returns 503 with status "degraded" when Horizon is down', async () => {
      horizonOk = false;
      createHealthServer();
      const req = makeReq('GET', '/health');
      const res = makeRes();

      capturedHandler!(req, res);
      await vi.waitFor(() => expect(res._statusCode).not.toBe(0));

      expect(res._statusCode).toBe(503);
      const body = JSON.parse(res._body);
      expect(body.status).toBe('degraded');
      expect(body.components.horizon).toBe('down');
    });

    it('returns 503 with status "degraded" when Soroban is down', async () => {
      sorobanOk = false;
      createHealthServer();
      const req = makeReq('GET', '/health');
      const res = makeRes();

      capturedHandler!(req, res);
      await vi.waitFor(() => expect(res._statusCode).not.toBe(0));

      expect(res._statusCode).toBe(503);
      const body = JSON.parse(res._body);
      expect(body.status).toBe('degraded');
      expect(body.components.soroban).toBe('down');
    });

    it('returns 503 with status "degraded" when the database is down', async () => {
      databaseOk = false;
      createHealthServer();
      const req = makeReq('GET', '/health');
      const res = makeRes();

      capturedHandler!(req, res);
      await vi.waitFor(() => expect(res._statusCode).not.toBe(0));

      expect(res._statusCode).toBe(503);
      const body = JSON.parse(res._body);
      expect(body.status).toBe('degraded');
      expect(body.components.database).toBe('down');
    });
  });

  describe('GET /status', () => {
    it('returns 200 with { results: [] } when no persisted results exist', () => {
      createHealthServer();
      const req = makeReq('GET', '/status');
      const res = makeRes();

      capturedHandler!(req, res);

      expect(res._statusCode).toBe(200);
      const body = JSON.parse(res._body);
      expect(body).toHaveProperty('results');
      expect(Array.isArray(body.results)).toBe(true);
      expect(body.results).toEqual([]);
      expect(getResults).toHaveBeenCalledWith(10, 0);
    });

    it('returns 200 with the last 10 AgentResult records from persistence', () => {
      const fakeResults = Array.from({ length: 15 }, (_, i) => ({
        timestamp: `2026-07-24T10:0${i}:00.000Z`,
        taskType: 'stellar_payment',
        success: true,
        data: { txHash: `hash_${i}` },
      }));
      mockResults = fakeResults;

      createHealthServer();
      const req = makeReq('GET', '/status');
      const res = makeRes();

      capturedHandler!(req, res);

      expect(res._statusCode).toBe(200);
      const body = JSON.parse(res._body);
      expect(body).toHaveProperty('results');
      expect(Array.isArray(body.results)).toBe(true);
      expect(body.results).toHaveLength(10);
      // Should be the first 10 from our mock (getResults returns newest-first)
      expect(body.results[0].data.txHash).toBe('hash_0');
    });

    it('honours the limit and offset query parameters', () => {
      const fakeResults = Array.from({ length: 15 }, (_, i) => ({
        timestamp: `2026-07-24T10:0${i}:00.000Z`,
        taskType: 'stellar_payment',
        success: true,
        data: { txHash: `hash_${i}` },
      }));
      mockResults = fakeResults;

      createHealthServer();
      const req = makeReq('GET', '/status?limit=5&offset=2');
      const res = makeRes();

      capturedHandler!(req, res);

      expect(res._statusCode).toBe(200);
      const body = JSON.parse(res._body);
      expect(body.results).toHaveLength(5);
      expect(getResults).toHaveBeenCalledWith(5, 2);
    });

    it('returns 401 when WEBHOOK_SECRET is set and no Bearer token is supplied', () => {
      process.env.WEBHOOK_SECRET = 'super-secret';
      createHealthServer();
      const req = makeReq('GET', '/status');
      const res = makeRes();

      capturedHandler!(req, res);

      expect(res._statusCode).toBe(401);
      expect(getResults).not.toHaveBeenCalled();
    });

    it('returns 200 when WEBHOOK_SECRET is set and a matching Bearer token is supplied', () => {
      process.env.WEBHOOK_SECRET = 'super-secret';
      createHealthServer();
      const req = makeReq('GET', '/status', { authorization: 'Bearer super-secret' });
      const res = makeRes();

      capturedHandler!(req, res);

      expect(res._statusCode).toBe(200);
      const body = JSON.parse(res._body);
      expect(body).toHaveProperty('results');
    });

    it('returns 500 when persistence throws an error', () => {
      expectLoggedError(/Failed to read persisted results/);
      vi.mocked(getResults).mockImplementationOnce(() => {
        throw new Error('db down');
      });

      createHealthServer();
      const req = makeReq('GET', '/status');
      const res = makeRes();

      capturedHandler!(req, res);

      expect(res._statusCode).toBe(500);
      const body = JSON.parse(res._body);
      // The raw failure message is deliberately not echoed back to the caller.
      expect(body).toHaveProperty('error');
      expect(body.error).not.toContain('db down');
    });
  });

  describe('POST /admin/pause and /admin/resume (#743)', () => {
    beforeEach(() => {
      mockPaused = false;
    });

    it('returns 401 and does not pause when WEBHOOK_SECRET is unset', () => {
      createHealthServer();
      const res = makeRes();

      capturedHandler!(makeReq('POST', '/admin/pause'), res);

      expect(res._statusCode).toBe(401);
      expect(pauseAgent).not.toHaveBeenCalled();
      expect(mockPaused).toBe(false);
    });

    it('returns 401 for a missing or wrong bearer token', () => {
      process.env.WEBHOOK_SECRET = 'admin-secret';
      createHealthServer();

      const noAuth = makeRes();
      capturedHandler!(makeReq('POST', '/admin/pause'), noAuth);
      const wrongAuth = makeRes();
      capturedHandler!(
        makeReq('POST', '/admin/pause', { authorization: 'Bearer nope' }),
        wrongAuth
      );

      expect(noAuth._statusCode).toBe(401);
      expect(wrongAuth._statusCode).toBe(401);
      expect(pauseAgent).not.toHaveBeenCalled();
    });

    it('pauses the agent with a valid bearer token', () => {
      process.env.WEBHOOK_SECRET = 'admin-secret';
      createHealthServer();
      const res = makeRes();

      capturedHandler!(
        makeReq('POST', '/admin/pause', { authorization: 'Bearer admin-secret' }),
        res
      );

      expect(res._statusCode).toBe(200);
      expect(JSON.parse(res._body)).toEqual({ paused: true });
      expect(pauseAgent).toHaveBeenCalledTimes(1);
    });

    it('resumes the agent with a valid bearer token', () => {
      process.env.WEBHOOK_SECRET = 'admin-secret';
      mockPaused = true;
      createHealthServer();
      const res = makeRes();

      capturedHandler!(
        makeReq('POST', '/admin/resume', { authorization: 'Bearer admin-secret' }),
        res
      );

      expect(res._statusCode).toBe(200);
      expect(JSON.parse(res._body)).toEqual({ paused: false });
      expect(resumeAgent).toHaveBeenCalledTimes(1);
    });

    it('does not expose the admin routes over GET', () => {
      process.env.WEBHOOK_SECRET = 'admin-secret';
      createHealthServer();
      const res = makeRes();

      capturedHandler!(
        makeReq('GET', '/admin/pause', { authorization: 'Bearer admin-secret' }),
        res
      );

      expect(res._statusCode).toBe(404);
      expect(pauseAgent).not.toHaveBeenCalled();
    });
  });

  describe('approvals (#736)', () => {
    const approval = { id: 'appr-1', status: 'pending_approval' };
    let agent: any;

    beforeEach(() => {
      agent = {
        listApprovals: vi.fn(() => [approval]),
        approve: vi.fn(async () => ({
          approval: { ...approval, status: 'approved' },
          result: { success: true, taskType: 'stellar_payment' },
        })),
        deny: vi.fn(() => ({ ...approval, status: 'denied' })),
      };
    });

    it('lists pending approvals', () => {
      createHealthServer(agent);
      const res = makeRes();

      capturedHandler!(makeReq('GET', '/approvals'), res);

      expect(res._statusCode).toBe(200);
      expect(JSON.parse(res._body)).toEqual({ approvals: [approval] });
    });

    it('returns 401 for a decision when WEBHOOK_SECRET is unset', async () => {
      createHealthServer(agent);
      const res = makeRes();

      capturedHandler!(makeBodyReq('POST', '/approvals/appr-1', { decision: 'approve' }), res);
      await flush();

      expect(res._statusCode).toBe(401);
      expect(agent.approve).not.toHaveBeenCalled();
    });

    it('returns 401 for a decision with a wrong bearer token', async () => {
      process.env.WEBHOOK_SECRET = 'admin-secret';
      createHealthServer(agent);
      const res = makeRes();

      capturedHandler!(
        makeBodyReq(
          'POST',
          '/approvals/appr-1',
          { decision: 'approve' },
          {
            authorization: 'Bearer nope',
          }
        ),
        res
      );
      await flush();

      expect(res._statusCode).toBe(401);
      expect(agent.approve).not.toHaveBeenCalled();
    });

    it('approves a pending task with a valid bearer token', async () => {
      process.env.WEBHOOK_SECRET = 'admin-secret';
      createHealthServer(agent);
      const res = makeRes();

      capturedHandler!(
        makeBodyReq(
          'POST',
          '/approvals/appr-1',
          { decision: 'approve' },
          {
            authorization: 'Bearer admin-secret',
          }
        ),
        res
      );
      await flush();

      expect(res._statusCode).toBe(200);
      expect(agent.approve).toHaveBeenCalledWith('appr-1', null);
      expect(JSON.parse(res._body).approval.status).toBe('approved');
    });

    it('denies a pending task with a valid bearer token', async () => {
      process.env.WEBHOOK_SECRET = 'admin-secret';
      createHealthServer(agent);
      const res = makeRes();

      capturedHandler!(
        makeBodyReq(
          'POST',
          '/approvals/appr-1',
          { decision: 'deny' },
          {
            authorization: 'Bearer admin-secret',
          }
        ),
        res
      );
      await flush();

      expect(res._statusCode).toBe(200);
      expect(agent.deny).toHaveBeenCalledWith('appr-1', null);
      expect(JSON.parse(res._body).approval.status).toBe('denied');
    });

    it('returns 400 for an unknown decision and 404 for an unknown id', async () => {
      process.env.WEBHOOK_SECRET = 'admin-secret';
      agent.deny = vi.fn(() => null);
      createHealthServer(agent);
      const auth = { authorization: 'Bearer admin-secret' };

      const bad = makeRes();
      capturedHandler!(makeBodyReq('POST', '/approvals/appr-1', { decision: 'maybe' }, auth), bad);
      const missing = makeRes();
      capturedHandler!(makeBodyReq('POST', '/approvals/nope', { decision: 'deny' }, auth), missing);
      await flush();

      expect(bad._statusCode).toBe(400);
      expect(missing._statusCode).toBe(404);
    });
  });

  describe('approvals — named approver tokens (#954)', () => {
    const approval = { id: 'appr-1', status: 'pending_approval' };
    let agent: any;
    const ALICE_TOKEN = 'alice-secret-token';
    const aliceHash = createHash('sha256').update(ALICE_TOKEN).digest('hex');

    beforeEach(() => {
      agent = {
        approve: vi.fn(async () => ({
          approval: { ...approval, status: 'approved', decidedBy: 'alice' },
        })),
        deny: vi.fn(() => ({ ...approval, status: 'denied', decidedBy: 'alice' })),
      };
      process.env.WEBHOOK_SECRET = 'admin-secret';
      (config as any).APPROVER_TOKENS_MAP = new Map([['alice', aliceHash]]);
    });

    afterEach(() => {
      (config as any).APPROVER_TOKENS_MAP = new Map();
      delete process.env.WEBHOOK_SECRET;
    });

    it('identifies a named approver by their own token and passes it through', async () => {
      createHealthServer(agent);
      const res = makeRes();

      capturedHandler!(
        makeBodyReq(
          'POST',
          '/approvals/appr-1',
          { decision: 'approve' },
          { authorization: `Bearer ${ALICE_TOKEN}` }
        ),
        res
      );
      await flush();

      expect(res._statusCode).toBe(200);
      expect(agent.approve).toHaveBeenCalledWith('appr-1', 'alice');
      expect(JSON.parse(res._body).approval.decidedBy).toBe('alice');
    });

    it('a named approver token works without the shared admin token', async () => {
      // No "Bearer admin-secret" anywhere — alice's own credential is enough.
      createHealthServer(agent);
      const res = makeRes();

      capturedHandler!(
        makeBodyReq(
          'POST',
          '/approvals/appr-1',
          { decision: 'deny' },
          { authorization: `Bearer ${ALICE_TOKEN}` }
        ),
        res
      );
      await flush();

      expect(res._statusCode).toBe(200);
      expect(agent.deny).toHaveBeenCalledWith('appr-1', 'alice');
    });

    it('falls back to null (recorded as "admin") for the shared admin token', async () => {
      createHealthServer(agent);
      const res = makeRes();

      capturedHandler!(
        makeBodyReq(
          'POST',
          '/approvals/appr-1',
          { decision: 'approve' },
          { authorization: 'Bearer admin-secret' }
        ),
        res
      );
      await flush();

      expect(res._statusCode).toBe(200);
      expect(agent.approve).toHaveBeenCalledWith('appr-1', null);
    });

    it('rejects a token that matches no approver and is not the admin token', async () => {
      createHealthServer(agent);
      const res = makeRes();

      capturedHandler!(
        makeBodyReq(
          'POST',
          '/approvals/appr-1',
          { decision: 'approve' },
          { authorization: 'Bearer someone-elses-token' }
        ),
        res
      );
      await flush();

      expect(res._statusCode).toBe(401);
      expect(agent.approve).not.toHaveBeenCalled();
    });
  });

  describe('ADMIN_API_TOKEN (#737)', () => {
    it('returns 401 when ADMIN_API_TOKEN is set and no token is supplied', () => {
      process.env.ADMIN_API_TOKEN = 'admin-token';
      createHealthServer();
      const res = makeRes();

      capturedHandler!(makeReq('GET', '/status'), res);

      expect(res._statusCode).toBe(401);
      expect(getResults).not.toHaveBeenCalled();
    });

    it('returns 401 for an invalid token, including one of a different length', () => {
      process.env.ADMIN_API_TOKEN = 'admin-token';
      createHealthServer();

      const wrong = makeRes();
      capturedHandler!(makeReq('GET', '/status', { authorization: 'Bearer admin-tokeX' }), wrong);
      const shorter = makeRes();
      capturedHandler!(makeReq('GET', '/status', { authorization: 'Bearer admin' }), shorter);
      const noToken = makeRes();
      capturedHandler!(makeReq('GET', '/status', { authorization: 'Bearer' }), noToken);

      expect(wrong._statusCode).toBe(401);
      expect(shorter._statusCode).toBe(401);
      expect(noToken._statusCode).toBe(401);
    });

    it('returns 200 for a valid ADMIN_API_TOKEN', () => {
      process.env.ADMIN_API_TOKEN = 'admin-token';
      createHealthServer();
      const res = makeRes();

      capturedHandler!(makeReq('GET', '/status', { authorization: 'Bearer admin-token' }), res);

      expect(res._statusCode).toBe(200);
    });

    it('rejects WEBHOOK_SECRET as the token once ADMIN_API_TOKEN is set', () => {
      process.env.ADMIN_API_TOKEN = 'admin-token';
      process.env.WEBHOOK_SECRET = 'webhook-secret';
      createHealthServer();
      const res = makeRes();

      capturedHandler!(makeReq('GET', '/status', { authorization: 'Bearer webhook-secret' }), res);

      expect(res._statusCode).toBe(401);
    });
  });

  describe('CORS (#966)', () => {
    it('answers an OPTIONS preflight from an allowed origin with the matching headers', () => {
      (config as unknown as Record<string, unknown>).CORS_ALLOWED_ORIGINS = 'http://localhost:5173';
      createHealthServer();
      const res = makeRes();

      capturedHandler!(makeReq('OPTIONS', '/status', { origin: 'http://localhost:5173' }), res);

      expect(res._statusCode).toBe(204);
      expect(res._headers['Access-Control-Allow-Origin']).toBe('http://localhost:5173');
      expect(res._headers['Access-Control-Allow-Methods']).toContain('GET');
    });

    it('sets no CORS headers for an origin not on the allowlist', () => {
      (config as unknown as Record<string, unknown>).CORS_ALLOWED_ORIGINS = 'http://localhost:5173';
      createHealthServer();
      const res = makeRes();

      capturedHandler!(makeReq('OPTIONS', '/status', { origin: 'https://evil.example.com' }), res);

      expect(res._statusCode).toBe(204);
      expect(res._headers['Access-Control-Allow-Origin']).toBeUndefined();
    });

    it('sets no CORS headers for any origin when CORS_ALLOWED_ORIGINS is unset', () => {
      createHealthServer();
      const res = makeRes();

      capturedHandler!(makeReq('GET', '/health', { origin: 'http://localhost:5173' }), res);

      expect(res._headers['Access-Control-Allow-Origin']).toBeUndefined();
    });

    it('never answers with "*" for an allowed origin (credentials are in play)', () => {
      (config as unknown as Record<string, unknown>).CORS_ALLOWED_ORIGINS = 'http://localhost:5173';
      createHealthServer();
      const res = makeRes();

      capturedHandler!(makeReq('GET', '/health', { origin: 'http://localhost:5173' }), res);

      expect(res._headers['Access-Control-Allow-Origin']).toBe('http://localhost:5173');
    });
  });

  describe('POST /stream/ticket and GET /stream auth (#965)', () => {
    it('refuses a ticket request without a valid Bearer token', () => {
      process.env.ADMIN_API_TOKEN = 'admin-token';
      createHealthServer();
      const res = makeRes();

      capturedHandler!(makeReq('POST', '/stream/ticket'), res);

      expect(res._statusCode).toBe(401);
    });

    it('issues a ticket that GET /stream accepts exactly once', () => {
      process.env.ADMIN_API_TOKEN = 'admin-token';
      createHealthServer();

      const ticketRes = makeRes();
      capturedHandler!(
        makeReq('POST', '/stream/ticket', { authorization: 'Bearer admin-token' }),
        ticketRes
      );
      expect(ticketRes._statusCode).toBe(200);
      const { ticket, expiresInMs } = JSON.parse(ticketRes._body);
      expect(typeof ticket).toBe('string');
      expect(expiresInMs).toBe(60_000);
      // The ticket never carries the real admin token anywhere in the URL.
      expect(ticket).not.toContain('admin-token');

      const firstStream = makeRes();
      const firstStreamReq = makeReq('GET', `/stream?ticket=${ticket}`);
      capturedHandler!(firstStreamReq, firstStream);
      expect(firstStream._statusCode).toBe(200);

      // Reusing the same ticket a second time is refused (single-use).
      const secondStream = makeRes();
      capturedHandler!(makeReq('GET', `/stream?ticket=${ticket}`), secondStream);
      expect(secondStream._statusCode).toBe(401);

      (firstStreamReq as unknown as { _simulateClose: () => void })._simulateClose();
    });

    it('refuses GET /stream with an unknown or already-consumed ticket', () => {
      process.env.ADMIN_API_TOKEN = 'admin-token';
      createHealthServer();
      const res = makeRes();

      capturedHandler!(makeReq('GET', '/stream?ticket=not-a-real-ticket'), res);

      expect(res._statusCode).toBe(401);
    });

    it('still accepts a plain Bearer header on GET /stream (non-browser clients)', () => {
      process.env.ADMIN_API_TOKEN = 'admin-token';
      createHealthServer();
      const res = makeRes();
      const req = makeReq('GET', '/stream', { authorization: 'Bearer admin-token' });

      capturedHandler!(req, res);

      expect(res._statusCode).toBe(200);
      (req as unknown as { _simulateClose: () => void })._simulateClose();
    });
  });

  describe('GET /stream — shared broadcast hub (#967)', () => {
    function makeAgentStub(approvals: { id: string }[]) {
      const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
      return {
        listApprovals: vi.fn(() => approvals),
        on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
          (listeners[event] ??= []).push(fn);
        }),
        off: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
          listeners[event] = (listeners[event] ?? []).filter((l) => l !== fn);
        }),
        emit(event: string, ...args: unknown[]) {
          for (const fn of listeners[event] ?? []) fn(...args);
        },
      };
    }

    it('serves two concurrent clients from a single shared listApprovals() poll', async () => {
      vi.useFakeTimers();
      try {
        const agent = makeAgentStub([{ id: 'a1' }]);
        createHealthServer(agent as unknown as import('../backend/agent').PayFiAgent);

        const resA = makeRes();
        const resB = makeRes();
        const reqA = makeReq('GET', '/stream', { authorization: 'Bearer' });
        const reqB = makeReq('GET', '/stream', { authorization: 'Bearer' });
        capturedHandler!(reqA, resA);
        capturedHandler!(reqB, resB);

        // The initial snapshot sent to each client on connect doesn't call
        // listApprovals() again — it reuses the hub's cached last-known list.
        const callsAfterConnect = agent.listApprovals.mock.calls.length;

        await vi.advanceTimersByTimeAsync(2_000);

        // Exactly one more call for the shared tick, regardless of 2 clients.
        expect(agent.listApprovals.mock.calls.length).toBe(callsAfterConnect + 1);

        // Both clients received the heartbeat from that one shared tick.
        expect(resA._body).toContain('event: heartbeat');
        expect(resB._body).toContain('event: heartbeat');

        (reqA as unknown as { _simulateClose: () => void })._simulateClose();
        (reqB as unknown as { _simulateClose: () => void })._simulateClose();
      } finally {
        vi.useRealTimers();
      }
    });

    it('emits an approvals event when one is approved and another arrives in the same tick', async () => {
      vi.useFakeTimers();
      try {
        const approvals = [{ id: 'a1' }];
        const agent = makeAgentStub(approvals);
        createHealthServer(agent as unknown as import('../backend/agent').PayFiAgent);

        const res = makeRes();
        const req = makeReq('GET', '/stream', { authorization: 'Bearer' });
        capturedHandler!(req, res);
        res._body = ''; // discard the initial snapshot

        // Same count (1), but a1 was approved and a2 is new — must still fire.
        agent.listApprovals.mockReturnValue([{ id: 'a2' }]);
        await vi.advanceTimersByTimeAsync(2_000);

        expect(res._body).toContain('event: approvals');
        expect(res._body).toContain('a2');

        (req as unknown as { _simulateClose: () => void })._simulateClose();
      } finally {
        vi.useRealTimers();
      }
    });

    it('forwards a task:complete event from the agent as a task_result SSE event', () => {
      const agent = makeAgentStub([]);
      createHealthServer(agent as unknown as import('../backend/agent').PayFiAgent);

      const res = makeRes();
      const req = makeReq('GET', '/stream', { authorization: 'Bearer' });
      capturedHandler!(req, res);
      res._body = '';

      agent.emit('task:complete', { success: true, taskType: 'balance_check' });

      expect(res._body).toContain('event: task_result');
      expect(res._body).toContain('balance_check');

      (req as unknown as { _simulateClose: () => void })._simulateClose();
    });

    it('includes id: and retry: fields on every SSE frame', () => {
      const agent = makeAgentStub([]);
      createHealthServer(agent as unknown as import('../backend/agent').PayFiAgent);

      const res = makeRes();
      const req = makeReq('GET', '/stream', { authorization: 'Bearer' });
      capturedHandler!(req, res);

      expect(res._body).toMatch(/^id: \d+\n/m);
      expect(res._body).toContain('retry: 3000');

      (req as unknown as { _simulateClose: () => void })._simulateClose();
    });
  });
});
