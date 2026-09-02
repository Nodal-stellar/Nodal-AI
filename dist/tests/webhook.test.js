"use strict";
/**
 * tests/webhook.test.ts
 * Tests for dispatchWebhook: delivery, HMAC signature, retry, and no-op when unconfigured.
 *
 * Issue #448: HMAC signing implemented in backend/webhook.ts (X-Nodal-Signature header).
 * Tests verify:
 *   - Dispatched request includes X-Nodal-Signature with correct HMAC value
 *   - Signature can be independently verified with the shared secret
 *   - A tampered payload produces a detectable HMAC mismatch
 *   - Signature header is absent when WEBHOOK_SECRET is not configured
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const crypto_1 = require("crypto");
const webhook_1 = require("../backend/webhook");
// ─── Mocks ────────────────────────────────────────────────────────────────────
vitest_1.vi.mock('axios', () => ({
    default: { post: vitest_1.vi.fn() },
}));
vitest_1.vi.mock('../backend/rpc_client', () => ({
    withRetry: vitest_1.vi.fn(async (fn) => fn()),
    DEFAULT_IS_RETRYABLE: vitest_1.vi.fn(() => true),
}));
// ─── Config mock — overridden per test ───────────────────────────────────────
vitest_1.vi.mock('../backend/config', () => ({
    config: {
        get WEBHOOK_URL() {
            return globalThis.__webhookUrl;
        },
        get WEBHOOK_SECRET() {
            return globalThis.__webhookSecret;
        },
    },
}));
// ─── Fixtures ─────────────────────────────────────────────────────────────────
const successResult = {
    success: true,
    taskType: 'stellar_payment',
    data: { txHash: 'abc123', ledger: 10 },
};
const failureResult = {
    success: false,
    taskType: 'x402_respond',
    error: 'insufficient funds',
};
// ─── Tests ────────────────────────────────────────────────────────────────────
(0, vitest_1.describe)('signPayload', () => {
    (0, vitest_1.it)('produces a valid HMAC-SHA256 hex string', () => {
        const payload = '{"foo":"bar"}';
        const secret = 'mysecret';
        const expected = (0, crypto_1.createHmac)('sha256', secret).update(payload).digest('hex');
        (0, vitest_1.expect)((0, webhook_1.signPayload)(payload, secret)).toBe(expected);
    });
});
(0, vitest_1.describe)('verifyWebhookSignature', () => {
    (0, vitest_1.it)('returns true for a valid signature', () => {
        const payload = '{"foo":"bar"}';
        const secret = 'mysecret';
        const sig = (0, webhook_1.signPayload)(payload, secret);
        (0, vitest_1.expect)((0, webhook_1.verifyWebhookSignature)(payload, sig, secret)).toBe(true);
    });
    (0, vitest_1.it)('returns false for an invalid signature', () => {
        const payload = '{"foo":"bar"}';
        const secret = 'mysecret';
        const sig = 'incorrectsignature';
        (0, vitest_1.expect)((0, webhook_1.verifyWebhookSignature)(payload, sig, secret)).toBe(false);
    });
    (0, vitest_1.it)('returns false for a signature with incorrect length', () => {
        const payload = '{"foo":"bar"}';
        const secret = 'mysecret';
        const sig = 'abc';
        (0, vitest_1.expect)((0, webhook_1.verifyWebhookSignature)(payload, sig, secret)).toBe(false);
    });
    (0, vitest_1.it)('returns false for a valid signature signed with a different secret', () => {
        const payload = '{"foo":"bar"}';
        const sig = (0, webhook_1.signPayload)(payload, 'wrongsecret');
        (0, vitest_1.expect)((0, webhook_1.verifyWebhookSignature)(payload, sig, 'mysecret')).toBe(false);
    });
    (0, vitest_1.it)('returns false for a tampered payload', () => {
        const payload = '{"foo":"bar"}';
        const secret = 'mysecret';
        const sig = (0, webhook_1.signPayload)(payload, secret);
        const tamperedPayload = '{"foo":"baz"}';
        (0, vitest_1.expect)((0, webhook_1.verifyWebhookSignature)(tamperedPayload, sig, secret)).toBe(false);
    });
    (0, vitest_1.it)('returns false for a wrong secret', () => {
        const payload = '{"foo":"bar"}';
        const correctSecret = 'mysecret';
        const wrongSecret = 'incorrectsecret';
        const sig = (0, webhook_1.signPayload)(payload, correctSecret);
        (0, vitest_1.expect)((0, webhook_1.verifyWebhookSignature)(payload, sig, wrongSecret)).toBe(false);
    });
    (0, vitest_1.it)('returns false for signatures of different lengths without throwing', () => {
        const payload = '{"foo":"bar"}';
        const secret = 'mysecret';
        const shortSig = 'short';
        const longSig = (0, webhook_1.signPayload)(payload, secret) + 'extra';
        (0, vitest_1.expect)(() => (0, webhook_1.verifyWebhookSignature)(payload, shortSig, secret)).not.toThrow();
        (0, vitest_1.expect)((0, webhook_1.verifyWebhookSignature)(payload, shortSig, secret)).toBe(false);
        (0, vitest_1.expect)(() => (0, webhook_1.verifyWebhookSignature)(payload, longSig, secret)).not.toThrow();
        (0, vitest_1.expect)((0, webhook_1.verifyWebhookSignature)(payload, longSig, secret)).toBe(false);
    });
});
(0, vitest_1.describe)('dispatchWebhook', () => {
    let axiosPost;
    (0, vitest_1.beforeEach)(async () => {
        vitest_1.vi.clearAllMocks();
        globalThis.__webhookUrl = undefined;
        globalThis.__webhookSecret = undefined;
        const axios = (await Promise.resolve().then(() => __importStar(require('axios')))).default;
        axiosPost = axios.post;
    });
    (0, vitest_1.it)('does nothing when WEBHOOK_URL is not set', async () => {
        globalThis.__webhookUrl = undefined;
        await (0, webhook_1.dispatchWebhook)(successResult);
        (0, vitest_1.expect)(axiosPost).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)('POSTs the AgentResult as JSON when WEBHOOK_URL is set', async () => {
        globalThis.__webhookUrl = 'https://example.com/webhook';
        axiosPost.mockResolvedValueOnce({ status: 200 });
        await (0, webhook_1.dispatchWebhook)(successResult);
        (0, vitest_1.expect)(axiosPost).toHaveBeenCalledOnce();
        const calls = axiosPost.mock.calls;
        const call = calls[0];
        (0, vitest_1.expect)(call).toBeDefined();
        if (!call)
            return;
        const [url, body] = call;
        (0, vitest_1.expect)(url).toBe('https://example.com/webhook');
        (0, vitest_1.expect)(JSON.parse(body)).toMatchObject({
            success: true,
            taskType: 'stellar_payment',
        });
    });
    (0, vitest_1.it)('includes X-Nodal-Signature header when WEBHOOK_SECRET is set', async () => {
        globalThis.__webhookUrl = 'https://example.com/webhook';
        globalThis.__webhookSecret = 'supersecret';
        axiosPost.mockResolvedValueOnce({ status: 200 });
        await (0, webhook_1.dispatchWebhook)(successResult);
        const call = axiosPost.mock.calls[0];
        (0, vitest_1.expect)(call).toBeDefined();
        if (!call)
            return;
        const [, body, opts] = call;
        const expectedSig = (0, webhook_1.signPayload)(body, 'supersecret');
        (0, vitest_1.expect)(opts.headers['X-Nodal-Signature']).toBe(expectedSig);
    });
    (0, vitest_1.it)('POSTs on task failure result as well', async () => {
        globalThis.__webhookUrl = 'https://example.com/webhook';
        axiosPost.mockResolvedValueOnce({ status: 200 });
        await (0, webhook_1.dispatchWebhook)(failureResult);
        const call = axiosPost.mock.calls[0];
        (0, vitest_1.expect)(call).toBeDefined();
        if (!call)
            return;
        const [, body] = call;
        (0, vitest_1.expect)(JSON.parse(body)).toMatchObject({ success: false, taskType: 'x402_respond' });
    });
    (0, vitest_1.it)('does not throw when axios.post rejects (swallows delivery errors)', async () => {
        globalThis.__webhookUrl = 'https://example.com/webhook';
        axiosPost.mockRejectedValue(new Error('network error'));
        vitest_1.vi.useFakeTimers();
        try {
            const promise = (0, webhook_1.dispatchWebhook)(successResult);
            await vitest_1.vi.runAllTimersAsync();
            await (0, vitest_1.expect)(promise).resolves.toBeUndefined();
        }
        finally {
            vitest_1.vi.useRealTimers();
        }
    });
    (0, vitest_1.it)('retries 503 responses with exponential backoff and delivers on 200 (503 -> 503 -> 200)', async () => {
        globalThis.__webhookUrl = 'https://example.com/webhook';
        axiosPost
            .mockRejectedValueOnce({ response: { status: 503 } })
            .mockRejectedValueOnce({ response: { status: 503 } })
            .mockResolvedValueOnce({ status: 200 });
        vitest_1.vi.useFakeTimers();
        try {
            const promise = (0, webhook_1.dispatchWebhook)(successResult);
            await vitest_1.vi.runAllTimersAsync();
            await promise;
            (0, vitest_1.expect)(axiosPost).toHaveBeenCalledTimes(3);
        }
        finally {
            vitest_1.vi.useRealTimers();
        }
    });
    (0, vitest_1.it)('retries when subscriber resolves with non-2xx status (503 -> 503 -> 200)', async () => {
        globalThis.__webhookUrl = 'https://example.com/webhook';
        axiosPost
            .mockResolvedValueOnce({ status: 503 })
            .mockResolvedValueOnce({ status: 503 })
            .mockResolvedValueOnce({ status: 200 });
        vitest_1.vi.useFakeTimers();
        try {
            const promise = (0, webhook_1.dispatchWebhook)(successResult);
            await vitest_1.vi.runAllTimersAsync();
            await promise;
            (0, vitest_1.expect)(axiosPost).toHaveBeenCalledTimes(3);
        }
        finally {
            vitest_1.vi.useRealTimers();
        }
    });
    (0, vitest_1.it)('does not retry on HTTP 4xx (e.g. 400, 404) responses', async () => {
        globalThis.__webhookUrl = 'https://example.com/webhook';
        axiosPost.mockRejectedValueOnce({ response: { status: 404 } });
        vitest_1.vi.useFakeTimers();
        try {
            const promise = (0, webhook_1.dispatchWebhook)(successResult);
            await vitest_1.vi.runAllTimersAsync();
            await promise;
            (0, vitest_1.expect)(axiosPost).toHaveBeenCalledTimes(1);
        }
        finally {
            vitest_1.vi.useRealTimers();
        }
    });
    (0, vitest_1.it)('retries on HTTP 429 rate limit responses', async () => {
        globalThis.__webhookUrl = 'https://example.com/webhook';
        axiosPost
            .mockRejectedValueOnce({ response: { status: 429, headers: { 'retry-after': '1' } } })
            .mockResolvedValueOnce({ status: 200 });
        vitest_1.vi.useFakeTimers();
        try {
            const promise = (0, webhook_1.dispatchWebhook)(successResult);
            await vitest_1.vi.runAllTimersAsync();
            await promise;
            (0, vitest_1.expect)(axiosPost).toHaveBeenCalledTimes(2);
        }
        finally {
            vitest_1.vi.useRealTimers();
        }
    });
    (0, vitest_1.it)('ceases retrying after 3 failed attempts on persistent 5xx errors', async () => {
        globalThis.__webhookUrl = 'https://example.com/webhook';
        axiosPost.mockRejectedValue({ response: { status: 500 } });
        vitest_1.vi.useFakeTimers();
        try {
            const promise = (0, webhook_1.dispatchWebhook)(successResult);
            await vitest_1.vi.runAllTimersAsync();
            await promise;
            (0, vitest_1.expect)(axiosPost).toHaveBeenCalledTimes(3);
        }
        finally {
            vitest_1.vi.useRealTimers();
        }
    });
});
// ─── HMAC signature verification (Issue #448) ────────────────────────────────
/**
 * Helper: re-compute HMAC-SHA256 over a payload with a secret and return the
 * hex digest — mirrors what the receiver would do to verify the signature.
 */
function verifySignature(payload, secret, signature) {
    const expected = (0, crypto_1.createHmac)('sha256', secret).update(payload).digest();
    const actual = Buffer.from(signature, 'hex');
    if (expected.length !== actual.length)
        return false;
    // Use timing-safe comparison to mirror real-world verification
    return (0, crypto_1.timingSafeEqual)(expected, actual);
}
(0, vitest_1.describe)('dispatchWebhook — HMAC signature verification (issue #448)', () => {
    const SECRET = 'test-webhook-secret-32-chars-long!';
    let axiosPost;
    (0, vitest_1.beforeEach)(async () => {
        vitest_1.vi.clearAllMocks();
        globalThis.__webhookUrl = 'https://example.com/hook';
        globalThis.__webhookSecret = SECRET;
        const axios = (await Promise.resolve().then(() => __importStar(require('axios')))).default;
        axiosPost = axios.post;
        axiosPost.mockResolvedValue({ status: 200 });
    });
    // ── Presence and format ───────────────────────────────────────────────────
    (0, vitest_1.it)('dispatched request includes an X-Nodal-Signature header', async () => {
        await (0, webhook_1.dispatchWebhook)(successResult);
        const [, , opts] = axiosPost.mock.calls[0];
        (0, vitest_1.expect)(opts.headers).toHaveProperty('X-Nodal-Signature');
        (0, vitest_1.expect)(typeof opts.headers['X-Nodal-Signature']).toBe('string');
        (0, vitest_1.expect)(opts.headers['X-Nodal-Signature']).toHaveLength(64); // 32-byte SHA-256 → 64 hex chars
    });
    (0, vitest_1.it)('X-Nodal-Signature header is absent when WEBHOOK_SECRET is not configured', async () => {
        globalThis.__webhookSecret = undefined;
        await (0, webhook_1.dispatchWebhook)(successResult);
        const [, , opts] = axiosPost.mock.calls[0];
        (0, vitest_1.expect)(opts.headers).not.toHaveProperty('X-Nodal-Signature');
    });
    // ── Correctness ───────────────────────────────────────────────────────────
    (0, vitest_1.it)('HMAC value is correct — can be independently verified with the shared secret', async () => {
        await (0, webhook_1.dispatchWebhook)(successResult);
        const [, body, opts] = axiosPost.mock.calls[0];
        const signature = opts.headers['X-Nodal-Signature'];
        // Independently verify: receiver recomputes HMAC over the exact body bytes
        (0, vitest_1.expect)(verifySignature(body, SECRET, signature)).toBe(true);
    });
    (0, vitest_1.it)('signature is computed over the exact serialized JSON body', async () => {
        await (0, webhook_1.dispatchWebhook)(successResult);
        const [, body, opts] = axiosPost.mock.calls[0];
        const signature = opts.headers['X-Nodal-Signature'];
        // The body must be the JSON serialisation of successResult
        (0, vitest_1.expect)(JSON.parse(body)).toMatchObject({ success: true, taskType: 'stellar_payment' });
        // Recompute manually — must match
        const expected = (0, crypto_1.createHmac)('sha256', SECRET).update(body).digest('hex');
        (0, vitest_1.expect)(signature).toBe(expected);
    });
    (0, vitest_1.it)('different payloads produce different signatures', async () => {
        axiosPost.mockResolvedValue({ status: 200 });
        await (0, webhook_1.dispatchWebhook)(successResult);
        const [, , opts1] = axiosPost.mock.calls[0];
        const sig1 = opts1.headers['X-Nodal-Signature'];
        vitest_1.vi.clearAllMocks();
        axiosPost.mockResolvedValue({ status: 200 });
        await (0, webhook_1.dispatchWebhook)(failureResult);
        const [, , opts2] = axiosPost.mock.calls[0];
        const sig2 = opts2.headers['X-Nodal-Signature'];
        (0, vitest_1.expect)(sig1).not.toBe(sig2);
    });
    (0, vitest_1.it)('different secrets produce different signatures for the same payload', () => {
        const payload = JSON.stringify(successResult);
        const sig1 = (0, webhook_1.signPayload)(payload, 'secret-one');
        const sig2 = (0, webhook_1.signPayload)(payload, 'secret-two');
        (0, vitest_1.expect)(sig1).not.toBe(sig2);
    });
    // ── Tamper detection ──────────────────────────────────────────────────────
    (0, vitest_1.it)('tampered payload produces a detectable HMAC mismatch', async () => {
        await (0, webhook_1.dispatchWebhook)(successResult);
        const [, body, opts] = axiosPost.mock.calls[0];
        const originalSignature = opts.headers['X-Nodal-Signature'];
        // Simulate a man-in-the-middle modifying the payload after signing
        const tampered = body.replace(/"success":true/, '"success":false');
        // The tampered body must differ from the original
        (0, vitest_1.expect)(tampered).not.toBe(body);
        // Recomputing HMAC over tampered body must NOT match the original signature
        (0, vitest_1.expect)(verifySignature(tampered, SECRET, originalSignature)).toBe(false);
    });
    (0, vitest_1.it)('single-byte modification of payload invalidates the signature', async () => {
        await (0, webhook_1.dispatchWebhook)(successResult);
        const [, body, opts] = axiosPost.mock.calls[0];
        const signature = opts.headers['X-Nodal-Signature'];
        // Flip one character anywhere in the body
        const idx = Math.floor(body.length / 2);
        const tampered = body.slice(0, idx) + (body[idx] === 'a' ? 'b' : 'a') + body.slice(idx + 1);
        (0, vitest_1.expect)(verifySignature(tampered, SECRET, signature)).toBe(false);
    });
    (0, vitest_1.it)('wrong secret cannot verify a valid signature', async () => {
        await (0, webhook_1.dispatchWebhook)(successResult);
        const [, body, opts] = axiosPost.mock.calls[0];
        const signature = opts.headers['X-Nodal-Signature'];
        // Attacker has wrong secret — verification must fail
        (0, vitest_1.expect)(verifySignature(body, 'wrong-secret', signature)).toBe(false);
    });
    (0, vitest_1.it)('empty-string tamper (empty body) does not match original signature', async () => {
        await (0, webhook_1.dispatchWebhook)(successResult);
        const [, , opts] = axiosPost.mock.calls[0];
        const signature = opts.headers['X-Nodal-Signature'];
        (0, vitest_1.expect)(verifySignature('', SECRET, signature)).toBe(false);
    });
    // ── signPayload unit tests ────────────────────────────────────────────────
    (0, vitest_1.it)('signPayload is deterministic — same inputs always produce the same digest', () => {
        const payload = '{"taskType":"stellar_payment","success":true}';
        const secret = 'determinism-test-secret';
        const sig1 = (0, webhook_1.signPayload)(payload, secret);
        const sig2 = (0, webhook_1.signPayload)(payload, secret);
        (0, vitest_1.expect)(sig1).toBe(sig2);
    });
    (0, vitest_1.it)('signPayload output is a 64-character lowercase hex string', () => {
        const sig = (0, webhook_1.signPayload)('any payload', 'any secret');
        (0, vitest_1.expect)(sig).toMatch(/^[0-9a-f]{64}$/);
    });
});
//# sourceMappingURL=webhook.test.js.map