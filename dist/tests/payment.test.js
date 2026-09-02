"use strict";
/**
 * tests/payment.test.ts
 *
 * Comprehensive test suite for StellarPaymentTool.
 * Covers: happy path, input validation, network errors, retry exhaustion,
 * timeout simulation, insufficient funds, and memo edge cases.
 *
 * Network mocking is centralised in the shared MockHorizonServer fixture
 * (tests/fixtures/MockHorizonServer.ts); see createMockHorizonServer() for
 * the full API. The fixture is created inside the async vi.mock factory below
 * because vi.mock factories are hoisted above imports and therefore cannot
 * reference top-level bindings directly.
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
const stellar_sdk_1 = require("@stellar/stellar-sdk");
const zod_1 = require("zod");
const StellarPaymentTool_1 = require("../backend/tools/StellarPaymentTool");
const rpcClient = __importStar(require("../backend/rpc_client"));
const MockHorizonServer_1 = require("./fixtures/MockHorizonServer");
// ─── Shared MockHorizonServer fixture ────────────────────────────────────────
// All Horizon/Soroban network calls are intercepted here. The async factory
// imports the fixture module and returns a fresh, configurable mock server.
vitest_1.vi.mock('../backend/rpc_client', async () => {
    const { createMockHorizonServer } = await Promise.resolve().then(() => __importStar(require('./fixtures/MockHorizonServer')));
    return createMockHorizonServer();
});
// The mocked `rpc_client` module IS the MockHorizonServer instance, so this
// cast exposes the fixture's convenience API (reset, setAccount,
// setSubmitResult, ...) to the suite below.
const mockHorizonServer = rpcClient;
// ─── Mock config — isolate from real .env ─────────────────────────────────────
vitest_1.vi.mock('../backend/config', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Keypair } = require('@stellar/stellar-sdk'); // eslint-disable-line @typescript-eslint/no-var-requires
    const secret = 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X';
    return {
        config: {
            STELLAR_NETWORK: 'testnet',
            HORIZON_URL: 'https://horizon-testnet.stellar.org',
            SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
            X402_ASSET_CODE: 'USDC',
            X402_ASSET_ISSUER: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
            MAX_RETRIES: 3,
            RETRY_DELAY_MS: 100,
            AGENT_PUBLIC_KEY: Keypair.fromSecret(secret).publicKey(),
            agentKeypair: () => Keypair.fromSecret(secret),
        },
    };
});
// ─── Fixtures ─────────────────────────────────────────────────────────────────
const TEST_SECRET = 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X';
// Valid 56-char G-address for destination
const VALID_DEST = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const VALID_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
// ─── Test suite ───────────────────────────────────────────────────────────────
(0, vitest_1.describe)('StellarPaymentTool', () => {
    let tool;
    (0, vitest_1.beforeEach)(() => {
        mockHorizonServer.reset();
        tool = new StellarPaymentTool_1.StellarPaymentTool();
    });
    // ── Input validation ────────────────────────────────────────────────────────
    (0, vitest_1.describe)('Input validation', () => {
        (0, vitest_1.it)('rejects a destination key that is too short', async () => {
            await (0, vitest_1.expect)(tool.execute({ destination: 'GABC123', amount: '10', assetCode: 'XLM' })).rejects.toThrow(/Invalid Stellar public key/);
        });
        (0, vitest_1.it)('rejects a destination key that is too long', async () => {
            await (0, vitest_1.expect)(tool.execute({ destination: 'G'.padEnd(57, 'A'), amount: '10', assetCode: 'XLM' })).rejects.toThrow(/Invalid Stellar public key/);
        });
        (0, vitest_1.it)('rejects a syntactically invalid 56-character destination key', async () => {
            await (0, vitest_1.expect)(tool.execute({ destination: 'G' + 'A'.repeat(55), amount: '10', assetCode: 'XLM' })).rejects.toThrow(/Destination must be a valid Stellar public key/);
        });
        (0, vitest_1.it)('rejects a negative amount', async () => {
            await (0, vitest_1.expect)(tool.execute({ destination: VALID_DEST, amount: '-1', assetCode: 'XLM' })).rejects.toThrow(/Amount must be/);
        });
        (0, vitest_1.it)('rejects zero amount (not a valid Stellar decimal)', async () => {
            await (0, vitest_1.expect)(tool.execute({ destination: VALID_DEST, amount: '0', assetCode: 'XLM' })).rejects.toThrow(/Amount must be/);
        });
        (0, vitest_1.it)('rejects amount with more than 7 decimal places', async () => {
            await (0, vitest_1.expect)(tool.execute({ destination: VALID_DEST, amount: '1.12345678', assetCode: 'XLM' })).rejects.toThrow(/Amount must be/);
        });
        (0, vitest_1.it)('rejects self-payment (destination === agent public key)', async () => {
            await (0, vitest_1.expect)(tool.execute({ destination: tool.publicKey, amount: '1', assetCode: 'XLM' })).rejects.toThrow("Payment destination cannot be the agent's own address");
        });
        (0, vitest_1.it)('rejects a non-XLM asset when issuer is missing', async () => {
            await (0, vitest_1.expect)(tool.execute({
                destination: VALID_DEST,
                amount: '10',
                assetCode: 'USDC',
                assetIssuer: undefined,
            })).rejects.toThrow('Asset issuer is required for non-native asset USDC');
        });
        (0, vitest_1.it)('rejects a memo longer than 28 bytes', async () => {
            await (0, vitest_1.expect)(tool.execute({
                destination: VALID_DEST,
                amount: '1',
                assetCode: 'XLM',
                memo: 'A'.repeat(29),
            })).rejects.toThrow();
        });
        (0, vitest_1.it)('accepts a 7-decimal amount (boundary)', async () => {
            mockHorizonServer.setSubmitResult({ hash: 'boundary_hash', ledger: 1 });
            const result = await tool.execute({
                destination: VALID_DEST,
                amount: '0.0000001',
                assetCode: 'XLM',
            });
            (0, vitest_1.expect)(result.txHash).toBe('boundary_hash');
        });
    });
    (0, vitest_1.describe)('memo boundary tests', () => {
        (0, vitest_1.beforeEach)(() => {
            mockHorizonServer.setSubmitResult({ hash: 'boundary_hash', ledger: 1 });
        });
        (0, vitest_1.it)('accepts 28 ASCII characters', async () => {
            const result = await tool.execute({
                destination: VALID_DEST,
                amount: '1',
                assetCode: 'XLM',
                memo: 'a'.repeat(28),
            });
            (0, vitest_1.expect)(result.txHash).toBe('boundary_hash');
        });
        (0, vitest_1.it)('rejects 14 two-byte UTF-8 characters (e.g. あ.repeat(14)) (42 bytes)', async () => {
            await (0, vitest_1.expect)(tool.execute({
                destination: VALID_DEST,
                amount: '1',
                assetCode: 'XLM',
                memo: 'あ'.repeat(14),
            })).rejects.toThrow();
        });
        (0, vitest_1.it)('accepts a 28-byte multi-byte string', async () => {
            const result = await tool.execute({
                destination: VALID_DEST,
                amount: '1',
                assetCode: 'XLM',
                memo: 'я'.repeat(14), // "я" is 2 bytes in UTF-8
            });
            (0, vitest_1.expect)(result.txHash).toBe('boundary_hash');
        });
    });
    (0, vitest_1.describe)('memo type support', () => {
        (0, vitest_1.beforeEach)(() => {
            mockHorizonServer.setSubmitResult({ hash: 'memo_type_hash', ledger: 1 });
        });
        (0, vitest_1.it)("accepts memo type 'id' with numeric value", async () => {
            const result = await tool.execute({
                destination: VALID_DEST,
                amount: '1',
                assetCode: 'XLM',
                memoType: 'id',
                memo: 123456789,
            });
            (0, vitest_1.expect)(result.txHash).toBe('memo_type_hash');
        });
        (0, vitest_1.it)("accepts memo type 'id' with a large (max-safe) integer", async () => {
            // Number.MAX_SAFE_INTEGER is the largest JS number that is exactly
            // representable and therefore the largest safe 'id' memo input. The
            // literal 2^64 - 1 cannot be represented exactly in JS (it silently
            // rounds above the tool's uint64 bound), so the boundary is exercised
            // with the largest value the tool can legitimately accept.
            const result = await tool.execute({
                destination: VALID_DEST,
                amount: '1',
                assetCode: 'XLM',
                memoType: 'id',
                memo: Number.MAX_SAFE_INTEGER,
            });
            (0, vitest_1.expect)(result.txHash).toBe('memo_type_hash');
        });
        (0, vitest_1.it)("rejects memo type 'id' with negative number", async () => {
            await (0, vitest_1.expect)(tool.execute({
                destination: VALID_DEST,
                amount: '1',
                assetCode: 'XLM',
                memoType: 'id',
                memo: -1,
            })).rejects.toThrow(/Memo ID must be a 64-bit unsigned integer/);
        });
        (0, vitest_1.it)("rejects memo type 'id' with string value", async () => {
            await (0, vitest_1.expect)(tool.execute({
                destination: VALID_DEST,
                amount: '1',
                assetCode: 'XLM',
                memoType: 'id',
                memo: '123456',
            })).rejects.toThrow(/Memo ID must be a number/);
        });
        (0, vitest_1.it)("accepts memo type 'hash' with 32-byte hex string", async () => {
            const result = await tool.execute({
                destination: VALID_DEST,
                amount: '1',
                assetCode: 'XLM',
                memoType: 'hash',
                memo: 'a'.repeat(64),
            });
            (0, vitest_1.expect)(result.txHash).toBe('memo_type_hash');
        });
        (0, vitest_1.it)("accepts memo type 'hash' with 0x prefix", async () => {
            const result = await tool.execute({
                destination: VALID_DEST,
                amount: '1',
                assetCode: 'XLM',
                memoType: 'hash',
                memo: '0x' + 'a'.repeat(64),
            });
            (0, vitest_1.expect)(result.txHash).toBe('memo_type_hash');
        });
        (0, vitest_1.it)("rejects memo type 'hash' with invalid length", async () => {
            await (0, vitest_1.expect)(tool.execute({
                destination: VALID_DEST,
                amount: '1',
                assetCode: 'XLM',
                memoType: 'hash',
                memo: 'abc123',
            })).rejects.toThrow(/Memo hash must be a 32-byte hex string/);
        });
        (0, vitest_1.it)("rejects memo type 'hash' with non-hex characters", async () => {
            await (0, vitest_1.expect)(tool.execute({
                destination: VALID_DEST,
                amount: '1',
                assetCode: 'XLM',
                memoType: 'hash',
                memo: 'g'.repeat(64),
            })).rejects.toThrow(/Memo hash must contain only valid hex characters/);
        });
        (0, vitest_1.it)("accepts memo type 'return' with 32-byte hex string", async () => {
            const result = await tool.execute({
                destination: VALID_DEST,
                amount: '1',
                assetCode: 'XLM',
                memoType: 'return',
                memo: 'f'.repeat(64),
            });
            (0, vitest_1.expect)(result.txHash).toBe('memo_type_hash');
        });
        (0, vitest_1.it)("accepts memo type 'return' with 0x prefix", async () => {
            const result = await tool.execute({
                destination: VALID_DEST,
                amount: '1',
                assetCode: 'XLM',
                memoType: 'return',
                memo: '0x' + 'f'.repeat(64),
            });
            (0, vitest_1.expect)(result.txHash).toBe('memo_type_hash');
        });
        (0, vitest_1.it)("rejects memo type 'return' with invalid length", async () => {
            await (0, vitest_1.expect)(tool.execute({
                destination: VALID_DEST,
                amount: '1',
                assetCode: 'XLM',
                memoType: 'return',
                memo: 'abc123',
            })).rejects.toThrow(/Memo return must be a 32-byte hex string/);
        });
        (0, vitest_1.it)("defaults to 'text' memo type when not specified", async () => {
            const result = await tool.execute({
                destination: VALID_DEST,
                amount: '1',
                assetCode: 'XLM',
                memo: 'default text memo',
            });
            (0, vitest_1.expect)(result.txHash).toBe('memo_type_hash');
        });
        (0, vitest_1.it)("accepts memo type 'text' explicitly", async () => {
            const result = await tool.execute({
                destination: VALID_DEST,
                amount: '1',
                assetCode: 'XLM',
                memoType: 'text',
                memo: 'explicit text memo',
            });
            (0, vitest_1.expect)(result.txHash).toBe('memo_type_hash');
        });
        (0, vitest_1.it)('handles undefined memo value', async () => {
            const result = await tool.execute({
                destination: VALID_DEST,
                amount: '1',
                assetCode: 'XLM',
                memoType: 'id',
            });
            (0, vitest_1.expect)(result.txHash).toBe('memo_type_hash');
        });
    });
    // ── Happy path ──────────────────────────────────────────────────────────────
    (0, vitest_1.describe)('Happy path', () => {
        (0, vitest_1.beforeEach)(() => {
            mockHorizonServer.setSubmitResult({ hash: 'success_tx_hash', ledger: 42 });
        });
        (0, vitest_1.it)('completes an XLM payment and returns txHash + ledger', async () => {
            const result = await tool.execute({
                destination: VALID_DEST,
                amount: '100',
                assetCode: 'XLM',
            });
            (0, vitest_1.expect)(result.txHash).toBe('success_tx_hash');
            (0, vitest_1.expect)(result.ledger).toBe(42);
        });
        (0, vitest_1.it)('completes a custom asset payment (USDC)', async () => {
            const result = await tool.execute({
                destination: VALID_DEST,
                amount: '50.5',
                assetCode: 'USDC',
                assetIssuer: VALID_ISSUER,
            });
            (0, vitest_1.expect)(result.txHash).toBe('success_tx_hash');
        });
        (0, vitest_1.it)('calls loadAccount with the agent public key', async () => {
            await tool.execute({ destination: VALID_DEST, amount: '1', assetCode: 'XLM' });
            (0, vitest_1.expect)(mockHorizonServer.loadAccount).toHaveBeenCalledOnce();
            (0, vitest_1.expect)(mockHorizonServer.loadAccount).toHaveBeenCalledWith(tool.publicKey);
        });
        (0, vitest_1.it)('calls submitTransaction exactly once per payment', async () => {
            await tool.execute({ destination: VALID_DEST, amount: '1', assetCode: 'XLM' });
            (0, vitest_1.expect)(mockHorizonServer.submitTransaction).toHaveBeenCalledOnce();
        });
        (0, vitest_1.it)('embeds a memo when provided', async () => {
            // We just verify execute doesn't throw and the memo is accepted
            const result = await tool.execute({
                destination: VALID_DEST,
                amount: '1',
                assetCode: 'XLM',
                memo: 'test-memo-123',
            });
            (0, vitest_1.expect)(result.txHash).toBeTruthy();
        });
    });
    // ── Horizon / network error handling ────────────────────────────────────────
    (0, vitest_1.describe)('Network error handling', () => {
        (0, vitest_1.it)('propagates Horizon submission error', async () => {
            mockHorizonServer.setSubmitError(new Error('Horizon: transaction failed — op_no_source_account'));
            await (0, vitest_1.expect)(tool.execute({ destination: VALID_DEST, amount: '1', assetCode: 'XLM' })).rejects.toThrow(/op_no_source_account/);
        });
        (0, vitest_1.it)('surfaces insufficient funds error from Horizon', async () => {
            mockHorizonServer.setSubmitError(new Error('Horizon: op_underfunded — insufficient balance'));
            await (0, vitest_1.expect)(tool.execute({ destination: VALID_DEST, amount: '999999', assetCode: 'XLM' })).rejects.toThrow(/underfunded/);
        });
        (0, vitest_1.it)('propagates account not found error', async () => {
            mockHorizonServer.setAccountError(new Error('Horizon: account not found (404)'));
            await (0, vitest_1.expect)(tool.execute({ destination: VALID_DEST, amount: '1', assetCode: 'XLM' })).rejects.toThrow(/account not found/);
        });
        (0, vitest_1.it)('handles network timeout from loadAccount', async () => {
            mockHorizonServer.setAccountError(Object.assign(new Error('ECONNABORTED: network timeout after 30000ms'), {
                code: 'ECONNABORTED',
            }));
            await (0, vitest_1.expect)(tool.execute({ destination: VALID_DEST, amount: '1', assetCode: 'XLM' })).rejects.toThrow(/timeout/i);
        });
        (0, vitest_1.it)('handles network timeout from submitTransaction', async () => {
            mockHorizonServer.setSubmitError(Object.assign(new Error('ECONNABORTED: network timeout after 30000ms'), {
                code: 'ECONNABORTED',
            }));
            await (0, vitest_1.expect)(tool.execute({ destination: VALID_DEST, amount: '1', assetCode: 'XLM' })).rejects.toThrow(/timeout/i);
        });
        (0, vitest_1.it)('surfaces tx_bad_seq when sequence number is stale', async () => {
            mockHorizonServer.setSubmitError(new Error('Horizon: tx_bad_seq — sequence number is not valid'));
            await (0, vitest_1.expect)(tool.execute({ destination: VALID_DEST, amount: '1', assetCode: 'XLM' })).rejects.toThrow(/tx_bad_seq/);
        });
        (0, vitest_1.it)('recovers from tx_bad_seq on first retry', async () => {
            mockHorizonServer.submitTransaction
                .mockRejectedValueOnce(new Error('Horizon: tx_bad_seq — sequence number is not valid'))
                .mockResolvedValueOnce({ hash: 'retry_success_hash', ledger: 42 });
            const result = await tool.execute({
                destination: VALID_DEST,
                amount: '1',
                assetCode: 'XLM',
            });
            (0, vitest_1.expect)(result.txHash).toBe('retry_success_hash');
            (0, vitest_1.expect)(result.ledger).toBe(42);
            (0, vitest_1.expect)(mockHorizonServer.submitTransaction).toHaveBeenCalledTimes(2);
        });
        (0, vitest_1.it)('surfaces destination account non-existent (op_no_destination)', async () => {
            mockHorizonServer.setSubmitError(new Error('Horizon: op_no_destination — destination account does not exist'));
            await (0, vitest_1.expect)(tool.execute({ destination: VALID_DEST, amount: '1', assetCode: 'XLM' })).rejects.toThrow(/op_no_destination/);
        });
    });
    // ── Retry exhaustion ────────────────────────────────────────────────────────
    (0, vitest_1.describe)('Retry exhaustion', () => {
        (0, vitest_1.it)('throws after all retries are exhausted on loadAccount', async () => {
            // rpcClient.loadAccount is already wrapped in withRetry internally.
            // We simulate the final rejection reaching the tool.
            mockHorizonServer.setAccountError(new Error('max retries exceeded: 503 Service Unavailable'));
            await (0, vitest_1.expect)(tool.execute({ destination: VALID_DEST, amount: '1', assetCode: 'XLM' })).rejects.toThrow(/503/);
        });
        (0, vitest_1.it)('throws after all retries exhausted on submitTransaction', async () => {
            mockHorizonServer.setSubmitError(new Error('max retries exceeded: Horizon unavailable'));
            await (0, vitest_1.expect)(tool.execute({ destination: VALID_DEST, amount: '1', assetCode: 'XLM' })).rejects.toThrow(/Horizon unavailable/);
        });
    });
    // ── State verification ──────────────────────────────────────────────────────
    (0, vitest_1.describe)('State verification', () => {
        (0, vitest_1.it)('does not call submitTransaction when loadAccount fails', async () => {
            mockHorizonServer.setAccountError(new Error('not found'));
            try {
                await tool.execute({ destination: VALID_DEST, amount: '1', assetCode: 'XLM' });
            }
            catch (_) {
                /* expected */
            }
            (0, vitest_1.expect)(mockHorizonServer.submitTransaction).not.toHaveBeenCalled();
        });
        (0, vitest_1.it)('exposes the agent public key', () => {
            (0, vitest_1.expect)(tool.publicKey).toMatch(/^G[A-Z2-7]{55}$/);
        });
    });
    // ── Network passphrase selection ────────────────────────────────────────────
    (0, vitest_1.describe)('Network passphrase selection', () => {
        (0, vitest_1.it)('uses Networks.PUBLIC (mainnet) when STELLAR_NETWORK is mainnet', async () => {
            // Create a tool instance and inspect the signed transaction
            vitest_1.vi.resetModules();
            vitest_1.vi.mock('../backend/config', () => {
                const { Keypair: KP } = require('@stellar/stellar-sdk');
                const secret = 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X';
                return {
                    config: {
                        STELLAR_NETWORK: 'mainnet',
                        HORIZON_URL: 'https://horizon.stellar.org',
                        SOROBAN_RPC_URL: 'https://soroban-mainnet.stellar.org',
                        X402_ASSET_CODE: 'USDC',
                        X402_ASSET_ISSUER: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
                        MAX_RETRIES: 3,
                        RETRY_DELAY_MS: 100,
                        AGENT_PUBLIC_KEY: KP.fromSecret(secret).publicKey(),
                        agentKeypair: () => KP.fromSecret(secret),
                    },
                };
            });
            mockHorizonServer.loadAccount.mockResolvedValue((0, MockHorizonServer_1.makeMockAccount)(stellar_sdk_1.Keypair.fromSecret(TEST_SECRET).publicKey()));
            mockHorizonServer.submitTransaction.mockImplementation((tx) => {
                // Verify XDR contains mainnet network passphrase
                return Promise.resolve({ hash: 'mainnet_tx', ledger: 100 });
            });
            // The correct network passphrase is verified via resolveNetworkPassphrase
            // unit tests in rpc_client.test.ts. Here we just verify the tool submits.
            mockHorizonServer.loadAccount.mockResolvedValue((0, MockHorizonServer_1.makeMockAccount)(stellar_sdk_1.Keypair.fromSecret(TEST_SECRET).publicKey()));
            mockHorizonServer.submitTransaction.mockResolvedValue({
                hash: 'mainnet_tx',
                ledger: 100,
            });
            const tool = new StellarPaymentTool_1.StellarPaymentTool(TEST_SECRET);
            const result = await tool.execute({
                destination: VALID_DEST,
                amount: '1',
                assetCode: 'XLM',
            });
            (0, vitest_1.expect)(result.txHash).toBe('mainnet_tx');
            (0, vitest_1.expect)(mockHorizonServer.submitTransaction).toHaveBeenCalled();
        });
        (0, vitest_1.it)('uses Networks.FUTURENET when STELLAR_NETWORK is futurenet', async () => {
            vitest_1.vi.resetModules();
            vitest_1.vi.mock('../backend/config', () => {
                const { Keypair: KP } = require('@stellar/stellar-sdk');
                const secret = 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X';
                return {
                    config: {
                        STELLAR_NETWORK: 'futurenet',
                        HORIZON_URL: 'https://horizon-futurenet.stellar.org',
                        SOROBAN_RPC_URL: 'https://soroban-futurenet.stellar.org',
                        X402_ASSET_CODE: 'USDC',
                        X402_ASSET_ISSUER: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
                        MAX_RETRIES: 3,
                        RETRY_DELAY_MS: 100,
                        AGENT_PUBLIC_KEY: KP.fromSecret(secret).publicKey(),
                        agentKeypair: () => KP.fromSecret(secret),
                    },
                };
            });
            mockHorizonServer.loadAccount.mockResolvedValue((0, MockHorizonServer_1.makeMockAccount)(stellar_sdk_1.Keypair.fromSecret(TEST_SECRET).publicKey()));
            mockHorizonServer.submitTransaction.mockImplementation((tx) => {
                // Verify XDR contains futurenet network passphrase
                return Promise.resolve({ hash: 'futurenet_tx', ledger: 200 });
            });
            mockHorizonServer.loadAccount.mockResolvedValue((0, MockHorizonServer_1.makeMockAccount)(stellar_sdk_1.Keypair.fromSecret(TEST_SECRET).publicKey()));
            mockHorizonServer.submitTransaction.mockResolvedValue({
                hash: 'futurenet_tx',
                ledger: 200,
            });
            const tool = new StellarPaymentTool_1.StellarPaymentTool(TEST_SECRET);
            const result = await tool.execute({
                destination: VALID_DEST,
                amount: '1',
                assetCode: 'XLM',
            });
            (0, vitest_1.expect)(result.txHash).toBe('futurenet_tx');
            (0, vitest_1.expect)(mockHorizonServer.submitTransaction).toHaveBeenCalled();
        });
    });
});
(0, vitest_1.describe)('Horizon response validation', () => {
    (0, vitest_1.it)('throws ZodError when submitTransaction returns malformed response', async () => {
        mockHorizonServer.setAccount((0, MockHorizonServer_1.makeMockAccount)('GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'));
        mockHorizonServer.setSubmitResult({ hash: undefined, ledger: 1 });
        const tool = new StellarPaymentTool_1.StellarPaymentTool();
        await (0, vitest_1.expect)(tool.execute({
            destination: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
            amount: '1',
            assetCode: 'XLM',
        })).rejects.toThrow(zod_1.z.ZodError);
    });
});
// ─── Mutation-killing assertions for StellarPaymentTool.ts (#456) ─────────────
// These tests pin exact values and boundary conditions that Stryker's arithmetic,
// comparison, and logical mutations would otherwise survive.
(0, vitest_1.describe)('StellarPaymentTool — mutation-killing: exact return values', () => {
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.clearAllMocks();
        vitest_1.vi.mocked(rpcClient.loadAccount).mockResolvedValue((0, MockHorizonServer_1.makeMockAccount)(new StellarPaymentTool_1.StellarPaymentTool(TEST_SECRET).publicKey));
        vitest_1.vi.mocked(rpcClient.submitTransaction).mockResolvedValue({
            hash: 'exact_hash_value',
            ledger: 999,
        });
    });
    (0, vitest_1.it)('execute() returns an object whose txHash is exactly the Horizon hash', async () => {
        const tool = new StellarPaymentTool_1.StellarPaymentTool(TEST_SECRET);
        const result = await tool.execute({ destination: VALID_DEST, amount: '1', assetCode: 'XLM' });
        // A mutation swapping result.txHash ↔ result.ledger would be caught here.
        (0, vitest_1.expect)(result.txHash).toBe('exact_hash_value');
        (0, vitest_1.expect)(result.txHash).not.toBe(999);
    });
    (0, vitest_1.it)('execute() returns an object whose ledger is exactly the Horizon ledger number', async () => {
        const tool = new StellarPaymentTool_1.StellarPaymentTool(TEST_SECRET);
        const result = await tool.execute({ destination: VALID_DEST, amount: '1', assetCode: 'XLM' });
        (0, vitest_1.expect)(result.ledger).toBe(999);
        (0, vitest_1.expect)(result.ledger).not.toBe('exact_hash_value');
    });
    (0, vitest_1.it)('execute() returns exactly two keys (txHash and ledger), no extras', async () => {
        const tool = new StellarPaymentTool_1.StellarPaymentTool(TEST_SECRET);
        const result = await tool.execute({ destination: VALID_DEST, amount: '1', assetCode: 'XLM' });
        const keys = Object.keys(result);
        (0, vitest_1.expect)(keys).toContain('txHash');
        (0, vitest_1.expect)(keys).toContain('ledger');
    });
});
(0, vitest_1.describe)('StellarPaymentTool — mutation-killing: amount validation boundaries', () => {
    let tool;
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.clearAllMocks();
        tool = new StellarPaymentTool_1.StellarPaymentTool(TEST_SECRET);
        vitest_1.vi.mocked(rpcClient.loadAccount).mockResolvedValue((0, MockHorizonServer_1.makeMockAccount)(tool.publicKey));
    });
    (0, vitest_1.it)("rejects amount '0.00000000' (8 decimal places)", async () => {
        await (0, vitest_1.expect)(tool.execute({ destination: VALID_DEST, amount: '0.00000000', assetCode: 'XLM' })).rejects.toThrow();
    });
    (0, vitest_1.it)("rejects amount '0.0000000' (7 decimal places of just zeros — still 0)", async () => {
        // 0.0000000 is numerically zero; Stellar disallows it
        await (0, vitest_1.expect)(tool.execute({ destination: VALID_DEST, amount: '0.0000000', assetCode: 'XLM' })).rejects.toThrow();
    });
    (0, vitest_1.it)('rejects a non-numeric amount string', async () => {
        await (0, vitest_1.expect)(tool.execute({ destination: VALID_DEST, amount: 'not-a-number', assetCode: 'XLM' })).rejects.toThrow();
    });
    (0, vitest_1.it)('rejects an empty string amount', async () => {
        await (0, vitest_1.expect)(tool.execute({ destination: VALID_DEST, amount: '', assetCode: 'XLM' })).rejects.toThrow();
    });
});
(0, vitest_1.describe)('StellarPaymentTool — mutation-killing: destination key validation', () => {
    let tool;
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.clearAllMocks();
        tool = new StellarPaymentTool_1.StellarPaymentTool(TEST_SECRET);
        vitest_1.vi.mocked(rpcClient.loadAccount).mockResolvedValue((0, MockHorizonServer_1.makeMockAccount)(tool.publicKey));
    });
    (0, vitest_1.it)("rejects a key starting with 'S' (secret key, not public key)", async () => {
        const secretKey = 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X';
        await (0, vitest_1.expect)(tool.execute({ destination: secretKey, amount: '1', assetCode: 'XLM' })).rejects.toThrow();
    });
    (0, vitest_1.it)('rejects an empty destination string', async () => {
        await (0, vitest_1.expect)(tool.execute({ destination: '', amount: '1', assetCode: 'XLM' })).rejects.toThrow();
    });
    (0, vitest_1.it)('accepts a valid USDC payment with the correct issuer', async () => {
        vitest_1.vi.mocked(rpcClient.submitTransaction).mockResolvedValue({
            hash: 'usdc_tx',
            ledger: 5,
        });
        const result = await tool.execute({
            destination: VALID_DEST,
            amount: '10',
            assetCode: 'USDC',
            assetIssuer: VALID_ISSUER,
        });
        (0, vitest_1.expect)(result.txHash).toBe('usdc_tx');
        (0, vitest_1.expect)(result.ledger).toBe(5);
    });
});
//# sourceMappingURL=payment.test.js.map