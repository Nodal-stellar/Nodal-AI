"use strict";
/**
 * tests/soroban_invoke.test.ts
 *
 * Comprehensive test suite for SorobanInvokeTool.
 * Covers: simulation gate, happy path, ERROR/FAILED status handling,
 * polling timeout, invalid inputs, and dry-run mode.
 *
 * ## Mock Architecture
 *
 * This suite uses vi.mock() at the module level to mock two critical dependencies:
 *
 * 1. **rpcClient**: The RPC abstraction layer that communicates with Horizon and Soroban.
 *    - Allows us to test SorobanInvokeTool in complete isolation from network calls.
 *    - Each test configures the mock's return values to simulate different network scenarios
 *      (SUCCESS, FAILED, NOT_FOUND, ERROR statuses, timeouts, etc.).
 *    - The mock is cleared before each test via vi.clearAllMocks() (from vitest.config.ts).
 *
 * 2. **config**: The environment configuration (network URLs, agent keypair, thresholds).
 *    - Mocked to return predictable, test-friendly values.
 *    - Prevents the test from requiring actual environment variables or .env files.
 *
 * ## Why isolate: true Matters Here
 *
 * With vitest.config.ts set to isolate: true, each test file gets its own V8 context:
 * - Mock definitions (vi.mock()) apply only to this test file.
 * - Other test files can mock the same modules differently without interference.
 * - Global state (vi.clearAllMocks(), test instance) is not shared between files.
 *
 * Example: If balance_check.test.ts also mocks rpcClient, it won't affect this file's mocks.
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
const SorobanInvokeTool_1 = require("../backend/tools/SorobanInvokeTool");
const rpcClient = __importStar(require("../backend/rpc_client"));
const errors_1 = require("../backend/errors");
const spending_tracker_1 = require("../backend/spending_tracker");
// ─── Shared fixture (#438) ────────────────────────────────────────────────────
/**
 * Mock the rpc_client module with the shared MockSorobanServer fixture
 * (tests/fixtures/MockSorobanServer.ts) instead of a hand-rolled inline
 * factory. The mocked module IS the fixture instance, so the cast below
 * exposes its scenario configurators (failSimulation, submitResult,
 * stallPolling, signNoOp, ...) to the suite.
 */
vitest_1.vi.mock('../backend/rpc_client', async () => {
    const { createMockSorobanServer } = await Promise.resolve().then(() => __importStar(require('./fixtures/MockSorobanServer')));
    return createMockSorobanServer();
});
// The mocked `rpc_client` module IS the MockSorobanServer instance, so this
// cast exposes the fixture's convenience API (reset, setPrepared, ...) to the
// suite below — matching the pattern in tests/payment.test.ts.
const mockSorobanServer = rpcClient;
// The tool records simulated SAC transfers into the shared spending window.
// Mock the singleton so assertions stay in-process and no real DB is touched.
vitest_1.vi.mock('../backend/spending_tracker', () => ({
    spendingTracker: {
        record: vitest_1.vi.fn(),
        total: vitest_1.vi.fn(() => 0),
        clear: vitest_1.vi.fn(),
    },
}));
vitest_1.vi.mock('../backend/logger', () => ({
    logger: { info: vitest_1.vi.fn(), warn: vitest_1.vi.fn(), error: vitest_1.vi.fn(), debug: vitest_1.vi.fn() },
}));
vitest_1.vi.mock('../backend/utils/logger', () => ({
    createLogger: vitest_1.vi.fn(() => ({ info: vitest_1.vi.fn(), warn: vitest_1.vi.fn(), error: vitest_1.vi.fn(), debug: vitest_1.vi.fn() })),
    generateCorrelationId: vitest_1.vi.fn(() => 'mock-correlation-id'),
}));
/**
 * Mock the config module to provide a predictable environment.
 *
 * In real use, config.ts reads from process.env or .env files.
 * Here, we statically return test credentials and thresholds.
 *
 * Note: The AGENT_SECRET_KEY is a Stellar secret key used in tests only.
 * It is never used in actual signed transactions in this test suite
 * because all RPC calls are mocked.
 */
// Mutable knobs for the spending-limit tests: the tool reads these at call
// time, so expose them as getters over a hoisted state object.
const { configState } = vitest_1.vi.hoisted(() => ({
    configState: { STELLAR_NETWORK: 'testnet', AGENT_SPENDING_LIMIT: '100' },
}));
vitest_1.vi.mock('../backend/config', () => {
    const { Keypair } = require('@stellar/stellar-sdk'); // eslint-disable-line @typescript-eslint/no-var-requires
    const secret = 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X';
    return {
        config: {
            get STELLAR_NETWORK() {
                return configState.STELLAR_NETWORK;
            },
            HORIZON_URL: 'https://horizon-testnet.stellar.org',
            SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
            AGENT_SECRET_KEY: secret,
            AGENT_PUBLIC_KEY: Keypair.fromSecret(secret).publicKey(),
            agentKeypair: () => Keypair.fromSecret(secret),
            X402_ASSET_CODE: 'USDC',
            X402_ASSET_ISSUER: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
            get AGENT_SPENDING_LIMIT() {
                return configState.AGENT_SPENDING_LIMIT;
            },
            MAX_RETRIES: 3,
            RETRY_DELAY_MS: 100,
            MAX_X402_PAYMENTS_PER_MINUTE: 10,
            MAX_SOROBAN_FEE_STROOPS: 1_000_000,
        },
        MAINNET_SPENDING_CAP: 10_000,
    };
});
// ─── Fixtures ─────────────────────────────────────────────────────────────────
/**
 * Test fixtures: reusable constants and helper functions.
 */
const TEST_SECRET = 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X';
const VALID_CONTRACT = 'CDPVBHPSVYKWSI5ECEA4DASBG3RBNU5EHEE3DHNFX7RMBCZV66CSC7NH';
/**
 * makeMockAccount(publicKey): Constructs a mock Stellar account object.
 *
 * SorobanInvokeTool calls rpcClient.loadAccount() to fetch the agent's
 * current account details from Horizon. This mock account satisfies
 * that interface without hitting the network.
 *
 * Fields like sequenceNumber, thresholds, and signers are required
 * by the Stellar SDK's transaction building logic.
 */
function makeMockAccount(publicKey) {
    return {
        id: publicKey,
        accountId: () => publicKey,
        sequenceNumber: () => '100',
        incrementSequenceNumber: vitest_1.vi.fn(),
        sequence: '100',
        incrementedSequenceNumber: () => '101',
        thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
        flags: {
            auth_required: false,
            auth_revocable: false,
            auth_immutable: false,
        },
        balances: [],
        signers: [],
        data_attr: {},
        subentry_count: 0,
    };
}
/**
 * Creates a mock prepared transaction that satisfies the post-sign signature guard.
 * sign() mutates `signatures` in place (matching real Stellar SDK behaviour).
 */
function makeMockPreparedTx(fee = 500_000) {
    const obj = { signatures: [], fee, timeBounds: {} };
    obj.sign = vitest_1.vi.fn().mockImplementation(() => {
        obj.signatures.push({ hint: () => Buffer.alloc(4), signature: () => Buffer.alloc(64) });
    });
    return obj;
}
/**
 * Build a real `xdr.DiagnosticEvent` shaped like a Stellar Asset Contract
 * value-out event (transfer / transfer_from / burn) so the tool's simulated-
 * event extraction is exercised against genuine XDR.
 *
 * Topic layout mirrors the SAC token interface:
 * - transfer:       [Symbol("transfer"), from, to]
 * - transfer_from:  [Symbol("transfer_from"), from, to, spender]
 * - burn:           [Symbol("burn"), from]
 * with the amount as an i128 in the event data.
 */
function makeSacTransferEvent(opts) {
    const topics = [(0, stellar_sdk_1.nativeToScVal)(opts.name, { type: 'symbol' })];
    topics.push((0, stellar_sdk_1.nativeToScVal)(opts.from, { type: 'address' }));
    if (opts.to)
        topics.push((0, stellar_sdk_1.nativeToScVal)(opts.to, { type: 'address' }));
    if (opts.spender)
        topics.push((0, stellar_sdk_1.nativeToScVal)(opts.spender, { type: 'address' }));
    const v0 = new stellar_sdk_1.xdr.ContractEventV0({
        topics,
        data: (0, stellar_sdk_1.nativeToScVal)(opts.amount, { type: 'i128' }),
    });
    // js-xdr unions have no typed constructor in the shipped .d.ts, so the
    // (switchValue, armValue) constructor needs an explicit cast.
    const BodyCtor = stellar_sdk_1.xdr.ContractEventBody;
    const ExtCtor = stellar_sdk_1.xdr.ExtensionPoint;
    const contractEvent = new stellar_sdk_1.xdr.ContractEvent({
        ext: new ExtCtor(0),
        contractId: Buffer.alloc(32),
        type: stellar_sdk_1.xdr.ContractEventType.diagnostic(),
        body: new BodyCtor(0, v0),
    });
    return new stellar_sdk_1.xdr.DiagnosticEvent({
        inSuccessfulContractCall: opts.successful ?? true,
        event: contractEvent,
    });
}
/** Mock the simulation gate to return a prepared tx plus the given events. */
function mockPreparedWithEvents(events = []) {
    mockSorobanServer.setPrepared({ tx: makeMockPreparedTx(), events });
}
// ─── Tests ────────────────────────────────────────────────────────────────────
(0, vitest_1.describe)('SorobanInvokeTool', () => {
    let tool;
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.clearAllMocks();
        tool = new SorobanInvokeTool_1.SorobanInvokeTool();
    });
    // ── Timeout constant validation ────────────────────────────────────────────
    (0, vitest_1.it)('SOROBAN_TX_TIMEOUT is within valid range [1, 300]', () => {
        (0, vitest_1.expect)(SorobanInvokeTool_1.SOROBAN_TX_TIMEOUT).toBeGreaterThan(0);
        (0, vitest_1.expect)(SorobanInvokeTool_1.SOROBAN_TX_TIMEOUT).toBeLessThanOrEqual(300);
    });
    // ── Input validation ────────────────────────────────────────────────────────
    /**
     * Input validation tests: ensure SorobanInvokeTool rejects malformed inputs
     * before any network call is attempted.
     *
     * These are fast unit tests that don't need mocked RPC calls since they
     * reject at the parameter validation layer.
     */
    (0, vitest_1.describe)('Input validation', () => {
        (0, vitest_1.it)('rejects a contractId that is too short', async () => {
            await (0, vitest_1.expect)(tool.execute({ contractId: 'bad_id', method: 'release', args: [] })).rejects.toThrow(/Invalid Stellar contract ID/);
        });
        (0, vitest_1.it)('rejects a contractId that is too long (57 chars)', async () => {
            await (0, vitest_1.expect)(tool.execute({
                contractId: 'C'.padEnd(57, 'A'),
                method: 'release',
                args: [],
            })).rejects.toThrow(/Invalid Stellar contract ID/);
        });
        (0, vitest_1.it)('rejects an empty method name', async () => {
            await (0, vitest_1.expect)(tool.execute({ contractId: VALID_CONTRACT, method: '', args: [] })).rejects.toThrow();
        });
        (0, vitest_1.it)('rejects missing contractId', async () => {
            await (0, vitest_1.expect)(tool.execute({ method: 'release', args: [] })).rejects.toThrow();
        });
    });
    // ── Simulation gate (mandatory) ─────────────────────────────────────────────
    /**
     * Simulation gate tests: the core safety mechanism of SorobanInvokeTool.
     *
     * Every Soroban invocation must first run through prepareSorobanTx(), which
     * performs a dry-run simulation on the Soroban RPC server. Only if the
     * simulation succeeds (no errors) does the transaction proceed to broadcast.
     *
     * This prevents:
     * - Submitting transactions that will fail on-chain (wasting fees).
     * - Executing unauthorized contract calls or insufficient balance scenarios.
     * - Introducing bad state in the contract due to failed side effects.
     *
     * Tests here verify:
     * 1. prepareSorobanTx is ALWAYS called before submission.
     * 2. If simulation fails, submission is SKIPPED and an error is thrown.
     * 3. Dry-run mode (simulateOnly=true) runs the simulation but skips broadcast.
     */
    (0, vitest_1.describe)('Simulation gate', () => {
        (0, vitest_1.beforeEach)(() => {
            vitest_1.vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount('GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'));
        });
        (0, vitest_1.it)('calls prepareSorobanTx before any submission', async () => {
            mockPreparedWithEvents();
            vitest_1.vi.mocked(rpcClient.sorobanServer.sendTransaction).mockResolvedValue({
                status: 'PENDING',
                hash: 'sim_test_hash',
            });
            vitest_1.vi.mocked(rpcClient.sorobanServer.getTransaction).mockResolvedValue({
                status: 'SUCCESS',
            });
            await tool.execute({
                contractId: VALID_CONTRACT,
                method: 'release',
                args: [],
            });
            (0, vitest_1.expect)(rpcClient.prepareSorobanTxWithEvents).toHaveBeenCalledOnce();
        });
        (0, vitest_1.it)('throws and does NOT submit when simulation fails', async () => {
            vitest_1.vi.mocked(rpcClient.prepareSorobanTxWithEvents).mockRejectedValue(new Error('Soroban simulation failed: insufficient balance'));
            await (0, vitest_1.expect)(tool.execute({
                contractId: VALID_CONTRACT,
                method: 'release',
                args: [],
            })).rejects.toThrow(/simulation failed/);
            (0, vitest_1.expect)(rpcClient.sorobanServer.sendTransaction).not.toHaveBeenCalled();
        });
        (0, vitest_1.it)('throws when simulation fails with contract error code', async () => {
            vitest_1.vi.mocked(rpcClient.prepareSorobanTxWithEvents).mockRejectedValue(new Error('Soroban simulation failed: Error(Contract, #3)'));
            await (0, vitest_1.expect)(tool.execute({
                contractId: VALID_CONTRACT,
                method: 'release',
                args: [],
            })).rejects.toThrow(/simulation failed/);
        });
        (0, vitest_1.it)('preserves simulation error detail in ContractError message when simulation fails', async () => {
            const errorDetail = 'HostError: Error(Contract, #123) custom_revert_reason';
            vitest_1.vi.mocked(rpcClient.prepareSorobanTxWithEvents).mockRejectedValue(new errors_1.ContractError(`Soroban simulation failed: ${errorDetail}`, undefined, errorDetail));
            await (0, vitest_1.expect)(tool.execute({
                contractId: VALID_CONTRACT,
                method: 'release',
                args: [],
            })).rejects.toThrow(`Soroban simulation failed: ${errorDetail}`);
        });
        (0, vitest_1.it)('throws when Soroban fee exceeds MAX_SOROBAN_FEE_STROOPS', async () => {
            vitest_1.vi.mocked(rpcClient.prepareSorobanTxWithEvents).mockResolvedValue({
                tx: { sign: vitest_1.vi.fn(), fee: 2_000_000 },
                events: [],
            });
            await (0, vitest_1.expect)(tool.execute({
                contractId: VALID_CONTRACT,
                method: 'release',
                args: [],
            })).rejects.toThrow(/Soroban fee.*exceeds MAX_SOROBAN_FEE_STROOPS/);
            (0, vitest_1.expect)(rpcClient.sorobanServer.sendTransaction).not.toHaveBeenCalled();
        });
        (0, vitest_1.it)('rejects when the prepared fee is not numeric', async () => {
            vitest_1.vi.mocked(rpcClient.prepareSorobanTxWithEvents).mockResolvedValue({
                tx: { sign: vitest_1.vi.fn(), fee: 'not-a-number' },
                events: [],
            });
            await (0, vitest_1.expect)(tool.execute({
                contractId: VALID_CONTRACT,
                method: 'release',
                args: [],
            })).rejects.toThrow(/invalid Soroban fee/i);
            (0, vitest_1.expect)(rpcClient.sorobanServer.sendTransaction).not.toHaveBeenCalled();
        });
        (0, vitest_1.it)('allows execution when Soroban fee is within MAX_SOROBAN_FEE_STROOPS', async () => {
            vitest_1.vi.mocked(rpcClient.prepareSorobanTxWithEvents).mockResolvedValue({
                tx: makeMockPreparedTx(500_000),
                events: [],
            });
            vitest_1.vi.mocked(rpcClient.sorobanServer.sendTransaction).mockResolvedValue({
                status: 'PENDING',
                hash: 'fee_within_cap_hash',
            });
            vitest_1.vi.mocked(rpcClient.sorobanServer.getTransaction).mockResolvedValue({
                status: 'SUCCESS',
            });
            const result = await tool.execute({
                contractId: VALID_CONTRACT,
                method: 'release',
                args: [],
            });
            (0, vitest_1.expect)(result.txHash).toBe('fee_within_cap_hash');
        });
        (0, vitest_1.it)('does NOT call sendTransaction when simulateOnly=true', async () => {
            const mockPreparedTx = { sign: vitest_1.vi.fn() };
            vitest_1.vi.mocked(rpcClient.prepareSorobanTxWithEvents).mockResolvedValue({
                tx: mockPreparedTx,
                events: [],
            });
            const result = await tool.execute({
                contractId: VALID_CONTRACT,
                method: 'release',
                args: [],
                simulateOnly: true,
            });
            (0, vitest_1.expect)(rpcClient.sorobanServer.sendTransaction).not.toHaveBeenCalled();
            // Discriminated union: simulationResult must be present, txHash must be absent
            (0, vitest_1.expect)(result.simulationResult).toBeDefined();
            (0, vitest_1.expect)(result.simulationResult).toBe(mockPreparedTx);
            (0, vitest_1.expect)(result.txHash).toBeUndefined();
        });
    });
    // ── Submission and confirmation polling ─────────────────────────────────────
    /**
     * Submission and confirmation polling tests: verify transaction lifecycle after
     * a successful simulation.
     *
     * After prepareSorobanTx succeeds, the transaction envelope is signed and
     * submitted to sorobanServer.sendTransaction(). The submission returns a
     * PENDING status and a txHash. SorobanInvokeTool then polls sorobanServer.getTransaction()
     * repeatedly until the transaction reaches a terminal state (SUCCESS, FAILED, ERROR).
     *
     * Tests here cover:
     * 1. Happy path: immediate confirmation on the first poll.
     * 2. Retries: transaction confirmed after multiple NOT_FOUND polls.
     * 3. Failure: on-chain FAILED or ERROR statuses are caught and re-thrown.
     * 4. Timeout: polling window exhausted without reaching a terminal state.
     *
     * The polling interval and retry count are defined in config (RETRY_DELAY_MS).
     */
    (0, vitest_1.describe)('Submission and confirmation polling', () => {
        (0, vitest_1.beforeEach)(() => {
            vitest_1.vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount('GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'));
            mockPreparedWithEvents();
        });
        (0, vitest_1.it)('returns txHash after a successful confirmation on first poll', async () => {
            vitest_1.vi.mocked(rpcClient.sorobanServer.sendTransaction).mockResolvedValue({
                status: 'PENDING',
                hash: 'confirmed_hash',
            });
            vitest_1.vi.mocked(rpcClient.sorobanServer.getTransaction).mockResolvedValue({
                status: 'SUCCESS',
            });
            const result = await tool.execute({
                contractId: VALID_CONTRACT,
                method: 'release',
                args: [],
            });
            (0, vitest_1.expect)(result.txHash).toBe('confirmed_hash');
        });
        (0, vitest_1.it)('polls multiple times before SUCCESS', async () => {
            vitest_1.vi.mocked(rpcClient.sorobanServer.sendTransaction).mockResolvedValue({
                status: 'PENDING',
                hash: 'slow_confirm_hash',
            });
            vitest_1.vi.mocked(rpcClient.sorobanServer.getTransaction)
                .mockResolvedValueOnce({ status: 'NOT_FOUND' })
                .mockResolvedValueOnce({ status: 'NOT_FOUND' })
                .mockResolvedValueOnce({ status: 'SUCCESS' });
            const result = await tool.execute({
                contractId: VALID_CONTRACT,
                method: 'release',
                args: [],
            });
            (0, vitest_1.expect)(result.txHash).toBe('slow_confirm_hash');
            (0, vitest_1.expect)(rpcClient.sorobanServer.getTransaction).toHaveBeenCalledTimes(3);
        });
        (0, vitest_1.it)('throws when on-chain status is FAILED', async () => {
            vitest_1.vi.mocked(rpcClient.sorobanServer.sendTransaction).mockResolvedValue({
                status: 'PENDING',
                hash: 'failed_on_chain_hash',
            });
            vitest_1.vi.mocked(rpcClient.sorobanServer.getTransaction).mockResolvedValue({
                status: 'FAILED',
            });
            let error;
            try {
                await tool.execute({
                    contractId: VALID_CONTRACT,
                    method: 'release',
                    args: [],
                });
            }
            catch (e) {
                error = e;
            }
            (0, vitest_1.expect)(error).toBeDefined();
            (0, vitest_1.expect)(error.message).toMatch(/failed on-chain/);
            (0, vitest_1.expect)(error.message).toContain('failed_on_chain_hash');
        });
        (0, vitest_1.it)('throws when sendTransaction returns ERROR status', async () => {
            vitest_1.vi.mocked(rpcClient.sorobanServer.sendTransaction).mockResolvedValue({
                status: 'ERROR',
                errorResult: { toXDR: () => 'base64_error_xdr' },
                hash: 'error_hash',
            });
            await (0, vitest_1.expect)(tool.execute({
                contractId: VALID_CONTRACT,
                method: 'release',
                args: [],
            })).rejects.toThrow(/Soroban submit failed/);
        });
        (0, vitest_1.it)('throws when polling window is exhausted (timeout)', async () => {
            vitest_1.vi.mocked(rpcClient.sorobanServer.sendTransaction).mockResolvedValue({
                status: 'PENDING',
                hash: 'never_confirms_hash',
            });
            // Always return NOT_FOUND — simulates a stalled transaction
            vitest_1.vi.mocked(rpcClient.sorobanServer.getTransaction).mockResolvedValue({
                status: 'NOT_FOUND',
            });
            await (0, vitest_1.expect)(tool.execute({
                contractId: VALID_CONTRACT,
                method: 'release',
                args: [],
            })).rejects.toThrow(/not confirmed within polling window/);
        }, 5_000); // RETRY_DELAY_MS=100 → intervalMs=200ms × 10 attempts ≈ 2s
    });
    // ── Network error handling ──────────────────────────────────────────────────
    /**
     * Network error handling tests: ensure SorobanInvokeTool gracefully surfaces
     * network-level failures.
     *
     * These tests mock network errors (timeouts, 404s) at various points in the
     * call chain (account load, simulation, submission) and verify that they
     * propagate to the caller without being swallowed or retried indefinitely.
     *
     * This is important for user code to distinguish between:
     * - Transient network glitches (worth retrying at the application level).
     * - Permanent errors like "account not found" (require manual intervention).
     */
    (0, vitest_1.describe)('Network error handling', () => {
        (0, vitest_1.beforeEach)(() => {
            vitest_1.vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount('GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'));
        });
        (0, vitest_1.it)('propagates network timeout on prepareSorobanTx', async () => {
            vitest_1.vi.mocked(rpcClient.prepareSorobanTxWithEvents).mockRejectedValue(new Error('ECONNABORTED: network timeout'));
            await (0, vitest_1.expect)(tool.execute({
                contractId: VALID_CONTRACT,
                method: 'release',
                args: [],
            })).rejects.toThrow(/timeout/);
        });
        (0, vitest_1.it)('propagates account load failure', async () => {
            vitest_1.vi.mocked(rpcClient.loadAccount).mockRejectedValue(new Error('Horizon: account not found (404)'));
            await (0, vitest_1.expect)(tool.execute({
                contractId: VALID_CONTRACT,
                method: 'release',
                args: [],
            })).rejects.toThrow(/not found/);
        });
    });
    // ── Signature assertion (issue #99) ────────────────────────────────────────
    /**
     * Post-sign guard: verifies that the transaction has at least one signature
     * before submission. A no-op sign() call (e.g., mutated Keypair behaviour
     * in a future SDK version) would cause an empty signatures array, which the
     * Stellar network rejects immediately. The guard catches this early.
     */
    (0, vitest_1.describe)('Post-sign signature assertion', () => {
        (0, vitest_1.beforeEach)(() => {
            vitest_1.vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount('GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'));
        });
        (0, vitest_1.it)("throws 'Transaction signing produced no signatures' when sign() is a no-op", async () => {
            // Mock prepareSorobanTx to return a transaction whose sign() does nothing,
            // leaving the signatures array empty. timeBounds is set so the time-bounds
            // guard passes and the signature guard fires.
            vitest_1.vi.mocked(rpcClient.prepareSorobanTxWithEvents).mockResolvedValue({
                tx: {
                    sign: vitest_1.vi.fn(), // no-op — does NOT push to signatures
                    signatures: [], // empty signatures list — guard must catch this
                    fee: 500_000,
                    timeBounds: {},
                },
                events: [],
            });
            await (0, vitest_1.expect)(tool.execute({
                contractId: VALID_CONTRACT,
                method: 'release',
                args: [],
            })).rejects.toThrow('Transaction signing produced no signatures');
            // sendTransaction must NOT have been called when signing failed
            (0, vitest_1.expect)(rpcClient.sorobanServer.sendTransaction).not.toHaveBeenCalled();
        });
        (0, vitest_1.it)('submits successfully when sign() populates signatures', async () => {
            // Use makeMockPreparedTx so sign() adds a signature entry
            mockPreparedWithEvents();
            vitest_1.vi.mocked(rpcClient.sorobanServer.sendTransaction).mockResolvedValue({
                status: 'PENDING',
                hash: 'signed_ok_hash',
            });
            vitest_1.vi.mocked(rpcClient.sorobanServer.getTransaction).mockResolvedValue({
                status: 'SUCCESS',
            });
            const result = await tool.execute({
                contractId: VALID_CONTRACT,
                method: 'release',
                args: [],
            });
            (0, vitest_1.expect)(result.txHash).toBe('signed_ok_hash');
        });
    });
    (0, vitest_1.describe)('args validation', () => {
        (0, vitest_1.it)('rejects plain JavaScript object in args array', () => {
            const result = SorobanInvokeTool_1.SorobanInvokeInputSchema.safeParse({
                contractId: VALID_CONTRACT,
                method: 'test',
                args: [{}],
            });
            (0, vitest_1.expect)(result.success).toBe(false);
        });
        (0, vitest_1.it)('accepts xdr.ScVal instance from nativeToScVal', () => {
            const scVal = (0, stellar_sdk_1.nativeToScVal)(42, { type: 'u32' });
            const result = SorobanInvokeTool_1.SorobanInvokeInputSchema.safeParse({
                contractId: VALID_CONTRACT,
                method: 'test',
                args: [scVal],
            });
            (0, vitest_1.expect)(result.success).toBe(true);
            (0, vitest_1.expect)(result.data?.args).toHaveLength(1);
        });
        (0, vitest_1.it)('rejects null args', () => {
            const result = SorobanInvokeTool_1.SorobanInvokeInputSchema.safeParse({
                contractId: VALID_CONTRACT,
                method: 'test',
                args: null,
            });
            (0, vitest_1.expect)(result.success).toBe(false);
        });
        (0, vitest_1.it)('accepts empty args array as default', () => {
            const result = SorobanInvokeTool_1.SorobanInvokeInputSchema.safeParse({
                contractId: VALID_CONTRACT,
                method: 'test',
            });
            (0, vitest_1.expect)(result.success).toBe(true);
            (0, vitest_1.expect)(result.data?.args).toEqual([]);
        });
        (0, vitest_1.it)('accepts multiple xdr.ScVal instances', () => {
            const arg1 = (0, stellar_sdk_1.nativeToScVal)(100n, { type: 'i128' });
            // Use a real 56-char G-address; "GABC" is not a valid Stellar address
            const arg2 = (0, stellar_sdk_1.nativeToScVal)('GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', {
                type: 'address',
            });
            const result = SorobanInvokeTool_1.SorobanInvokeInputSchema.safeParse({
                contractId: VALID_CONTRACT,
                method: 'test',
                args: [arg1, arg2],
            });
            (0, vitest_1.expect)(result.success).toBe(true);
            (0, vitest_1.expect)(result.data?.args).toHaveLength(2);
        });
    });
    // ── Spending-limit guard on simulated internal SAC transfers ─────────────
    /**
     * A contract invocation can move funds internally via the Stellar Asset
     * Contract (transfer / transfer_from / burn). Those moves are only visible
     * after the mandatory simulation, so the spending cap is enforced against
     * the simulated diagnostic events: reject over-limit invocations before
     * broadcast, and record within-limit spends into the cumulative window.
     */
    (0, vitest_1.describe)('Spending-limit guard on simulated SAC transfers', () => {
        // The tool debits `this.keypair.publicKey()`, which derives from the mocked
        // TEST_SECRET — so AGENT must be that derived key, not a literal.
        const AGENT = stellar_sdk_1.Keypair.fromSecret(TEST_SECRET).publicKey();
        const OTHER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
        (0, vitest_1.beforeEach)(() => {
            configState.STELLAR_NETWORK = 'testnet';
            configState.AGENT_SPENDING_LIMIT = '100';
            vitest_1.vi.mocked(rpcClient.loadAccount).mockResolvedValue(makeMockAccount(AGENT));
        });
        (0, vitest_1.it)('rejects and does not broadcast when simulated SAC transfers exceed AGENT_SPENDING_LIMIT', async () => {
            mockPreparedWithEvents([
                // 2,000,000,000 raw units = 200.0000000 > limit 100
                makeSacTransferEvent({ name: 'transfer', from: AGENT, to: OTHER, amount: 2000000000n }),
            ]);
            await (0, vitest_1.expect)(tool.execute({ contractId: VALID_CONTRACT, method: 'release', args: [] })).rejects.toThrow(/exceeds AGENT_SPENDING_LIMIT/);
            (0, vitest_1.expect)(rpcClient.sorobanServer.sendTransaction).not.toHaveBeenCalled();
        });
        (0, vitest_1.it)('sums multiple SAC transfers before applying the limit', async () => {
            mockPreparedWithEvents([
                makeSacTransferEvent({ name: 'transfer', from: AGENT, to: OTHER, amount: 600000000n }), // 60.0000000
                makeSacTransferEvent({
                    name: 'transfer_from',
                    from: AGENT,
                    to: OTHER,
                    spender: OTHER,
                    amount: 500000000n, // 50.0000000 — 60 + 50 = 110 > 100
                }),
            ]);
            await (0, vitest_1.expect)(tool.execute({ contractId: VALID_CONTRACT, method: 'release', args: [] })).rejects.toThrow(/exceeds AGENT_SPENDING_LIMIT/);
        });
        (0, vitest_1.it)('accepts and records to the spending tracker when within the limit', async () => {
            mockPreparedWithEvents([
                makeSacTransferEvent({ name: 'transfer', from: AGENT, to: OTHER, amount: 400000000n }), // 40.0000000
            ]);
            vitest_1.vi.mocked(rpcClient.sorobanServer.sendTransaction).mockResolvedValue({
                status: 'PENDING',
                hash: 'spend_ok_hash',
            });
            vitest_1.vi.mocked(rpcClient.sorobanServer.getTransaction).mockResolvedValue({
                status: 'SUCCESS',
            });
            const result = await tool.execute({
                contractId: VALID_CONTRACT,
                method: 'release',
                args: [],
            });
            (0, vitest_1.expect)(result.txHash).toBe('spend_ok_hash');
            (0, vitest_1.expect)(spending_tracker_1.spendingTracker.record).toHaveBeenCalledWith('40.0000000');
        });
        (0, vitest_1.it)('counts burn events that debit the agent toward the cap', async () => {
            mockPreparedWithEvents([
                makeSacTransferEvent({ name: 'burn', from: AGENT, amount: 400000000n }), // 40.0000000
            ]);
            vitest_1.vi.mocked(rpcClient.sorobanServer.sendTransaction).mockResolvedValue({
                status: 'PENDING',
                hash: 'burn_hash',
            });
            vitest_1.vi.mocked(rpcClient.sorobanServer.getTransaction).mockResolvedValue({
                status: 'SUCCESS',
            });
            const result = await tool.execute({
                contractId: VALID_CONTRACT,
                method: 'release',
                args: [],
            });
            (0, vitest_1.expect)(result.txHash).toBe('burn_hash');
            (0, vitest_1.expect)(spending_tracker_1.spendingTracker.record).toHaveBeenCalledWith('40.0000000');
        });
        (0, vitest_1.it)('ignores events that do not debit the agent (incoming / third-party transfers)', async () => {
            mockPreparedWithEvents([
                // Incoming and third-party transfers must not consume the agent's cap.
                makeSacTransferEvent({ name: 'transfer', from: OTHER, to: AGENT, amount: 9000000000n }),
                makeSacTransferEvent({ name: 'transfer', from: OTHER, to: OTHER, amount: 9000000000n }),
            ]);
            vitest_1.vi.mocked(rpcClient.sorobanServer.sendTransaction).mockResolvedValue({
                status: 'PENDING',
                hash: 'incoming_hash',
            });
            vitest_1.vi.mocked(rpcClient.sorobanServer.getTransaction).mockResolvedValue({
                status: 'SUCCESS',
            });
            const result = await tool.execute({
                contractId: VALID_CONTRACT,
                method: 'release',
                args: [],
            });
            (0, vitest_1.expect)(result.txHash).toBe('incoming_hash');
            (0, vitest_1.expect)(spending_tracker_1.spendingTracker.record).not.toHaveBeenCalled();
        });
        (0, vitest_1.it)('enforces the mainnet spending cap on mainnet', async () => {
            configState.STELLAR_NETWORK = 'mainnet';
            configState.AGENT_SPENDING_LIMIT = '999999'; // only the mainnet cap should trip
            mockPreparedWithEvents([
                // 200,000.0000000 > MAINNET_SPENDING_CAP (10,000)
                makeSacTransferEvent({
                    name: 'transfer',
                    from: AGENT,
                    to: OTHER,
                    amount: 2000000000000n,
                }),
            ]);
            await (0, vitest_1.expect)(tool.execute({ contractId: VALID_CONTRACT, method: 'release', args: [] })).rejects.toThrow(/mainnet spending cap/);
            (0, vitest_1.expect)(rpcClient.sorobanServer.sendTransaction).not.toHaveBeenCalled();
        });
        (0, vitest_1.it)('does not record spending for simulateOnly dry-runs', async () => {
            mockPreparedWithEvents([
                makeSacTransferEvent({ name: 'transfer', from: AGENT, to: OTHER, amount: 400000000n }),
            ]);
            const result = await tool.execute({
                contractId: VALID_CONTRACT,
                method: 'release',
                args: [],
                simulateOnly: true,
            });
            (0, vitest_1.expect)(result.simulationResult).toBeDefined();
            (0, vitest_1.expect)(spending_tracker_1.spendingTracker.record).not.toHaveBeenCalled();
        });
    });
});
//# sourceMappingURL=soroban_invoke.test.js.map