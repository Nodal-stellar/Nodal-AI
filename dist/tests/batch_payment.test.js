"use strict";
/**
 * tests/batch_payment.test.ts
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
const zod_1 = require("zod");
const BatchPaymentTool_1 = require("../backend/tools/BatchPaymentTool");
const rpcClient = __importStar(require("../backend/rpc_client"));
const config_1 = require("../backend/config");
vitest_1.vi.mock('../backend/rpc_client', () => ({
    loadAccount: vitest_1.vi.fn(),
    submitTransaction: vitest_1.vi.fn(),
    horizonServer: {},
    sorobanServer: {},
    simulateSorobanTx: vitest_1.vi.fn(),
    prepareSorobanTx: vitest_1.vi.fn(),
    resolveNetworkPassphrase: (network) => 
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    require('@stellar/stellar-sdk').Networks[network === 'mainnet' ? 'PUBLIC' : network === 'futurenet' ? 'FUTURENET' : 'TESTNET'],
}));
vitest_1.vi.mock('../backend/config', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { Keypair } = require('@stellar/stellar-sdk');
    const secret = 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X';
    return {
        config: {
            STELLAR_NETWORK: 'testnet',
            HORIZON_URL: 'https://horizon-testnet.stellar.org',
            SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
            X402_ASSET_CODE: 'USDC',
            X402_ASSET_ISSUER: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
            AGENT_SPENDING_LIMIT: '1000',
            AGENT_PUBLIC_KEY: Keypair.fromSecret(secret).publicKey(),
            agentKeypair: () => Keypair.fromSecret(secret),
        },
    };
});
vitest_1.vi.mock('../backend/persistence', () => ({ saveResult: vitest_1.vi.fn() }));
const DEST1 = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const DEST2 = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const DEST3 = 'GDRIFTCEWUMA5IM6NUQPLA27YPHDMUNMPDXCQWCD3BRPVKMPX5KEM5F5';
function makeMockAccount(publicKey) {
    return {
        id: publicKey,
        accountId: () => publicKey,
        sequenceNumber: () => '100',
        incrementSequenceNumber: vitest_1.vi.fn(),
        sequence: '100',
        incrementedSequenceNumber: () => '101',
        thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
        flags: { auth_required: false, auth_revocable: false, auth_immutable: false },
        balances: [{ asset_type: 'native', balance: '10000.0000000' }],
        signers: [],
        data_attr: {},
        subentry_count: 0,
        home_domain: '',
        inflation_dest: null,
    };
}
(0, vitest_1.describe)('BatchPaymentTool', () => {
    let tool;
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.clearAllMocks();
        tool = new BatchPaymentTool_1.BatchPaymentTool();
        vitest_1.vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount('GDRIFTCEWUMA5IM6NUQPLA27YPHDMUNMPDXCQWCD3BRPVKMPX5KEM5F5'));
        vitest_1.vi.mocked(rpcClient.submitTransaction).mockResolvedValue({
            hash: 'batch_tx_hash',
            ledger: 55,
        });
    });
    (0, vitest_1.it)('executes a 3-payment batch and returns txHash + ledger', async () => {
        const result = await tool.execute({
            payments: [
                { destination: DEST1, amount: '10', assetCode: 'XLM' },
                { destination: DEST2, amount: '20', assetCode: 'XLM' },
                { destination: DEST3, amount: '30', assetCode: 'XLM' },
            ],
        });
        (0, vitest_1.expect)(result.txHash).toBe('batch_tx_hash');
        (0, vitest_1.expect)(result.ledger).toBe(55);
        (0, vitest_1.expect)(rpcClient.submitTransaction).toHaveBeenCalledOnce();
    });
    (0, vitest_1.it)('rejects a batch with more than 100 payments', async () => {
        const payments = Array.from({ length: 101 }, (_, i) => ({
            destination: DEST1,
            amount: '1',
            assetCode: 'XLM',
        }));
        await (0, vitest_1.expect)(tool.execute({ payments })).rejects.toThrow();
    });
    (0, vitest_1.it)('rejects when the aggregate total exceeds AGENT_SPENDING_LIMIT', async () => {
        // AGENT_SPENDING_LIMIT is 1000; 3 × 400 = 1200
        await (0, vitest_1.expect)(tool.execute({
            payments: [
                { destination: DEST1, amount: '400', assetCode: 'XLM' },
                { destination: DEST2, amount: '400', assetCode: 'XLM' },
                { destination: DEST3, amount: '400', assetCode: 'XLM' },
            ],
        })).rejects.toThrow(/AGENT_SPENDING_LIMIT/);
    });
    (0, vitest_1.it)('rejects a batch where total exceeds AGENT_SPENDING_LIMIT', async () => {
        // AGENT_SPENDING_LIMIT is 1000; 2 × 600 = 1200 > 1000
        const payments = [
            { destination: DEST1, amount: '600', assetCode: 'XLM' },
            { destination: DEST2, amount: '600', assetCode: 'XLM' },
        ];
        await (0, vitest_1.expect)(tool.execute({ payments })).rejects.toThrow(/exceeds AGENT_SPENDING_LIMIT/);
    });
    (0, vitest_1.it)('accepts a batch where the total exactly equals the spending limit', async () => {
        // 100 × 10 = 1000, which equals the limit
        const payments = Array.from({ length: 100 }, () => ({
            destination: DEST1,
            amount: '10',
            assetCode: 'XLM',
        }));
        const result = await tool.execute({ payments });
        (0, vitest_1.expect)(result.txHash).toBe('batch_tx_hash');
    });
    (0, vitest_1.it)('rejects an empty payments array', async () => {
        await (0, vitest_1.expect)(tool.execute({ payments: [] })).rejects.toThrow();
    });
    (0, vitest_1.it)('rejects a non-XLM payment missing assetIssuer', async () => {
        await (0, vitest_1.expect)(tool.execute({
            payments: [{ destination: DEST1, amount: '10', assetCode: 'USDC' }],
        })).rejects.toThrow(/Asset issuer is required/);
    });
    (0, vitest_1.describe)('failFast', () => {
        const BAD = { destination: DEST2, amount: '10', assetCode: 'USDC' };
        const GOOD1 = { destination: DEST1, amount: '10', assetCode: 'XLM' };
        const GOOD2 = { destination: DEST3, amount: '10', assetCode: 'XLM' };
        (0, vitest_1.it)('defaults to false and reports every unusable payment at once', async () => {
            await (0, vitest_1.expect)(tool.execute({
                payments: [GOOD1, BAD, { ...BAD, assetCode: 'EURC' }],
            })).rejects.toThrow(/USDC[\s\S]*EURC/);
        });
        (0, vitest_1.it)('reports nothing skipped when it checked the whole batch', async () => {
            await tool.execute({ payments: [GOOD1, BAD, GOOD2] }).catch((err) => {
                (0, vitest_1.expect)(err.skipped).toBe(0);
            });
            vitest_1.expect.assertions(1);
        });
        (0, vitest_1.it)('stops at the first unusable payment when failFast is set', async () => {
            await (0, vitest_1.expect)(tool.execute({
                payments: [GOOD1, BAD, { ...BAD, assetCode: 'EURC' }],
                failFast: true,
            })).rejects.toThrow(/payment 1[\s\S]*USDC/);
        });
        (0, vitest_1.it)('counts the payments behind the failure as skipped', async () => {
            await tool
                .execute({ payments: [GOOD1, BAD, GOOD2, GOOD2], failFast: true })
                .catch((err) => {
                // index 1 failed, so indexes 2 and 3 were never looked at
                (0, vitest_1.expect)(err.skipped).toBe(2);
            });
            vitest_1.expect.assertions(1);
        });
        (0, vitest_1.it)('does not reach the network when a batch fails pre-flight', async () => {
            await (0, vitest_1.expect)(tool.execute({ payments: [BAD], failFast: true })).rejects.toThrow();
            (0, vitest_1.expect)(rpcClient.loadAccount).not.toHaveBeenCalled();
            (0, vitest_1.expect)(rpcClient.submitTransaction).not.toHaveBeenCalled();
        });
        (0, vitest_1.it)('submits normally with failFast set when every payment is usable', async () => {
            const result = await tool.execute({
                payments: [GOOD1, GOOD2],
                failFast: true,
            });
            (0, vitest_1.expect)(result.txHash).toBe('batch_tx_hash');
            (0, vitest_1.expect)(result.skipped).toBe(0);
            (0, vitest_1.expect)(rpcClient.submitTransaction).toHaveBeenCalledOnce();
        });
        (0, vitest_1.it)('reports skipped as 0 on a successful batch', async () => {
            const result = await tool.execute({ payments: [GOOD1, GOOD2] });
            (0, vitest_1.expect)(result.skipped).toBe(0);
        });
    });
    // #451 — boundary tests for the 100-payment ceiling and the aggregate
    // spending limit, plus a basic throughput check.
    (0, vitest_1.describe)('100-payment boundary and aggregate spend limit', () => {
        (0, vitest_1.it)('accepts exactly 100 payments and completes well under a second', async () => {
            const payments = Array.from({ length: 100 }, () => ({
                destination: DEST1,
                amount: '0.01',
                assetCode: 'XLM',
            }));
            const start = Date.now();
            const result = await tool.execute({ payments });
            const elapsedMs = Date.now() - start;
            (0, vitest_1.expect)(result.txHash).toBe('batch_tx_hash');
            (0, vitest_1.expect)(rpcClient.submitTransaction).toHaveBeenCalledOnce();
            // Fully mocked network calls — this is a smoke check that the 100-item
            // pre-flight loop has no accidental O(n^2) or leak-shaped slowdown.
            (0, vitest_1.expect)(elapsedMs).toBeLessThan(1000);
        });
        (0, vitest_1.it)('rejects 101 payments before ever touching the network', async () => {
            const payments = Array.from({ length: 101 }, () => ({
                destination: DEST1,
                amount: '0.01',
                assetCode: 'XLM',
            }));
            // Enforced by BatchPaymentInputSchema's `.max(100)` via Zod's own
            // .parse(), so the tool throws the raw ZodError rather than wrapping it
            // in the project's ValidationError — asserting the real thrown type.
            await (0, vitest_1.expect)(tool.execute({ payments })).rejects.toThrow(zod_1.ZodError);
            (0, vitest_1.expect)(rpcClient.loadAccount).not.toHaveBeenCalled();
            (0, vitest_1.expect)(rpcClient.submitTransaction).not.toHaveBeenCalled();
        });
        (0, vitest_1.it)('rejects 100 payments of 0.11 XLM against a tightened AGENT_SPENDING_LIMIT of 10', async () => {
            // 100 × 0.11 = 11, which exceeds a limit of 10. Mutates the shared
            // mocked config for this one test and restores it, since every other
            // test in this file relies on the default limit of 1000.
            const original = config_1.config.AGENT_SPENDING_LIMIT;
            config_1.config.AGENT_SPENDING_LIMIT = '10';
            try {
                const payments = Array.from({ length: 100 }, () => ({
                    destination: DEST1,
                    amount: '0.11',
                    assetCode: 'XLM',
                }));
                await (0, vitest_1.expect)(tool.execute({ payments })).rejects.toThrow(/AGENT_SPENDING_LIMIT/);
                (0, vitest_1.expect)(rpcClient.submitTransaction).not.toHaveBeenCalled();
            }
            finally {
                config_1.config.AGENT_SPENDING_LIMIT = original;
            }
        });
    });
});
//# sourceMappingURL=batch_payment.test.js.map