"use strict";
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
 *   - Invoke the captured handler with mock req/res objects and assert
 *     the response shapes.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
// ── Mock modules before importing the module under test ──────────────────────
// Mock http module to capture the request handler
let capturedHandler = null;
vitest_1.vi.mock('http', () => ({
    createServer: vitest_1.vi.fn((handler) => {
        capturedHandler = handler;
        return {
            listen: vitest_1.vi.fn(),
            close: vitest_1.vi.fn(),
        };
    }),
}));
// Mock config module with deterministic values
vitest_1.vi.mock('../backend/config', () => ({
    config: {
        STELLAR_NETWORK: 'testnet',
        AGENT_PUBLIC_KEY: 'GTEST1234567890123456789012345678901234567890123456',
        HEALTH_PORT: 3000,
        // server.ts pulls in rpc_client, which builds a Horizon.Server at import
        // time; without these the URI constructor throws and the suite cannot load.
        HORIZON_URL: 'https://horizon-testnet.stellar.org',
        SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
    },
}));
// Mock persistence module — getResults returns controlled data, or throws
// when a test wants to exercise the error path.
let mockResults = [];
let mockResultsError = null;
vitest_1.vi.mock('../backend/persistence', () => ({
    getResults: vitest_1.vi.fn((limit) => {
        if (mockResultsError)
            throw mockResultsError;
        return mockResults.slice(0, limit ?? 100);
    }),
}));
const server_1 = require("../backend/server");
const errors_1 = require("../backend/errors");
const persistence_1 = require("../backend/persistence");
// ── Helpers ──────────────────────────────────────────────────────────────────
function makeReq(method, url) {
    return { method, url };
}
function makeRes() {
    const res = {
        _statusCode: 0,
        _body: '',
        _headers: {},
        writeHead: vitest_1.vi.fn(function (statusCode, headers) {
            this._statusCode = statusCode;
            if (headers)
                Object.assign(this._headers, headers);
        }),
        end: vitest_1.vi.fn(function (body) {
            this._body = body ?? '';
        }),
    };
    return res;
}
// ── Tests ────────────────────────────────────────────────────────────────────
(0, vitest_1.describe)('backend/server.ts — health check HTTP server', () => {
    (0, vitest_1.beforeEach)(() => {
        capturedHandler = null;
        mockResults = [];
        mockResultsError = null;
        vitest_1.vi.clearAllMocks();
    });
    (0, vitest_1.it)('creates an http server via http.createServer', () => {
        (0, server_1.createHealthServer)();
        // If createServer was called, our mock would have captured the handler
        (0, vitest_1.expect)(capturedHandler).toBeTypeOf('function');
    });
    (0, vitest_1.describe)('GET /health', () => {
        (0, vitest_1.it)("returns 200 with { status: 'ok', network, publicKey }", () => {
            (0, server_1.createHealthServer)();
            const req = makeReq('GET', '/health');
            const res = makeRes();
            capturedHandler(req, res);
            (0, vitest_1.expect)(res._statusCode).toBe(200);
            const body = JSON.parse(res._body);
            (0, vitest_1.expect)(body).toEqual({
                status: 'ok',
                network: 'testnet',
                publicKey: 'GTEST1234567890123456789012345678901234567890123456',
            });
            (0, vitest_1.expect)(res._headers['Content-Type']).toBe('application/json');
        });
        (0, vitest_1.it)('health response matches expected shape', () => {
            (0, server_1.createHealthServer)();
            const req = makeReq('GET', '/health');
            const res = makeRes();
            capturedHandler(req, res);
            (0, vitest_1.expect)(res._statusCode).toBe(200);
            const body = JSON.parse(res._body);
            (0, vitest_1.expect)(body).toMatchSnapshot();
        });
        (0, vitest_1.it)('includes the correct network value from config', () => {
            (0, server_1.createHealthServer)();
            const req = makeReq('GET', '/health');
            const res = makeRes();
            capturedHandler(req, res);
            const body = JSON.parse(res._body);
            (0, vitest_1.expect)(body.network).toBe('testnet');
            (0, vitest_1.expect)(body).toHaveProperty('status');
            (0, vitest_1.expect)(body).toHaveProperty('network');
            (0, vitest_1.expect)(body).toHaveProperty('publicKey');
        });
    });
    (0, vitest_1.describe)('GET /status', () => {
        (0, vitest_1.it)('returns 200 with { results: [] } when no persisted results exist', () => {
            (0, server_1.createHealthServer)();
            const req = makeReq('GET', '/status');
            const res = makeRes();
            capturedHandler(req, res);
            (0, vitest_1.expect)(res._statusCode).toBe(200);
            const body = JSON.parse(res._body);
            (0, vitest_1.expect)(body).toHaveProperty('results');
            (0, vitest_1.expect)(Array.isArray(body.results)).toBe(true);
            (0, vitest_1.expect)(body.results).toEqual([]);
            (0, vitest_1.expect)(persistence_1.getResults).toHaveBeenCalledWith(10);
        });
        (0, vitest_1.it)('returns 200 with the last 10 AgentResult records from persistence', () => {
            const fakeResults = Array.from({ length: 15 }, (_, i) => ({
                timestamp: `2026-07-24T10:0${i}:00.000Z`,
                taskType: 'stellar_payment',
                success: true,
                data: { txHash: `hash_${i}` },
            }));
            mockResults = fakeResults;
            (0, server_1.createHealthServer)();
            const req = makeReq('GET', '/status');
            const res = makeRes();
            capturedHandler(req, res);
            (0, vitest_1.expect)(res._statusCode).toBe(200);
            const body = JSON.parse(res._body);
            (0, vitest_1.expect)(body).toHaveProperty('results');
            (0, vitest_1.expect)(Array.isArray(body.results)).toBe(true);
            (0, vitest_1.expect)(body.results).toHaveLength(10);
            // Should be the first 10 from our mock (getResults returns newest-first)
            (0, vitest_1.expect)(body.results[0].data.txHash).toBe('hash_0');
        });
        (0, vitest_1.it)('returns 500 when persistence throws an error', () => {
            vitest_1.vi.mocked(persistence_1.getResults).mockImplementationOnce(() => {
                throw new Error('Database unavailable');
            });
            (0, server_1.createHealthServer)();
            const req = makeReq('GET', '/status');
            const res = makeRes();
            capturedHandler(req, res);
            (0, vitest_1.expect)(res._statusCode).toBe(500);
            const body = JSON.parse(res._body);
            (0, vitest_1.expect)(body.type).toBe('InternalServerError');
            // The raw failure message is deliberately not echoed back: /status has no
            // auth guard, so an internal fault must not describe itself to callers.
            (0, vitest_1.expect)(res._body).not.toContain('Database unavailable');
        });
    });
    (0, vitest_1.describe)('404 handling', () => {
        (0, vitest_1.it)('returns 404 for unknown routes', () => {
            (0, server_1.createHealthServer)();
            const req = makeReq('GET', '/unknown');
            const res = makeRes();
            capturedHandler(req, res);
            (0, vitest_1.expect)(res._statusCode).toBe(404);
        });
        (0, vitest_1.it)('returns 404 for POST /health', () => {
            (0, server_1.createHealthServer)();
            const req = makeReq('POST', '/health');
            const res = makeRes();
            capturedHandler(req, res);
            (0, vitest_1.expect)(res._statusCode).toBe(404);
        });
    });
    (0, vitest_1.describe)('structured error responses', () => {
        async function requestStatusWith(err) {
            mockResultsError = err;
            (0, server_1.createHealthServer)();
            const req = makeReq('GET', '/status');
            const res = makeRes();
            await capturedHandler(req, res);
            return res;
        }
        (0, vitest_1.it)('returns 400 when the handler throws a ValidationError', async () => {
            const res = await requestStatusWith(new errors_1.ValidationError('bad limit'));
            (0, vitest_1.expect)(res._statusCode).toBe(400);
            (0, vitest_1.expect)(JSON.parse(res._body).type).toBe('ValidationError');
        });
        (0, vitest_1.it)('returns 401 when the handler throws an UnauthorizedError', async () => {
            const res = await requestStatusWith(new errors_1.UnauthorizedError('no token'));
            (0, vitest_1.expect)(res._statusCode).toBe(401);
        });
        (0, vitest_1.it)('returns 429 with Retry-After when the handler throws a RateLimitError', async () => {
            const res = await requestStatusWith(new errors_1.RateLimitError('slow down', 45));
            (0, vitest_1.expect)(res._statusCode).toBe(429);
            (0, vitest_1.expect)(res._headers['Retry-After']).toBe('45');
        });
        (0, vitest_1.it)('returns 503 when the handler throws a NetworkTimeoutError', async () => {
            const res = await requestStatusWith(new errors_1.NetworkTimeoutError('horizon timed out'));
            (0, vitest_1.expect)(res._statusCode).toBe(503);
        });
        (0, vitest_1.it)('returns 500 for error types with no client-side meaning', async () => {
            const res = await requestStatusWith(new errors_1.ContractError('trapped'));
            (0, vitest_1.expect)(res._statusCode).toBe(500);
        });
        (0, vitest_1.it)('returns 500 for a plain Error', async () => {
            const res = await requestStatusWith(new Error('boom'));
            (0, vitest_1.expect)(res._statusCode).toBe(500);
        });
    });
    // ── Docker / container health check contract (#463) ────────────────────────
    // The Docker Compose health check polls GET /health and greps for
    // `"status":"ok"` in the response body.  These tests pin that exact
    // contract so a refactor cannot silently break container readiness probes.
    (0, vitest_1.describe)('Docker health check contract', () => {
        (0, vitest_1.it)('GET /health returns 200 so curl exits 0', () => {
            (0, server_1.createHealthServer)();
            const req = makeReq('GET', '/health');
            const res = makeRes();
            capturedHandler(req, res);
            (0, vitest_1.expect)(res._statusCode).toBe(200);
        });
        (0, vitest_1.it)('GET /health body contains "status":"ok" for the grep probe', () => {
            (0, server_1.createHealthServer)();
            const req = makeReq('GET', '/health');
            const res = makeRes();
            capturedHandler(req, res);
            // The Compose health check runs:
            //   curl -sf http://localhost:3000/health | grep -q '"status":"ok"'
            // The body must contain that exact substring.
            (0, vitest_1.expect)(res._body).toContain('"status":"ok"');
        });
        (0, vitest_1.it)('GET /health body contains the STELLAR_NETWORK value', () => {
            (0, server_1.createHealthServer)();
            const req = makeReq('GET', '/health');
            const res = makeRes();
            capturedHandler(req, res);
            const body = JSON.parse(res._body);
            // config.STELLAR_NETWORK is "testnet" in the test mock
            (0, vitest_1.expect)(body.network).toBe('testnet');
        });
        (0, vitest_1.it)('GET /health responds with Content-Type: application/json', () => {
            (0, server_1.createHealthServer)();
            const req = makeReq('GET', '/health');
            const res = makeRes();
            capturedHandler(req, res);
            (0, vitest_1.expect)(res._headers['Content-Type']).toBe('application/json');
        });
    });
});
//# sourceMappingURL=server.test.js.map