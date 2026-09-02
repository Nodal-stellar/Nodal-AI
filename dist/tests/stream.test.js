"use strict";
/**
 * tests/stream.test.ts
 * Tests for PayFiAgent startListening / stopListening (#107)
 */
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
// ─── Hoist mocks so factory closures can reference them ──────────────────────
const { mockStopStream, mockStream, mockForAccount, mockPayments } = vitest_1.vi.hoisted(() => {
    const mockStopStream = vitest_1.vi.fn();
    const mockStream = vitest_1.vi.fn(() => mockStopStream);
    const mockForAccount = vitest_1.vi.fn(() => ({ stream: mockStream }));
    const mockPayments = vitest_1.vi.fn(() => ({ forAccount: mockForAccount }));
    return { mockStopStream, mockStream, mockForAccount, mockPayments };
});
// ─── Mock tools ───────────────────────────────────────────────────────────────
vitest_1.vi.mock('../backend/tools/StellarPaymentTool', () => ({
    StellarPaymentTool: vitest_1.vi.fn().mockImplementation(() => ({ execute: vitest_1.vi.fn() })),
}));
vitest_1.vi.mock('../backend/tools/SorobanInvokeTool', async () => {
    // Keep the real SorobanInvokeInputSchema — SorobanQueryTool.ts derives its
    // own schema from it at module-load time via `.omit({...})` — while mocking
    // only the SorobanInvokeTool class.
    const actual = await vitest_1.vi.importActual('../backend/tools/SorobanInvokeTool');
    return {
        ...actual,
        SorobanInvokeTool: vitest_1.vi.fn().mockImplementation(() => ({ execute: vitest_1.vi.fn() })),
    };
});
vitest_1.vi.mock('../backend/tools/X402PaymentTool', async () => {
    // Keep the real X402ChallengeSchema (agent.ts's stream handler validates
    // against it, issue #237) while mocking only the X402PaymentTool class.
    const actual = await vitest_1.vi.importActual('../backend/tools/X402PaymentTool');
    return {
        ...actual,
        X402PaymentTool: vitest_1.vi.fn().mockImplementation(() => ({ respond: vitest_1.vi.fn() })),
    };
});
vitest_1.vi.mock('../backend/tools/AccountInfoTool', () => ({
    AccountInfoTool: vitest_1.vi.fn().mockImplementation(() => ({ fetch: vitest_1.vi.fn() })),
}));
vitest_1.vi.mock('../backend/tools/TrustlineTool', () => ({
    TrustlineTool: vitest_1.vi.fn().mockImplementation(() => ({ execute: vitest_1.vi.fn(), checkTrustline: vitest_1.vi.fn() })),
}));
vitest_1.vi.mock('../backend/tools/MultiSigPaymentTool', () => ({
    MultiSigPaymentTool: vitest_1.vi.fn().mockImplementation(() => ({ execute: vitest_1.vi.fn() })),
}));
vitest_1.vi.mock('../backend/tools/BatchPaymentTool', () => ({
    BatchPaymentTool: vitest_1.vi.fn().mockImplementation(() => ({ execute: vitest_1.vi.fn() })),
}));
vitest_1.vi.mock('../backend/rpc_client', () => ({
    loadAccount: vitest_1.vi.fn(),
    submitTransaction: vitest_1.vi.fn(),
    simulateSorobanTx: vitest_1.vi.fn(),
    prepareSorobanTx: vitest_1.vi.fn(),
    horizonServer: { payments: mockPayments },
    sorobanServer: {},
    resolveNetworkPassphrase: vitest_1.vi.fn(() => 'Test SDF Network ; September 2015'),
}));
vitest_1.vi.mock('../backend/config', () => ({
    config: {
        STELLAR_NETWORK: 'testnet',
        HORIZON_URL: 'https://horizon-testnet.stellar.org',
        SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
        AGENT_PUBLIC_KEY: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        X402_ASSET_CODE: 'USDC',
        X402_ASSET_ISSUER: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
        MAX_RETRIES: 3,
        RETRY_DELAY_MS: 100,
        AGENT_SPENDING_LIMIT: '100',
        agentKeypair: () => ({
            secret: () => 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X',
        }),
    },
    MAINNET_SPENDING_CAP: 10_000,
}));
vitest_1.vi.mock('../backend/persistence', () => ({
    saveResult: vitest_1.vi.fn(),
}));
const agent_1 = require("../backend/agent");
const logger_1 = require("../backend/logger");
(0, vitest_1.describe)('PayFiAgent — stream (issue #107)', () => {
    let agent;
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.clearAllMocks();
        // Re-setup default return since clearAllMocks resets implementations
        mockStream.mockReturnValue(mockStopStream);
        mockForAccount.mockReturnValue({ stream: mockStream });
        mockPayments.mockReturnValue({ forAccount: mockForAccount });
        agent = new agent_1.PayFiAgent();
    });
    (0, vitest_1.it)('startListening calls horizonServer.payments().forAccount().stream()', () => {
        agent.startListening('https://example.com/resource', vitest_1.vi.fn());
        (0, vitest_1.expect)(mockPayments).toHaveBeenCalledOnce();
        (0, vitest_1.expect)(mockForAccount).toHaveBeenCalledWith('GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');
        (0, vitest_1.expect)(mockStream).toHaveBeenCalledOnce();
    });
    (0, vitest_1.it)('onChallenge is invoked when stream emits a valid x402 memo', () => {
        const onChallenge = vitest_1.vi.fn();
        // Override stream to simulate an incoming payment with a valid x402 memo
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockStream.mockImplementationOnce((opts) => {
            const challenge = {
                resource: 'https://example.com/resource',
                amount: '1',
                assetCode: 'USDC',
                assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
                payTo: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
                nonce: '550e8400-e29b-41d4-a716-446655440000',
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
            };
            const encoded = Buffer.from(JSON.stringify(challenge)).toString('base64');
            opts.onmessage({ memo: `x402:${encoded}` });
            return mockStopStream;
        });
        agent.startListening('https://example.com/resource', onChallenge);
        (0, vitest_1.expect)(onChallenge).toHaveBeenCalledOnce();
        (0, vitest_1.expect)(onChallenge.mock.calls[0][0]).toMatchObject({
            resource: 'https://example.com/resource',
        });
    });
    (0, vitest_1.it)('drops a malformed-but-parseable x402 memo instead of forwarding it to onChallenge (#237)', () => {
        const onChallenge = vitest_1.vi.fn();
        const warnSpy = vitest_1.vi.spyOn(logger_1.logger, 'warn').mockImplementation(() => { });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mockStream.mockImplementationOnce((opts) => {
            // Valid JSON, but fails X402ChallengeSchema: `amount` is a number
            // instead of a string, `payTo` is not 56 characters, and `nonce`
            // is not a UUID.
            const malformedChallenge = {
                resource: 'https://example.com/resource',
                amount: 1,
                assetCode: 'USDC',
                assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
                payTo: 'not-a-real-address',
                nonce: 'not-a-uuid',
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
            };
            const encoded = Buffer.from(JSON.stringify(malformedChallenge)).toString('base64');
            opts.onmessage({ memo: `x402:${encoded}` });
            return mockStopStream;
        });
        agent.startListening('https://example.com/resource', onChallenge);
        (0, vitest_1.expect)(onChallenge).not.toHaveBeenCalled();
        (0, vitest_1.expect)(warnSpy).toHaveBeenCalledWith('Dropped invalid x402 challenge memo', vitest_1.expect.objectContaining({ error: vitest_1.expect.any(String) }));
        warnSpy.mockRestore();
    });
    (0, vitest_1.it)('stopListening calls the stream close function', () => {
        agent.startListening('https://example.com/resource', vitest_1.vi.fn());
        agent.stopListening();
        (0, vitest_1.expect)(mockStopStream).toHaveBeenCalledOnce();
    });
    (0, vitest_1.it)('stopListening inside destroy cleans up the stream', () => {
        agent.startListening('https://example.com/resource', vitest_1.vi.fn());
        (0, vitest_1.expect)(() => agent.destroy()).not.toThrow();
        (0, vitest_1.expect)(mockStopStream).toHaveBeenCalledOnce();
    });
    (0, vitest_1.it)('calling startListening twice does not open a second stream', () => {
        agent.startListening('https://example.com/resource', vitest_1.vi.fn());
        agent.startListening('https://example.com/resource', vitest_1.vi.fn());
        (0, vitest_1.expect)(mockStream).toHaveBeenCalledOnce(); // only one stream opened
    });
    // ── SSE disconnect and reconnect scenarios (#455) ─────────────────────────
    (0, vitest_1.it)('SSE stream emits 3 events then fires an error event — reconnect logic fires', () => {
        const onChallenge = vitest_1.vi.fn();
        let capturedOpts = {};
        // Capture the stream options so we can simulate SSE lifecycle events
        mockStream.mockImplementationOnce((opts) => {
            capturedOpts = opts;
            return mockStopStream;
        });
        agent.startListening('https://example.com/resource', onChallenge);
        const makeValidChallenge = (nonce) => {
            const challenge = {
                resource: 'https://example.com/resource',
                amount: '1',
                assetCode: 'USDC',
                assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
                payTo: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
                nonce,
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
            };
            return `x402:${Buffer.from(JSON.stringify(challenge)).toString('base64')}`;
        };
        // Emit 3 valid x402 events
        capturedOpts['onmessage']?.({
            memo: makeValidChallenge('550e8400-e29b-41d4-a716-446655440000'),
        });
        capturedOpts['onmessage']?.({
            memo: makeValidChallenge('550e8400-e29b-41d4-a716-446655440001'),
        });
        capturedOpts['onmessage']?.({
            memo: makeValidChallenge('550e8400-e29b-41d4-a716-446655440002'),
        });
        (0, vitest_1.expect)(onChallenge).toHaveBeenCalledTimes(3);
        // Fire an error event — the stream drops
        capturedOpts['onerror']?.({ message: 'SSE connection dropped' });
        // The agent should have called stop to close the broken stream
        (0, vitest_1.expect)(mockStopStream).toHaveBeenCalled();
    });
    (0, vitest_1.it)('SSE stream fires a close event (clean disconnect) — listener terminates without error', () => {
        const onChallenge = vitest_1.vi.fn();
        let capturedOpts = {};
        mockStream.mockImplementationOnce((opts) => {
            capturedOpts = opts;
            return mockStopStream;
        });
        agent.startListening('https://example.com/resource', onChallenge);
        // Simulate a clean SSE close
        (0, vitest_1.expect)(() => {
            capturedOpts['onclose']?.();
        }).not.toThrow();
        // No challenges should have been forwarded
        (0, vitest_1.expect)(onChallenge).not.toHaveBeenCalled();
    });
});
//# sourceMappingURL=stream.test.js.map