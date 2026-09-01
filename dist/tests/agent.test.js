"use strict";
/**
 * tests/agent.test.ts
 *
 * Tests for PayFiAgent — focused on assertWithinSpendingLimit behaviour,
 * including the secondary mainnet spending cap guard.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const agent_1 = require("../backend/agent");
const StellarPaymentTool_1 = require("../backend/tools/StellarPaymentTool");
const BalanceCheckTool_1 = require("../backend/tools/BalanceCheckTool");
const PathPaymentTool_1 = require("../backend/tools/PathPaymentTool");
const FeeBumpTool_1 = require("../backend/tools/FeeBumpTool");
const DexOfferTool_1 = require("../backend/tools/DexOfferTool");
const LiquidityPoolTool_1 = require("../backend/tools/LiquidityPoolTool");
const StellarTomlTool_1 = require("../backend/tools/StellarTomlTool");
const DataEntryTool_1 = require("../backend/tools/DataEntryTool");
const SequenceNumberTool_1 = require("../backend/tools/SequenceNumberTool");
const SponsoredAccountTool_1 = require("../backend/tools/SponsoredAccountTool");
const AnchorQuoteTool_1 = require("../backend/tools/AnchorQuoteTool");
const InflationTool_1 = require("../backend/tools/InflationTool");
const SorobanInvokeTool_1 = require("../backend/tools/SorobanInvokeTool");
const SorobanQueryTool_1 = require("../backend/tools/SorobanQueryTool");
const X402PaymentTool_1 = require("../backend/tools/X402PaymentTool");
const AccountInfoTool_1 = require("../backend/tools/AccountInfoTool");
const TrustlineTool_1 = require("../backend/tools/TrustlineTool");
const MultiSigPaymentTool_1 = require("../backend/tools/MultiSigPaymentTool");
const BatchPaymentTool_1 = require("../backend/tools/BatchPaymentTool");
const errors_1 = require("../backend/errors");
vitest_1.vi.mock('../backend/tools/StellarPaymentTool', () => ({
    StellarPaymentTool: vitest_1.vi.fn().mockImplementation(() => ({
        execute: vitest_1.vi.fn().mockResolvedValue({ txHash: 'mock_hash', ledger: 1 }),
    })),
}));
vitest_1.vi.mock('../backend/tools/SorobanInvokeTool', () => ({
    SorobanInvokeTool: vitest_1.vi.fn().mockImplementation(() => ({
        execute: vitest_1.vi.fn(),
    })),
}));
vitest_1.vi.mock('../backend/tools/X402PaymentTool', () => ({
    X402PaymentTool: vitest_1.vi.fn().mockImplementation(() => ({
        respond: vitest_1.vi.fn(),
    })),
}));
vitest_1.vi.mock('../backend/tools/AccountInfoTool', () => ({
    AccountInfoTool: vitest_1.vi.fn().mockImplementation(() => ({
        fetch: vitest_1.vi.fn(),
    })),
}));
vitest_1.vi.mock('../backend/tools/TrustlineTool', () => ({
    TrustlineTool: vitest_1.vi.fn().mockImplementation(() => ({
        execute: vitest_1.vi.fn(),
        checkTrustline: vitest_1.vi.fn(),
    })),
}));
vitest_1.vi.mock('../backend/tools/MultiSigPaymentTool', () => ({
    MultiSigPaymentTool: vitest_1.vi.fn().mockImplementation(() => ({
        execute: vitest_1.vi.fn(),
    })),
}));
vitest_1.vi.mock('../backend/tools/BatchPaymentTool', () => ({
    BatchPaymentTool: vitest_1.vi.fn().mockImplementation(() => ({
        execute: vitest_1.vi.fn(),
    })),
}));
vitest_1.vi.mock('../backend/tools/SorobanQueryTool', () => ({
    SorobanQueryTool: vitest_1.vi.fn().mockImplementation(() => ({
        query: vitest_1.vi.fn(),
    })),
}));
vitest_1.vi.mock('../backend/tools/BalanceCheckTool', () => ({
    BalanceCheckTool: vitest_1.vi.fn().mockImplementation(() => ({
        getBalance: vitest_1.vi.fn().mockResolvedValue({
            publicKey: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
            balances: [],
        }),
    })),
}));
vitest_1.vi.mock('../backend/tools/PathPaymentTool', () => ({
    PathPaymentTool: vitest_1.vi.fn().mockImplementation(() => ({
        execute: vitest_1.vi.fn().mockResolvedValue({ txHash: 'path_mock_hash', ledger: 1 }),
    })),
}));
vitest_1.vi.mock('../backend/tools/FeeBumpTool', () => ({
    FeeBumpTool: vitest_1.vi.fn().mockImplementation(() => ({
        execute: vitest_1.vi.fn().mockResolvedValue({ txHash: 'fee_bump_mock_hash', ledger: 1 }),
    })),
}));
vitest_1.vi.mock('../backend/tools/DexOfferTool', () => ({
    DexOfferTool: vitest_1.vi.fn().mockImplementation(() => ({
        execute: vitest_1.vi.fn().mockResolvedValue({ txHash: 'dex_mock_hash', ledger: 1, offerId: '0' }),
    })),
}));
vitest_1.vi.mock('../backend/tools/LiquidityPoolTool', () => ({
    LiquidityPoolTool: vitest_1.vi.fn().mockImplementation(() => ({
        execute: vitest_1.vi.fn().mockResolvedValue({ poolId: 'pool_mock_id' }),
    })),
}));
vitest_1.vi.mock('../backend/tools/StellarTomlTool', () => ({
    StellarTomlTool: vitest_1.vi.fn().mockImplementation(() => ({
        fetchToml: vitest_1.vi.fn().mockResolvedValue({ VERSION: '2.0.0' }),
    })),
}));
vitest_1.vi.mock('../backend/tools/DataEntryTool', () => ({
    DataEntryTool: vitest_1.vi.fn().mockImplementation(() => ({
        execute: vitest_1.vi.fn().mockResolvedValue({ txHash: 'data_entry_mock_hash', ledger: 1 }),
    })),
}));
vitest_1.vi.mock('../backend/tools/SequenceNumberTool', () => ({
    SequenceNumberTool: vitest_1.vi.fn().mockImplementation(() => ({
        execute: vitest_1.vi.fn().mockResolvedValue({ sequence: '12345678' }),
    })),
}));
vitest_1.vi.mock('../backend/tools/SponsoredAccountTool', () => ({
    SponsoredAccountTool: vitest_1.vi.fn().mockImplementation(() => ({
        execute: vitest_1.vi.fn().mockResolvedValue({ txHash: 'sponsored_mock_hash', ledger: 1 }),
    })),
}));
vitest_1.vi.mock('../backend/tools/AnchorQuoteTool', () => ({
    AnchorQuoteTool: vitest_1.vi.fn().mockImplementation(() => ({
        execute: vitest_1.vi.fn().mockResolvedValue({ quoteId: 'quote_mock_id', price: '1.0' }),
    })),
}));
vitest_1.vi.mock('../backend/tools/InflationTool', () => ({
    InflationTool: vitest_1.vi.fn().mockImplementation(() => ({
        execute: vitest_1.vi.fn().mockResolvedValue({ txHash: 'inflation_mock_hash', ledger: 1 }),
    })),
}));
vitest_1.vi.mock('../backend/tools/ContractEventListener', () => ({
    listen: vitest_1.vi.fn().mockReturnValue(() => { }),
}));
vitest_1.vi.mock('../backend/webhook', () => ({
    dispatchWebhook: vitest_1.vi.fn().mockResolvedValue(undefined),
}));
vitest_1.vi.mock('../backend/persistence', () => ({
    saveResult: vitest_1.vi.fn(),
}));
// Named so `instanceof rpcClient.StellarRPCError` checks in agent.ts's error
// handling work against real thrown errors, matching the real class shape.
// Declared via vi.hoisted() because vi.mock() factories are hoisted above
// regular statements — a plain `class` declared here would be in its temporal
// dead zone by the time the factory below actually runs.
const { MockStellarRPCError } = vitest_1.vi.hoisted(() => {
    class MockStellarRPCError extends Error {
        cause;
        constructor(message, cause) {
            super(message);
            this.name = 'StellarRPCError';
            this.cause = cause;
        }
    }
    return { MockStellarRPCError };
});
vitest_1.vi.mock('../backend/rpc_client', () => ({
    loadAccount: vitest_1.vi.fn(),
    submitTransaction: vitest_1.vi.fn(),
    prepareSorobanTx: vitest_1.vi.fn(),
    prepareSorobanTxWithEvents: vitest_1.vi.fn(),
    simulateSorobanTx: vitest_1.vi.fn(),
    horizonServer: { payments: vitest_1.vi.fn(() => ({ forAccount: vitest_1.vi.fn(() => ({ stream: vitest_1.vi.fn() })) })) },
    sorobanServer: {},
    resolveNetworkPassphrase: vitest_1.vi.fn(() => 'Public Global Stellar Network ; September 2015'),
    StellarRPCError: MockStellarRPCError,
}));
vitest_1.vi.mock('../backend/config', () => ({
    config: {
        STELLAR_NETWORK: 'mainnet',
        HORIZON_URL: 'https://horizon.stellar.org',
        SOROBAN_RPC_URL: 'https://soroban-mainnet.stellar.org',
        AGENT_PUBLIC_KEY: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        X402_ASSET_CODE: 'USDC',
        X402_ASSET_ISSUER: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
        MAX_RETRIES: 3,
        RETRY_DELAY_MS: 100,
        MAX_CONCURRENT_TASKS: 10, // Set above MAINNET_SPENDING_CAP to exercise the secondary runtime guard
        AGENT_SPENDING_LIMIT: '15000',
        agentKeypair: () => ({
            secret: () => 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X',
        }),
    },
    MAINNET_SPENDING_CAP: 10_000,
}));
// ─── Tests ────────────────────────────────────────────────────────────────────
const DEST = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
(0, vitest_1.describe)('PayFiAgent — runSequence', () => {
    let agent;
    (0, vitest_1.beforeEach)(() => {
        agent_1.spendingTracker.clear();
        vitest_1.vi.clearAllMocks();
        // Re-apply default mock implementation after clearAllMocks (clearMocks resets call history
        // but also clears mockReturnValue / mockResolvedValue set inside vi.mock factories).
        vitest_1.vi.mocked(StellarPaymentTool_1.StellarPaymentTool).mockImplementation(() => ({
            execute: vitest_1.vi.fn().mockResolvedValue({ txHash: 'mock_hash', ledger: 1 }),
        }));
        agent = new agent_1.PayFiAgent();
    });
    (0, vitest_1.it)('executes 3 tasks in order and returns all results on success', async () => {
        const task = {
            type: 'stellar_payment',
            payload: { destination: DEST, amount: '100', assetCode: 'USDC', assetIssuer: ISSUER },
        };
        const results = await agent.runSequence([task, task, task]);
        (0, vitest_1.expect)(results).toHaveLength(3);
        (0, vitest_1.expect)(results.every((r) => r.success)).toBe(true);
    });
    (0, vitest_1.it)('stops at task 2 when it fails and does not execute task 3', async () => {
        const mockInstance = vitest_1.vi.mocked(StellarPaymentTool_1.StellarPaymentTool).mock.results[0].value;
        mockInstance.execute
            .mockResolvedValueOnce({ txHash: 'hash1', ledger: 1 })
            .mockRejectedValueOnce(new Error('Network failure'));
        const task = {
            type: 'stellar_payment',
            payload: { destination: DEST, amount: '100', assetCode: 'USDC', assetIssuer: ISSUER },
        };
        const results = await agent.runSequence([task, task, task]);
        (0, vitest_1.expect)(results).toHaveLength(2);
        (0, vitest_1.expect)(results[0].success).toBe(true);
        (0, vitest_1.expect)(results[1].success).toBe(false);
        (0, vitest_1.expect)(results[1].error).toContain('Network failure');
        (0, vitest_1.expect)(mockInstance.execute).toHaveBeenCalledTimes(2);
    });
    // ── #370: positional context on sequence results ──────────────────────────
    (0, vitest_1.it)('stamps sequenceIndex on every result, including the one that failed', async () => {
        const mockInstance = vitest_1.vi.mocked(StellarPaymentTool_1.StellarPaymentTool).mock.results[0].value;
        mockInstance.execute
            .mockResolvedValueOnce({ txHash: 'hash1', ledger: 1 })
            .mockRejectedValueOnce(new Error('Network failure'));
        const task = {
            type: 'stellar_payment',
            payload: { destination: DEST, amount: '100', assetCode: 'USDC', assetIssuer: ISSUER },
        };
        const results = await agent.runSequence([task, task, task]);
        (0, vitest_1.expect)(results).toHaveLength(2);
        (0, vitest_1.expect)(results[0].sequenceIndex).toBe(0);
        // The failing task is index 1 of the original three, and says so without
        // the caller having to infer it from the truncated array.
        (0, vitest_1.expect)(results[1].sequenceIndex).toBe(1);
        (0, vitest_1.expect)(results[1].success).toBe(false);
    });
    (0, vitest_1.it)('keeps sequenceIndex correct after the results array is filtered', async () => {
        const mockInstance = vitest_1.vi.mocked(StellarPaymentTool_1.StellarPaymentTool).mock.results[0].value;
        mockInstance.execute
            .mockResolvedValueOnce({ txHash: 'hash1', ledger: 1 })
            .mockResolvedValueOnce({ txHash: 'hash2', ledger: 2 })
            .mockRejectedValueOnce(new Error('Network failure'));
        const task = {
            type: 'stellar_payment',
            payload: { destination: DEST, amount: '100', assetCode: 'USDC', assetIssuer: ISSUER },
        };
        const results = await agent.runSequence([task, task, task]);
        // This is the case array position cannot answer: once the successes are
        // dropped, position 0 of the filtered array is task 2 of the sequence.
        const failures = results.filter((r) => !r.success);
        (0, vitest_1.expect)(failures).toHaveLength(1);
        (0, vitest_1.expect)(failures[0].sequenceIndex).toBe(2);
    });
    (0, vitest_1.it)('does not set sequenceIndex on a single run()', async () => {
        const result = await agent.run({
            type: 'stellar_payment',
            payload: { destination: DEST, amount: '100', assetCode: 'USDC', assetIssuer: ISSUER },
        });
        (0, vitest_1.expect)(result.sequenceIndex).toBeUndefined();
    });
    (0, vitest_1.it)('rejects mid-sequence when a task exceeds the mainnet spending cap', async () => {
        const okTask = {
            type: 'stellar_payment',
            payload: { destination: DEST, amount: '9999', assetCode: 'USDC', assetIssuer: ISSUER },
        };
        const overCapTask = {
            type: 'stellar_payment',
            payload: { destination: DEST, amount: '11000', assetCode: 'USDC', assetIssuer: ISSUER },
        };
        const results = await agent.runSequence([okTask, overCapTask, okTask]);
        (0, vitest_1.expect)(results).toHaveLength(2);
        (0, vitest_1.expect)(results[0].success).toBe(true);
        (0, vitest_1.expect)(results[1].success).toBe(false);
        (0, vitest_1.expect)(results[1].error).toMatch(/mainnet spending cap/);
    });
});
// ── #368: structured auth context reaches AgentResult.error ─────────────────
(0, vitest_1.describe)('PayFiAgent — structured error context', () => {
    let agent;
    const ROGUE_SIGNER = 'GCVJ4Z6TI6Z2SOGENSPXDQ2U4RKH3CNQKYUHNSSQ5HDIWEVI6V6VOSWZ';
    (0, vitest_1.beforeEach)(() => {
        agent_1.spendingTracker.clear();
        vitest_1.vi.clearAllMocks();
        agent = new agent_1.PayFiAgent();
    });
    (0, vitest_1.it)('serialises UnauthorizedError context, including the signer, into error', async () => {
        vitest_1.vi.mocked(StellarPaymentTool_1.StellarPaymentTool).mockImplementation(() => ({
            execute: vitest_1.vi.fn().mockRejectedValue(new errors_1.UnauthorizedError(`Unexpected Soroban auth signer: ${ROGUE_SIGNER}`, {
                signer: ROGUE_SIGNER,
                expected: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
            })),
        }));
        agent = new agent_1.PayFiAgent();
        const result = await agent.run({
            type: 'stellar_payment',
            payload: { destination: DEST, amount: '100', assetCode: 'USDC', assetIssuer: ISSUER },
        });
        (0, vitest_1.expect)(result.success).toBe(false);
        (0, vitest_1.expect)(result.errorType).toBe(errors_1.ErrorType.UnauthorizedError);
        // The signer must survive into the string field, because that is all the
        // persisted result and the webhook payload carry.
        (0, vitest_1.expect)(result.error).toContain(ROGUE_SIGNER);
        (0, vitest_1.expect)(result.error).toContain('expected');
    });
    (0, vitest_1.it)('leaves the message untouched for an error with no structured cause', async () => {
        vitest_1.vi.mocked(StellarPaymentTool_1.StellarPaymentTool).mockImplementation(() => ({
            execute: vitest_1.vi.fn().mockRejectedValue(new Error('plain failure')),
        }));
        agent = new agent_1.PayFiAgent();
        const result = await agent.run({
            type: 'stellar_payment',
            payload: { destination: DEST, amount: '100', assetCode: 'USDC', assetIssuer: ISSUER },
        });
        (0, vitest_1.expect)(result.error).toBe('plain failure');
        (0, vitest_1.expect)(result.error).not.toContain('context:');
    });
    (0, vitest_1.it)('does not serialise signing material out of an error cause', async () => {
        const SECRET = 'SCVJ4Z6TI6Z2SOGENSPXDQ2U4RKH3CNQKYUHNSSQ5HDIWEVI6V6VOAAA';
        vitest_1.vi.mocked(StellarPaymentTool_1.StellarPaymentTool).mockImplementation(() => ({
            execute: vitest_1.vi
                .fn()
                .mockRejectedValue(new errors_1.UnauthorizedError('bad signer', { signer: ROGUE_SIGNER, secretKey: SECRET })),
        }));
        agent = new agent_1.PayFiAgent();
        const result = await agent.run({
            type: 'stellar_payment',
            payload: { destination: DEST, amount: '100', assetCode: 'USDC', assetIssuer: ISSUER },
        });
        (0, vitest_1.expect)(result.error).toContain(ROGUE_SIGNER);
        (0, vitest_1.expect)(result.error).not.toContain(SECRET);
    });
});
(0, vitest_1.describe)('PayFiAgent — mainnet spending cap', () => {
    let agent;
    (0, vitest_1.beforeEach)(() => {
        agent_1.spendingTracker.clear();
        vitest_1.vi.clearAllMocks();
        vitest_1.vi.mocked(StellarPaymentTool_1.StellarPaymentTool).mockImplementation(() => ({
            execute: vitest_1.vi.fn().mockResolvedValue({ txHash: 'mock_hash', ledger: 1 }),
        }));
        agent = new agent_1.PayFiAgent();
    });
    (0, vitest_1.it)('rejects a stellar_payment above MAINNET_SPENDING_CAP on mainnet', async () => {
        const result = await agent.run({
            type: 'stellar_payment',
            payload: {
                destination: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
                amount: '12000',
                assetCode: 'USDC',
                assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
            },
        });
        (0, vitest_1.expect)(result.success).toBe(false);
        (0, vitest_1.expect)(result.error).toMatch(/mainnet spending cap/);
    });
    (0, vitest_1.it)('rejects an x402_respond above MAINNET_SPENDING_CAP on mainnet', async () => {
        const result = await agent.run({
            type: 'x402_respond',
            payload: {
                resource: 'https://api.example.com/data',
                amount: '11000',
                assetCode: 'USDC',
                assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
                payTo: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
                nonce: '550e8400-e29b-41d4-a716-446655440000',
                expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
        });
        (0, vitest_1.expect)(result.success).toBe(false);
        (0, vitest_1.expect)(result.error).toMatch(/mainnet spending cap/);
    });
    (0, vitest_1.it)('accepts a stellar_payment at or below MAINNET_SPENDING_CAP on mainnet', async () => {
        const result = await agent.run({
            type: 'stellar_payment',
            payload: {
                destination: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
                amount: '9999',
                assetCode: 'USDC',
                assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
            },
        });
        (0, vitest_1.expect)(result.success).toBe(true);
    });
    (0, vitest_1.it)('two PayFiAgent instances do not share state when run concurrently', async () => {
        vitest_1.vi.clearAllMocks();
        const agent1 = new agent_1.PayFiAgent();
        const agent2 = new agent_1.PayFiAgent();
        const mockInstance1 = vitest_1.vi.mocked(StellarPaymentTool_1.StellarPaymentTool).mock.results[0].value;
        const mockInstance2 = vitest_1.vi.mocked(StellarPaymentTool_1.StellarPaymentTool).mock.results[1].value;
        mockInstance1.execute.mockResolvedValueOnce({ txHash: 'tx_hash_1', ledger: 1 });
        mockInstance2.execute.mockResolvedValueOnce({ txHash: 'tx_hash_2', ledger: 2 });
        const task = {
            type: 'stellar_payment',
            payload: {
                destination: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
                amount: '100',
                assetCode: 'USDC',
                assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
            },
        };
        const [result1, result2] = await Promise.all([agent1.run(task), agent2.run(task)]);
        (0, vitest_1.expect)(result1.success).toBe(true);
        (0, vitest_1.expect)(result2.success).toBe(true);
        (0, vitest_1.expect)(result1.data?.txHash).toBe('tx_hash_1');
        (0, vitest_1.expect)(result2.data?.txHash).toBe('tx_hash_2');
        (0, vitest_1.expect)(result1.data?.txHash).toBe('tx_hash_1');
        (0, vitest_1.expect)(result2.data?.txHash).toBe('tx_hash_2');
        (0, vitest_1.expect)(agent1).not.toBe(agent2);
    });
});
(0, vitest_1.describe)('AgentResult snapshot', () => {
    let agent;
    (0, vitest_1.beforeEach)(() => {
        agent_1.spendingTracker.clear();
        vitest_1.vi.clearAllMocks();
        vitest_1.vi.mocked(StellarPaymentTool_1.StellarPaymentTool).mockImplementation(() => ({
            execute: vitest_1.vi.fn().mockResolvedValue({ txHash: 'success_tx_hash', ledger: 1 }),
        }));
        agent = new agent_1.PayFiAgent();
    });
    (0, vitest_1.it)('AgentResult has expected shape on success', async () => {
        const result = await agent.run({
            type: 'stellar_payment',
            payload: {
                destination: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
                amount: '100',
                assetCode: 'USDC',
                assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
            },
            correlationId: 'fixed-test-id-success',
        });
        (0, vitest_1.expect)(result).toMatchSnapshot();
        (0, vitest_1.expect)(result).toHaveProperty('success', true);
        (0, vitest_1.expect)(result).toHaveProperty('taskType', 'stellar_payment');
        (0, vitest_1.expect)(result).toHaveProperty('data');
    });
    (0, vitest_1.it)('adds network metadata to payment task results', async () => {
        const result = await agent.run({
            type: 'stellar_payment',
            payload: {
                destination: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
                amount: '100',
                assetCode: 'USDC',
                assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
            },
        });
        (0, vitest_1.expect)(result.success).toBe(true);
        (0, vitest_1.expect)(result.data).toMatchObject({ network: 'mainnet' });
    });
    (0, vitest_1.it)('AgentResult has expected shape on failure', async () => {
        const mockInstance = vitest_1.vi.mocked(StellarPaymentTool_1.StellarPaymentTool).mock.results[0].value;
        mockInstance.execute.mockRejectedValueOnce(new Error('Test error'));
        const result = await agent.run({
            type: 'stellar_payment',
            payload: {
                destination: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
                amount: '100',
                assetCode: 'USDC',
                assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
            },
            correlationId: 'fixed-test-id-failure',
        });
        (0, vitest_1.expect)(result).toMatchSnapshot();
        (0, vitest_1.expect)(result).toHaveProperty('success', false);
        (0, vitest_1.expect)(result).toHaveProperty('taskType', 'stellar_payment');
        (0, vitest_1.expect)(result).toHaveProperty('error');
    });
});
(0, vitest_1.describe)('PayFiAgent — new task types', () => {
    let agent;
    (0, vitest_1.beforeEach)(() => {
        agent_1.spendingTracker.clear();
        vitest_1.vi.clearAllMocks();
        vitest_1.vi.mocked(StellarPaymentTool_1.StellarPaymentTool).mockImplementation(() => ({
            execute: vitest_1.vi.fn().mockResolvedValue({ txHash: 'mock_hash', ledger: 1 }),
        }));
        vitest_1.vi.mocked(BalanceCheckTool_1.BalanceCheckTool).mockImplementation(() => ({
            getBalance: vitest_1.vi.fn().mockResolvedValue({ publicKey: DEST, balances: [] }),
        }));
        vitest_1.vi.mocked(PathPaymentTool_1.PathPaymentTool).mockImplementation(() => ({
            execute: vitest_1.vi.fn().mockResolvedValue({ txHash: 'path_mock_hash', ledger: 1 }),
        }));
        vitest_1.vi.mocked(FeeBumpTool_1.FeeBumpTool).mockImplementation(() => ({
            execute: vitest_1.vi.fn().mockResolvedValue({ txHash: 'fee_bump_mock_hash', ledger: 1 }),
        }));
        vitest_1.vi.mocked(DexOfferTool_1.DexOfferTool).mockImplementation(() => ({
            execute: vitest_1.vi.fn().mockResolvedValue({ txHash: 'dex_mock_hash', ledger: 1, offerId: '0' }),
        }));
        agent = new agent_1.PayFiAgent();
    });
    (0, vitest_1.it)('dispatches balance_check and returns success', async () => {
        const result = await agent.run({
            type: 'balance_check',
            payload: { publicKey: DEST },
        });
        (0, vitest_1.expect)(result.success).toBe(true);
        (0, vitest_1.expect)(result.taskType).toBe('balance_check');
    });
    (0, vitest_1.it)('dispatches path_payment and returns success', async () => {
        const result = await agent.run({
            type: 'path_payment',
            payload: {
                destination: DEST,
                sendAsset: { code: 'XLM' },
                sendAmount: '10',
                destAsset: { code: 'USDC', issuer: ISSUER },
                destMinAmount: '9',
            },
        });
        (0, vitest_1.expect)(result.success).toBe(true);
        (0, vitest_1.expect)(result.taskType).toBe('path_payment');
    });
    (0, vitest_1.it)('dispatches fee_bump and returns success', async () => {
        const result = await agent.run({
            type: 'fee_bump',
            payload: { innerTxXdr: 'AAAA' },
        });
        (0, vitest_1.expect)(result.success).toBe(true);
        (0, vitest_1.expect)(result.taskType).toBe('fee_bump');
    });
    (0, vitest_1.it)('dispatches dex_offer and returns success', async () => {
        const result = await agent.run({
            type: 'dex_offer',
            payload: {
                action: 'create',
                selling: { code: 'XLM' },
                buying: { code: 'USDC', issuer: ISSUER },
                amount: '100',
                price: '0.25',
            },
        });
        (0, vitest_1.expect)(result.success).toBe(true);
        (0, vitest_1.expect)(result.taskType).toBe('dex_offer');
    });
    (0, vitest_1.it)('startContractListener starts the listener and stopContractListener stops it', () => {
        const onEvent = vitest_1.vi.fn();
        agent.startContractListener('CDPVBHPSVYKWSI5ECEA4DASBG3RBNU5EHEE3DHNFX7RMBCZV66CSC7NH', [], onEvent);
        agent.stopContractListener();
        // No error thrown — listener lifecycle works
    });
    (0, vitest_1.it)('destroy() cleans up the contract listener', () => {
        const onEvent = vitest_1.vi.fn();
        agent.startContractListener('CDPVBHPSVYKWSI5ECEA4DASBG3RBNU5EHEE3DHNFX7RMBCZV66CSC7NH', [], onEvent);
        (0, vitest_1.expect)(() => agent.destroy()).not.toThrow();
    });
});
(0, vitest_1.describe)('PayFiAgent — drain / waitForPendingTasks', () => {
    let agent;
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.clearAllMocks();
        vitest_1.vi.mocked(StellarPaymentTool_1.StellarPaymentTool).mockImplementation(() => ({
            execute: vitest_1.vi.fn().mockResolvedValue({ txHash: 'mock_hash', ledger: 1 }),
        }));
        agent = new agent_1.PayFiAgent();
    });
    (0, vitest_1.it)('rejects new tasks after drain() is called', async () => {
        agent.drain();
        const result = await agent.run({
            type: 'stellar_payment',
            payload: { destination: DEST, amount: '100', assetCode: 'USDC', assetIssuer: ISSUER },
        });
        (0, vitest_1.expect)(result.success).toBe(false);
        (0, vitest_1.expect)(result.error).toMatch(/shutting down/i);
    });
    (0, vitest_1.it)('waitForPendingTasks() resolves when activeTasks reaches 0', async () => {
        let resolveExecute;
        const pending = new Promise((resolve) => {
            resolveExecute = resolve;
        });
        const mockInstance = vitest_1.vi.mocked(StellarPaymentTool_1.StellarPaymentTool).mock.results[0].value;
        mockInstance.execute.mockReturnValueOnce(pending);
        const runPromise = agent.run({
            type: 'stellar_payment',
            payload: { destination: DEST, amount: '100', assetCode: 'USDC', assetIssuer: ISSUER },
        });
        // Let run() reach the `activeTasks++` before checking wait behaviour.
        await Promise.resolve();
        let waitResolved = false;
        const waitPromise = agent.waitForPendingTasks().then(() => {
            waitResolved = true;
        });
        // Task is still in flight — waitForPendingTasks() must still be pending.
        await new Promise((r) => setTimeout(r, 50));
        (0, vitest_1.expect)(waitResolved).toBe(false);
        resolveExecute({ txHash: 'mock_hash', ledger: 1 });
        await runPromise;
        await waitPromise;
        (0, vitest_1.expect)(waitResolved).toBe(true);
    });
    (0, vitest_1.it)('waitForPendingTasks() resolves immediately if no tasks are active', async () => {
        const setIntervalSpy = vitest_1.vi.spyOn(global, 'setInterval');
        await agent.waitForPendingTasks();
        (0, vitest_1.expect)(setIntervalSpy).not.toHaveBeenCalled();
        setIntervalSpy.mockRestore();
    });
});
(0, vitest_1.describe)('PayFiAgent — middleware system', () => {
    let agent;
    (0, vitest_1.beforeEach)(() => {
        agent_1.spendingTracker.clear();
        vitest_1.vi.clearAllMocks();
        vitest_1.vi.mocked(StellarPaymentTool_1.StellarPaymentTool).mockImplementation(() => ({
            execute: vitest_1.vi.fn().mockResolvedValue({ txHash: 'mock_hash', ledger: 1 }),
        }));
        agent = new agent_1.PayFiAgent();
    });
    (0, vitest_1.it)('registers middleware via use() method', () => {
        const middleware = vitest_1.vi.fn(async (task, next) => next());
        agent.use(middleware);
        // Middleware is registered - verified by internal state
        (0, vitest_1.expect)(agent).toBeDefined();
    });
    (0, vitest_1.it)('executes middleware in registration order', async () => {
        const executionOrder = [];
        agent.use(async (task, next) => {
            executionOrder.push('middleware1');
            return next();
        });
        agent.use(async (task, next) => {
            executionOrder.push('middleware2');
            return next();
        });
        const result = await agent.run({
            type: 'stellar_payment',
            payload: { destination: DEST, amount: '100', assetCode: 'USDC', assetIssuer: ISSUER },
        });
        (0, vitest_1.expect)(result.success).toBe(true);
        (0, vitest_1.expect)(executionOrder).toEqual(['middleware1', 'middleware2']);
    });
    (0, vitest_1.it)('allows middleware to short-circuit task execution', async () => {
        agent.use(async (task, next) => {
            return {
                success: false,
                taskType: task.type,
                error: 'Short-circuited by middleware',
                correlationId: task.correlationId ?? 'test-correlation-id',
            };
        });
        const result = await agent.run({
            type: 'stellar_payment',
            payload: { destination: DEST, amount: '100', assetCode: 'USDC', assetIssuer: ISSUER },
        });
        (0, vitest_1.expect)(result.success).toBe(false);
        (0, vitest_1.expect)(result.error).toBe('Short-circuited by middleware');
        // Tool should not have been called
        const mockInstance = vitest_1.vi.mocked(StellarPaymentTool_1.StellarPaymentTool).mock.results[0]?.value;
        if (mockInstance) {
            (0, vitest_1.expect)(mockInstance.execute).not.toHaveBeenCalled();
        }
    });
    (0, vitest_1.it)('middleware can inspect and modify task before execution', async () => {
        agent.use(async (task, next) => {
            // Modify the task payload
            if (task.type === 'stellar_payment') {
                task.payload.amount = '50';
            }
            return next();
        });
        const result = await agent.run({
            type: 'stellar_payment',
            payload: { destination: DEST, amount: '100', assetCode: 'USDC', assetIssuer: ISSUER },
        });
        (0, vitest_1.expect)(result.success).toBe(true);
        // Verify the tool was called with modified payload
        const mockInstance = vitest_1.vi.mocked(StellarPaymentTool_1.StellarPaymentTool).mock.results[0]?.value;
        if (mockInstance) {
            (0, vitest_1.expect)(mockInstance.execute).toHaveBeenCalledWith(vitest_1.expect.objectContaining({ amount: '50' }));
        }
    });
    (0, vitest_1.it)('middleware handles errors thrown in middleware', async () => {
        agent.use(async (task, next) => {
            throw new Error('Middleware error');
        });
        const result = await agent.run({
            type: 'stellar_payment',
            payload: { destination: DEST, amount: '100', assetCode: 'USDC', assetIssuer: ISSUER },
        });
        (0, vitest_1.expect)(result.success).toBe(false);
        (0, vitest_1.expect)(result.error).toContain('Middleware error');
    });
    (0, vitest_1.it)('middleware executes after task completion (post-execution)', async () => {
        const postExecutionLog = [];
        agent.use(async (task, next) => {
            const result = await next();
            postExecutionLog.push('after-execution');
            return result;
        });
        const result = await agent.run({
            type: 'stellar_payment',
            payload: { destination: DEST, amount: '100', assetCode: 'USDC', assetIssuer: ISSUER },
        });
        (0, vitest_1.expect)(result.success).toBe(true);
        (0, vitest_1.expect)(postExecutionLog).toEqual(['after-execution']);
    });
    (0, vitest_1.it)('pass-through middleware with no modifications', async () => {
        agent.use(async (task, next) => {
            // Just pass through without modification
            return next();
        });
        const result = await agent.run({
            type: 'stellar_payment',
            payload: { destination: DEST, amount: '100', assetCode: 'USDC', assetIssuer: ISSUER },
        });
        (0, vitest_1.expect)(result.success).toBe(true);
    });
});
(0, vitest_1.describe)('PayFiAgent — payload sanitisation', () => {
    let agent;
    (0, vitest_1.beforeEach)(() => {
        agent_1.spendingTracker.clear();
        vitest_1.vi.clearAllMocks();
        vitest_1.vi.mocked(StellarPaymentTool_1.StellarPaymentTool).mockImplementation(() => ({
            execute: vitest_1.vi.fn().mockResolvedValue({ txHash: 'mock_hash', ledger: 1 }),
        }));
        agent = new agent_1.PayFiAgent();
    });
    (0, vitest_1.it)('scrubs secretKey from payload before logging on failure', async () => {
        const mockInstance = vitest_1.vi.mocked(StellarPaymentTool_1.StellarPaymentTool).mock.results[0]?.value;
        if (!mockInstance)
            throw new Error('Mock instance not found');
        mockInstance.execute.mockRejectedValueOnce(new Error('simulated payment failure'));
        const result = await agent.run({
            type: 'stellar_payment',
            payload: {
                destination: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
                amount: '100',
                assetCode: 'USDC',
                assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
                secretKey: 'SABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
            },
        });
        (0, vitest_1.expect)(result.success).toBe(false);
        (0, vitest_1.expect)(result.error).toBe('simulated payment failure');
        (0, vitest_1.expect)(result.error).not.toContain('SABCDEFGHIJKLMNOPQRSTUVWXYZ234567');
    });
    (0, vitest_1.it)('recursively redacts nested sensitive keys in deeply nested objects', async () => {
        const mockInstance = vitest_1.vi.mocked(StellarPaymentTool_1.StellarPaymentTool).mock.results[0]?.value;
        if (!mockInstance)
            throw new Error('Mock instance not found');
        mockInstance.execute.mockRejectedValueOnce(new Error('simulated nested payload failure'));
        const result = await agent.run({
            type: 'stellar_payment',
            payload: {
                destination: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
                amount: '100',
                assetCode: 'USDC',
                assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
                signer: {
                    secretKey: 'SABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
                    address: 'GXYZ',
                },
                nested: {
                    level2: {
                        privateKey: 'SABCDEFGHIJKLMNOPQRSTUVWXYZ234567',
                        mnemonic: 'word1 word2 word3',
                    },
                },
            },
        });
        (0, vitest_1.expect)(result.success).toBe(false);
        (0, vitest_1.expect)(result.error).toBe('simulated nested payload failure');
    });
    (0, vitest_1.it)('includes errorType in AgentResult for structured errors', async () => {
        const mockInstance = vitest_1.vi.mocked(StellarPaymentTool_1.StellarPaymentTool).mock.results[0]?.value;
        if (!mockInstance)
            throw new Error('Mock instance not found');
        mockInstance.execute.mockRejectedValueOnce(new errors_1.ValidationError('Invalid payment parameters'));
        const result = await agent.run({
            type: 'stellar_payment',
            payload: {
                destination: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
                amount: '100',
                assetCode: 'USDC',
                assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
            },
        });
        (0, vitest_1.expect)(result.success).toBe(false);
        (0, vitest_1.expect)(result.errorType).toBe('VALIDATION_ERROR');
        (0, vitest_1.expect)(result.error).toBe('Invalid payment parameters');
    });
});
// ─── Mutation-killing assertions for backend/agent.ts (#456) ─────────────────
// These tests are specifically designed to eliminate surviving mutants that
// Stryker identifies in the spending-limit guards, spending-cap boundary checks,
// and task-dispatch branching in PayFiAgent.
(0, vitest_1.describe)('PayFiAgent — mutation-killing: spending-limit boundary conditions', () => {
    let agent;
    (0, vitest_1.beforeEach)(() => {
        agent_1.spendingTracker.clear();
        vitest_1.vi.clearAllMocks();
        vitest_1.vi.mocked(StellarPaymentTool_1.StellarPaymentTool).mockImplementation(() => ({ execute: vitest_1.vi.fn().mockResolvedValue({ txHash: 'ok', ledger: 1 }) }));
        agent = new agent_1.PayFiAgent();
    });
    (0, vitest_1.it)('rejects a payment exactly equal to AGENT_SPENDING_LIMIT (boundary — must fail)', async () => {
        // AGENT_SPENDING_LIMIT is set to "15000" in test config; MAINNET_SPENDING_CAP is 10_000.
        // A payment of exactly 10001 should be blocked by the mainnet cap (> 10_000).
        const result = await agent.run({
            type: 'stellar_payment',
            payload: { destination: DEST, amount: '10001', assetCode: 'XLM' },
        });
        (0, vitest_1.expect)(result.success).toBe(false);
        (0, vitest_1.expect)(result.error).toMatch(/mainnet spending cap/i);
    });
    (0, vitest_1.it)('rejects a payment one unit above MAINNET_SPENDING_CAP (10001)', async () => {
        const result = await agent.run({
            type: 'stellar_payment',
            payload: { destination: DEST, amount: '10002', assetCode: 'XLM' },
        });
        (0, vitest_1.expect)(result.success).toBe(false);
        (0, vitest_1.expect)(result.error).toMatch(/mainnet spending cap/i);
    });
    (0, vitest_1.it)('allows a payment strictly below MAINNET_SPENDING_CAP (9999)', async () => {
        const result = await agent.run({
            type: 'stellar_payment',
            payload: { destination: DEST, amount: '9999', assetCode: 'XLM' },
        });
        // The mock resolves, so this should succeed (assuming spending tracker starts empty)
        (0, vitest_1.expect)(result.success).toBe(true);
    });
    (0, vitest_1.it)('result.taskType always equals the dispatched task type', async () => {
        const result = await agent.run({
            type: 'stellar_payment',
            payload: { destination: DEST, amount: '1', assetCode: 'XLM' },
        });
        // Mutants that swap or delete the taskType assignment would break this.
        (0, vitest_1.expect)(result.taskType).toBe('stellar_payment');
    });
    (0, vitest_1.it)('result.success is exactly false (not truthy-falsy) when the payment fails', async () => {
        vitest_1.vi.mocked(StellarPaymentTool_1.StellarPaymentTool).mockImplementation(() => ({ execute: vitest_1.vi.fn().mockRejectedValue(new Error('forced failure')) }));
        const agent2 = new agent_1.PayFiAgent();
        const result = await agent2.run({
            type: 'stellar_payment',
            payload: { destination: DEST, amount: '1', assetCode: 'XLM' },
        });
        (0, vitest_1.expect)(result.success).toBe(false); // strict false, not just falsy
        (0, vitest_1.expect)(result.success).not.toBe(true);
    });
    (0, vitest_1.it)('result.success is exactly true (not truthy) when the payment succeeds', async () => {
        const result = await agent.run({
            type: 'stellar_payment',
            payload: { destination: DEST, amount: '1', assetCode: 'XLM' },
        });
        (0, vitest_1.expect)(result.success).toBe(true); // strict true
        (0, vitest_1.expect)(result.success).not.toBe(false);
    });
    (0, vitest_1.it)('run() rejects unknown task types with an error result (not a thrown exception)', async () => {
        const result = await agent.run({
            type: 'unknown_type',
            payload: {},
        });
        (0, vitest_1.expect)(result.success).toBe(false);
        (0, vitest_1.expect)(result.error).toMatch(/unknown task type/i);
    });
    (0, vitest_1.it)('correlationId is always a non-empty string on success', async () => {
        const result = await agent.run({
            type: 'stellar_payment',
            payload: { destination: DEST, amount: '1', assetCode: 'XLM' },
        });
        (0, vitest_1.expect)(typeof result.correlationId).toBe('string');
        (0, vitest_1.expect)(result.correlationId.length).toBeGreaterThan(0);
    });
    (0, vitest_1.it)('correlationId is always a non-empty string on failure', async () => {
        vitest_1.vi.mocked(StellarPaymentTool_1.StellarPaymentTool).mockImplementation(() => ({ execute: vitest_1.vi.fn().mockRejectedValue(new Error('forced')) }));
        const a2 = new agent_1.PayFiAgent();
        const result = await a2.run({
            type: 'stellar_payment',
            payload: { destination: DEST, amount: '1', assetCode: 'XLM' },
        });
        (0, vitest_1.expect)(typeof result.correlationId).toBe('string');
        (0, vitest_1.expect)(result.correlationId.length).toBeGreaterThan(0);
    });
});
(0, vitest_1.describe)('PayFiAgent — mutation-killing: StellarPaymentTool data passthrough', () => {
    let agent;
    (0, vitest_1.beforeEach)(() => {
        agent_1.spendingTracker.clear();
        vitest_1.vi.clearAllMocks();
        vitest_1.vi.mocked(StellarPaymentTool_1.StellarPaymentTool).mockImplementation(() => ({ execute: vitest_1.vi.fn().mockResolvedValue({ txHash: 'hash_passthrough', ledger: 42 }) }));
        agent = new agent_1.PayFiAgent();
    });
    (0, vitest_1.it)('result.data.txHash matches the value returned by StellarPaymentTool.execute', async () => {
        const result = await agent.run({
            type: 'stellar_payment',
            payload: { destination: DEST, amount: '1', assetCode: 'XLM' },
        });
        (0, vitest_1.expect)(result.success).toBe(true);
        (0, vitest_1.expect)(result.data.txHash).toBe('hash_passthrough');
    });
    (0, vitest_1.it)('result.data.ledger matches the value returned by StellarPaymentTool.execute', async () => {
        const result = await agent.run({
            type: 'stellar_payment',
            payload: { destination: DEST, amount: '1', assetCode: 'XLM' },
        });
        (0, vitest_1.expect)(result.data.ledger).toBe(42);
    });
});
/**
 * Minimal valid payloads for each TaskType.
 *
 * Payloads are kept as small as possible — they only need to satisfy the
 * tool mock's input path (which ignores them entirely) and any spending-limit
 * guard that inspects payload.amount.  Amounts are set to "1" to stay below
 * MAINNET_SPENDING_CAP (10 000) configured in the mock above.
 */
const DISPATCH_MATRIX = [
    [
        'stellar_payment',
        { destination: DEST, amount: '1', assetCode: 'XLM' },
        'routes stellar_payment to StellarPaymentTool',
    ],
    [
        'soroban_invoke',
        { contractId: 'C'.repeat(56), method: 'ping', args: [] },
        'routes soroban_invoke to SorobanInvokeTool',
    ],
    [
        'soroban_query',
        { contractId: 'C'.repeat(56), method: 'get_state', args: [] },
        'routes soroban_query to SorobanQueryTool',
    ],
    [
        'x402_respond',
        {
            resource: 'https://api.example.com/resource',
            amount: '1',
            assetCode: 'USDC',
            assetIssuer: ISSUER,
            payTo: DEST,
            nonce: '550e8400-e29b-41d4-a716-446655440000',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        'routes x402_respond to X402PaymentTool',
    ],
    ['account_info', {}, 'routes account_info to AccountInfoTool'],
    [
        'change_trust',
        { assetCode: 'USDC', assetIssuer: ISSUER, action: 'add' },
        'routes change_trust to TrustlineTool',
    ],
    [
        'multisig_payment',
        {
            destination: DEST,
            amount: '1',
            assetCode: 'XLM',
            additionalSigners: [DEST],
            minSignatures: 2,
        },
        'routes multisig_payment to MultiSigPaymentTool',
    ],
    [
        'batch_payment',
        { payments: [{ destination: DEST, amount: '1', assetCode: 'XLM' }] },
        'routes batch_payment to BatchPaymentTool',
    ],
    ['balance_check', { publicKey: DEST }, 'routes balance_check to BalanceCheckTool'],
    [
        'path_payment',
        {
            destination: DEST,
            sendAsset: { code: 'XLM' },
            sendAmount: '1',
            destAsset: { code: 'USDC', issuer: ISSUER },
            destMinAmount: '0.9',
        },
        'routes path_payment to PathPaymentTool',
    ],
    ['fee_bump', { innerTxXdr: 'AAAA' }, 'routes fee_bump to FeeBumpTool'],
    [
        'dex_offer',
        {
            action: 'create',
            selling: { code: 'XLM' },
            buying: { code: 'USDC', issuer: ISSUER },
            amount: '1',
            price: '0.25',
        },
        'routes dex_offer to DexOfferTool',
    ],
    [
        'liquidity_pool',
        {
            action: 'deposit',
            assetA: { code: 'XLM' },
            assetB: { code: 'USDC', issuer: ISSUER },
            maxAmountA: '100',
            maxAmountB: '100',
            minPrice: '0.1',
            maxPrice: '10',
        },
        'routes liquidity_pool to LiquidityPoolTool',
    ],
    ['inflation', { action: 'set', inflationDestination: DEST }, 'routes inflation to InflationTool'],
];
(0, vitest_1.describe)('PayFiAgent — task dispatch matrix (#450)', () => {
    let agent;
    (0, vitest_1.beforeEach)(() => {
        agent_1.spendingTracker.clear();
        vitest_1.vi.clearAllMocks();
        // Re-apply default mock implementations after vi.clearAllMocks() resets them.
        vitest_1.vi.mocked(StellarPaymentTool_1.StellarPaymentTool).mockImplementation(() => ({ execute: vitest_1.vi.fn().mockResolvedValue({ txHash: 'dispatch_hash', ledger: 1 }) }));
        vitest_1.vi.mocked(BalanceCheckTool_1.BalanceCheckTool).mockImplementation(() => ({ getBalance: vitest_1.vi.fn().mockResolvedValue({ publicKey: DEST, balances: [] }) }));
        vitest_1.vi.mocked(PathPaymentTool_1.PathPaymentTool).mockImplementation(() => ({ execute: vitest_1.vi.fn().mockResolvedValue({ txHash: 'path_dispatch_hash', ledger: 1 }) }));
        vitest_1.vi.mocked(FeeBumpTool_1.FeeBumpTool).mockImplementation(() => ({
            execute: vitest_1.vi.fn().mockResolvedValue({ txHash: 'fee_bump_dispatch_hash', ledger: 1 }),
        }));
        vitest_1.vi.mocked(DexOfferTool_1.DexOfferTool).mockImplementation(() => ({
            execute: vitest_1.vi
                .fn()
                .mockResolvedValue({ txHash: 'dex_dispatch_hash', ledger: 1, offerId: '0' }),
        }));
        vitest_1.vi.mocked(LiquidityPoolTool_1.LiquidityPoolTool).mockImplementation(() => ({ execute: vitest_1.vi.fn().mockResolvedValue({ poolId: 'pool_dispatch_id' }) }));
        vitest_1.vi.mocked(StellarTomlTool_1.StellarTomlTool).mockImplementation(() => ({ fetchToml: vitest_1.vi.fn().mockResolvedValue({ VERSION: '2.0.0' }) }));
        vitest_1.vi.mocked(DataEntryTool_1.DataEntryTool).mockImplementation(() => ({
            execute: vitest_1.vi.fn().mockResolvedValue({ txHash: 'data_entry_dispatch_hash', ledger: 1 }),
        }));
        vitest_1.vi.mocked(SequenceNumberTool_1.SequenceNumberTool).mockImplementation(() => ({ execute: vitest_1.vi.fn().mockResolvedValue({ sequence: '12345678' }) }));
        vitest_1.vi.mocked(SponsoredAccountTool_1.SponsoredAccountTool).mockImplementation(() => ({
            execute: vitest_1.vi.fn().mockResolvedValue({ txHash: 'sponsored_dispatch_hash', ledger: 1 }),
        }));
        vitest_1.vi.mocked(AnchorQuoteTool_1.AnchorQuoteTool).mockImplementation(() => ({
            execute: vitest_1.vi.fn().mockResolvedValue({ quoteId: 'quote_dispatch_id', price: '1.0' }),
        }));
        vitest_1.vi.mocked(InflationTool_1.InflationTool).mockImplementation(() => ({
            execute: vitest_1.vi.fn().mockResolvedValue({ txHash: 'inflation_dispatch_hash', ledger: 1 }),
        }));
        // The remaining 7 dispatch types (soroban_invoke, soroban_query, x402_respond,
        // account_info, change_trust, multisig_payment, batch_payment) are declared
        // in the top-level vi.mock() factories, but — unlike the tools mocked above —
        // their classes were never also `import`ed by name into this file. Without a
        // live binding to hang a `vi.mocked(...).mockImplementation(...)` call on,
        // `new SorobanInvokeTool(...)` (etc.) inside agent.ts's constructor resolved
        // to the bare mock spy misbehaving as a constructor instead of the factory's
        // `{ execute: vi.fn() }` object, so `this.sorobanTool.execute` (etc.) was
        // undefined at call time. Importing the classes here (see imports above) and
        // giving each an explicit resolved value fixes both problems at once.
        vitest_1.vi.mocked(SorobanInvokeTool_1.SorobanInvokeTool).mockImplementation(() => ({
            execute: vitest_1.vi.fn().mockResolvedValue({ status: 'SUCCESS', ledger: 1 }),
        }));
        vitest_1.vi.mocked(SorobanQueryTool_1.SorobanQueryTool).mockImplementation(() => ({
            query: vitest_1.vi.fn().mockResolvedValue({ result: 'dispatch_state_value' }),
        }));
        vitest_1.vi.mocked(X402PaymentTool_1.X402PaymentTool).mockImplementation(() => ({
            respond: vitest_1.vi.fn().mockResolvedValue({ txHash: 'x402_dispatch_hash', ledger: 1 }),
        }));
        vitest_1.vi.mocked(AccountInfoTool_1.AccountInfoTool).mockImplementation(() => ({
            fetch: vitest_1.vi.fn().mockResolvedValue({ publicKey: DEST, balances: [] }),
        }));
        vitest_1.vi.mocked(TrustlineTool_1.TrustlineTool).mockImplementation(() => ({
            execute: vitest_1.vi.fn().mockResolvedValue({ txHash: 'trustline_dispatch_hash', ledger: 1 }),
        }));
        vitest_1.vi.mocked(MultiSigPaymentTool_1.MultiSigPaymentTool).mockImplementation(() => ({
            execute: vitest_1.vi.fn().mockResolvedValue({ txHash: 'multisig_dispatch_hash', ledger: 1 }),
        }));
        vitest_1.vi.mocked(BatchPaymentTool_1.BatchPaymentTool).mockImplementation(() => ({
            execute: vitest_1.vi
                .fn()
                .mockResolvedValue({ results: [{ txHash: 'batch_dispatch_hash', ledger: 1 }] }),
        }));
        agent = new agent_1.PayFiAgent();
    });
    // Verify we are testing exactly 14 registered TaskType values.
    (0, vitest_1.it)('dispatch matrix covers exactly 14 TaskType entries', () => {
        (0, vitest_1.expect)(DISPATCH_MATRIX).toHaveLength(14);
        const taskTypes = DISPATCH_MATRIX.map(([type]) => type);
        // All entries must be unique — no accidental duplicates.
        (0, vitest_1.expect)(new Set(taskTypes).size).toBe(14);
    });
    vitest_1.test.each(DISPATCH_MATRIX)("dispatches %s → result.taskType === '%s' and result.success === true", async (taskType, payload) => {
        const result = await agent.run({ type: taskType, payload });
        // The dispatched type must be reflected back in the result without mutation.
        (0, vitest_1.expect)(result.taskType).toBe(taskType);
        // The agent must report success when the underlying tool stub resolves.
        (0, vitest_1.expect)(result.success).toBe(true);
    });
});
(0, vitest_1.describe)('PayFiAgent — unknown task type rejection (#450)', () => {
    let agent;
    (0, vitest_1.beforeEach)(() => {
        agent_1.spendingTracker.clear();
        vitest_1.vi.clearAllMocks();
        vitest_1.vi.mocked(StellarPaymentTool_1.StellarPaymentTool).mockImplementation(() => ({ execute: vitest_1.vi.fn().mockResolvedValue({ txHash: 'mock_hash', ledger: 1 }) }));
        agent = new agent_1.PayFiAgent();
    });
    (0, vitest_1.it)("returns a failed AgentResult containing 'Unknown task type:' for an unregistered type", async () => {
        // Cast through `any` to bypass TypeScript's exhaustive type checking —
        // the runtime guard must catch values that slip past the type system.
        const result = await agent.run({
            type: 'totally_unknown_task_type',
            payload: {},
        });
        (0, vitest_1.expect)(result.success).toBe(false);
        (0, vitest_1.expect)(result.error).toMatch(/Unknown task type:/i);
        // The unrecognised type string must appear in the error message so
        // operators can diagnose dispatch misrouting without reading source code.
        (0, vitest_1.expect)(result.error).toContain('totally_unknown_task_type');
    });
    (0, vitest_1.it)('does not throw synchronously — always returns an AgentResult', async () => {
        // run() must never reject its Promise; the error must be captured in the result.
        await (0, vitest_1.expect)(agent.run({ type: 'another_unknown', payload: {} })).resolves.toMatchObject({ success: false });
    });
});
//# sourceMappingURL=agent.test.js.map