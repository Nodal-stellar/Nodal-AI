"use strict";
/**
 * tests/rpc_client.test.ts
 *
 * Tests for withRetry and DEFAULT_IS_RETRYABLE in backend/rpc_client.ts.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const zod_1 = require("zod");
const rpc_client_1 = require("../backend/rpc_client");
const errors_1 = require("../backend/errors");
const stellar_sdk_1 = require("@stellar/stellar-sdk");
vitest_1.vi.mock('@stellar/stellar-sdk', async (importOriginal) => {
    const mod = (await importOriginal());
    return {
        ...mod,
        rpc: {
            ...mod.rpc,
            assembleTransaction: vitest_1.vi.fn(),
        },
    };
});
vitest_1.vi.mock('../backend/utils/logger', () => {
    // Use a module-level log object that is safe to create inside the factory
    const _log = {
        info: vitest_1.vi.fn(),
        warn: vitest_1.vi.fn(),
        error: vitest_1.vi.fn(),
        debug: vitest_1.vi.fn(),
    };
    // Store on globalThis so beforeEach can clear it
    globalThis.__rpcClientLog = _log;
    return {
        logger: { info: vitest_1.vi.fn(), warn: vitest_1.vi.fn(), error: vitest_1.vi.fn(), debug: vitest_1.vi.fn() },
        createLogger: vitest_1.vi.fn(() => _log),
        generateCorrelationId: vitest_1.vi.fn(() => 'mock-id'),
    };
});
vitest_1.vi.mock('../backend/config', () => {
    const { Keypair } = require('@stellar/stellar-sdk');
    const secret = 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X';
    return {
        config: {
            STELLAR_NETWORK: 'testnet',
            HORIZON_URL: 'https://horizon-testnet.stellar.org',
            SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
            AGENT_SECRET_KEY: secret,
            AGENT_PUBLIC_KEY: Keypair.fromSecret(secret).publicKey(),
            agentKeypair: () => Keypair.fromSecret(secret),
            X402_ASSET_CODE: 'USDC',
            X402_ASSET_ISSUER: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
            MAX_RETRIES: 3,
            RETRY_DELAY_MS: 100,
            RPC_TIMEOUT_MS: 9000,
            ACCOUNT_CACHE_TTL_MS: 30_000,
            MAX_X402_PAYMENTS_PER_MINUTE: 10,
            MAX_SOROBAN_FEE_STROOPS: 1_000_000,
        },
    };
});
(0, vitest_1.beforeEach)(() => {
    const log = globalThis.__rpcClientLog;
    if (log) {
        log.info.mockClear();
        log.warn.mockClear();
        log.error.mockClear();
        log.debug.mockClear();
    }
});
(0, vitest_1.afterEach)(() => {
    vitest_1.vi.useRealTimers();
});
// ─── resolveNetworkPassphrase ─────────────────────────────────────────────────
(0, vitest_1.describe)('resolveNetworkPassphrase', () => {
    (0, vitest_1.it)('returns Networks.PUBLIC for mainnet', () => {
        (0, vitest_1.expect)((0, rpc_client_1.resolveNetworkPassphrase)('mainnet')).toBe(stellar_sdk_1.Networks.PUBLIC);
    });
    (0, vitest_1.it)('returns Networks.TESTNET for testnet', () => {
        (0, vitest_1.expect)((0, rpc_client_1.resolveNetworkPassphrase)('testnet')).toBe(stellar_sdk_1.Networks.TESTNET);
    });
    (0, vitest_1.it)('returns Networks.FUTURENET for futurenet', () => {
        (0, vitest_1.expect)((0, rpc_client_1.resolveNetworkPassphrase)('futurenet')).toBe(stellar_sdk_1.Networks.FUTURENET);
    });
    (0, vitest_1.it)('throws for an unknown network string', () => {
        (0, vitest_1.expect)(() => (0, rpc_client_1.resolveNetworkPassphrase)('unknown')).toThrow('Unsupported network: unknown');
    });
    (0, vitest_1.it)('throws a ConfigError instance for unsupported networks', () => {
        (0, vitest_1.expect)(() => (0, rpc_client_1.resolveNetworkPassphrase)('unsupported')).toThrow(errors_1.ConfigError);
        try {
            (0, rpc_client_1.resolveNetworkPassphrase)('invalid-net');
            vitest_1.expect.unreachable('should have thrown');
        }
        catch (err) {
            (0, vitest_1.expect)(err).toBeInstanceOf(errors_1.ConfigError);
        }
    });
    (0, vitest_1.it)('throws for empty string', () => {
        (0, vitest_1.expect)(() => (0, rpc_client_1.resolveNetworkPassphrase)('')).toThrow('Unsupported network: ');
    });
    (0, vitest_1.it)('throws for undefined cast to string', () => {
        (0, vitest_1.expect)(() => (0, rpc_client_1.resolveNetworkPassphrase)(undefined)).toThrow();
    });
});
// ─── DEFAULT_IS_RETRYABLE ─────────────────────────────────────────────────────
(0, vitest_1.describe)('DEFAULT_IS_RETRYABLE', () => {
    (0, vitest_1.it)('returns false for ZodError', () => {
        (0, vitest_1.expect)((0, rpc_client_1.DEFAULT_IS_RETRYABLE)(new zod_1.ZodError([]))).toBe(false);
    });
    (0, vitest_1.it)('returns false for TypeError', () => {
        (0, vitest_1.expect)((0, rpc_client_1.DEFAULT_IS_RETRYABLE)(new TypeError('bad type'))).toBe(false);
    });
    (0, vitest_1.it)('returns true for a generic Error', () => {
        (0, vitest_1.expect)((0, rpc_client_1.DEFAULT_IS_RETRYABLE)(new Error('503 Service Unavailable'))).toBe(true);
    });
    (0, vitest_1.it)('returns true for a plain string error', () => {
        (0, vitest_1.expect)((0, rpc_client_1.DEFAULT_IS_RETRYABLE)('network failure')).toBe(true);
    });
    (0, vitest_1.it)('returns false for a budget_exceeded simulation error', () => {
        (0, vitest_1.expect)((0, rpc_client_1.DEFAULT_IS_RETRYABLE)(new Error('HostError: budget_exceeded'))).toBe(false);
    });
    (0, vitest_1.it)('returns false for a simulation failed error', () => {
        (0, vitest_1.expect)((0, rpc_client_1.DEFAULT_IS_RETRYABLE)(new Error('Soroban simulation failed: some reason'))).toBe(false);
    });
});
// ─── withRetry ────────────────────────────────────────────────────────────────
(0, vitest_1.describe)('withRetry', () => {
    (0, vitest_1.it)('throws ZodError immediately without retrying', async () => {
        const zodError = zod_1.z.string().safeParse(42).error;
        const fn = vitest_1.vi.fn().mockRejectedValue(zodError);
        await (0, vitest_1.expect)((0, rpc_client_1.withRetry)(fn, 3, 0)).rejects.toBeInstanceOf(zod_1.ZodError);
        // Deterministic failure — must not retry at all
        (0, vitest_1.expect)(fn).toHaveBeenCalledTimes(1);
    });
    (0, vitest_1.it)('throws TypeError immediately without retrying', async () => {
        const fn = vitest_1.vi.fn().mockRejectedValue(new TypeError('cannot read property'));
        await (0, vitest_1.expect)((0, rpc_client_1.withRetry)(fn, 3, 0)).rejects.toBeInstanceOf(TypeError);
        (0, vitest_1.expect)(fn).toHaveBeenCalledTimes(1);
    });
    (0, vitest_1.it)('retries the full MAX_RETRIES times for a transient error (e.g. HTTP 503)', async () => {
        const fn = vitest_1.vi.fn().mockRejectedValue(new Error('503 Service Unavailable'));
        await (0, vitest_1.expect)((0, rpc_client_1.withRetry)(fn, 3, 0)).rejects.toThrow('503');
        (0, vitest_1.expect)(fn).toHaveBeenCalledTimes(3);
    });
    (0, vitest_1.it)('resolves on the first successful attempt without retrying', async () => {
        const fn = vitest_1.vi.fn().mockResolvedValue('ok');
        await (0, vitest_1.expect)((0, rpc_client_1.withRetry)(fn, 3, 0)).resolves.toBe('ok');
        (0, vitest_1.expect)(fn).toHaveBeenCalledTimes(1);
    });
    (0, vitest_1.it)('resolves after a transient failure followed by success', async () => {
        const fn = vitest_1.vi.fn().mockRejectedValueOnce(new Error('transient')).mockResolvedValue('recovered');
        await (0, vitest_1.expect)((0, rpc_client_1.withRetry)(fn, 3, 0)).resolves.toBe('recovered');
        (0, vitest_1.expect)(fn).toHaveBeenCalledTimes(2);
    });
    // ── Exponential back-off timing with fake timers (#58) ──────────────────────
    (0, vitest_1.it)('respects exponential delay progression [1500, 3000, 6000]', async () => {
        vitest_1.vi.useFakeTimers();
        // Mock Math.random to return 0 so jitter (±20%) is eliminated from delays
        const randomSpy = vitest_1.vi.spyOn(Math, 'random').mockReturnValue(0);
        const fn = vitest_1.vi
            .fn()
            .mockRejectedValueOnce(new Error('try1'))
            .mockRejectedValueOnce(new Error('try2'))
            .mockRejectedValueOnce(new Error('try3'))
            .mockResolvedValue('success');
        const promise = (0, rpc_client_1.withRetry)(fn, 4, 1500, rpc_client_1.DEFAULT_IS_RETRYABLE, 30000);
        await vitest_1.vi.advanceTimersByTimeAsync(0); // Initial attempt
        (0, vitest_1.expect)(fn).toHaveBeenCalledTimes(1);
        // Each delay includes ±20% jitter, so advance by delay + 20% ceiling
        await vitest_1.vi.advanceTimersByTimeAsync(1500 * 1.2 + 50); // First retry after ~1500ms
        (0, vitest_1.expect)(fn).toHaveBeenCalledTimes(2);
        await vitest_1.vi.advanceTimersByTimeAsync(3000 * 1.2 + 50); // Second retry after ~3000ms
        (0, vitest_1.expect)(fn).toHaveBeenCalledTimes(3);
        await vitest_1.vi.advanceTimersByTimeAsync(6000 * 1.2 + 50); // Third retry after ~6000ms
        (0, vitest_1.expect)(fn).toHaveBeenCalledTimes(4);
        await (0, vitest_1.expect)(promise).resolves.toBe('success');
        randomSpy.mockRestore();
        vitest_1.vi.useRealTimers();
    });
    (0, vitest_1.it)('respects maxDelayMs cap on exponential growth', async () => {
        vitest_1.vi.useFakeTimers();
        const fn = vitest_1.vi.fn().mockRejectedValueOnce(new Error('fail')).mockResolvedValue('ok');
        const promise = (0, rpc_client_1.withRetry)(fn, 3, 1500, rpc_client_1.DEFAULT_IS_RETRYABLE, 2000);
        await vitest_1.vi.advanceTimersByTimeAsync(0);
        await vitest_1.vi.advanceTimersByTimeAsync(1500); // First retry
        await vitest_1.vi.advanceTimersByTimeAsync(2000); // Second retry should be capped at 2000, not 3000
        await (0, vitest_1.expect)(promise).resolves.toBe('ok');
        vitest_1.vi.useRealTimers();
    });
    (0, vitest_1.it)('jitter does not cause delay to exceed maxDelayMs cap', async () => {
        vitest_1.vi.useFakeTimers();
        const fn = vitest_1.vi.fn().mockResolvedValue('ok');
        const startTime = Date.now();
        // Jitter is ±20% of capped delay, so for cap of 1000: jitter max is 200
        // Total max delay should not exceed 1000 + 200 = 1200
        const promise = (0, rpc_client_1.withRetry)(fn, 1, 500, rpc_client_1.DEFAULT_IS_RETRYABLE, 1000);
        await vitest_1.vi.advanceTimersByTimeAsync(1200);
        await (0, vitest_1.expect)(promise).resolves.toBe('ok');
        const elapsed = Date.now() - startTime;
        (0, vitest_1.expect)(elapsed).toBeLessThanOrEqual(1200);
        vitest_1.vi.useRealTimers();
    });
    (0, vitest_1.it)('last error is re-thrown after exhaustion with StellarRPCError', async () => {
        const fn = vitest_1.vi.fn().mockRejectedValue(new Error('Service Unavailable'));
        let caughtErr;
        try {
            await (0, rpc_client_1.withRetry)(fn, 3, 0);
        }
        catch (e) {
            caughtErr = e;
        }
        (0, vitest_1.expect)(caughtErr).toBeInstanceOf(Error);
        const err = caughtErr;
        (0, vitest_1.expect)(err.name).toBe('StellarRPCError');
        (0, vitest_1.expect)(err.message).toContain('RPC call failed after 3 attempt(s)');
        let caught;
        try {
            await (0, rpc_client_1.withRetry)(fn, 3, 0);
        }
        catch (e) {
            caught = e;
        }
        (0, vitest_1.expect)(caught).toBeDefined();
        (0, vitest_1.expect)(caught.name).toBe('StellarRPCError');
        (0, vitest_1.expect)(caught.message).toContain('RPC call failed after 3 attempt(s)');
    });
});
// ─── withTimeout ──────────────────────────────────────────────────────────────
(0, vitest_1.describe)('withTimeout', () => {
    (0, vitest_1.it)('resolves when the promise completes before the timeout', async () => {
        const fast = Promise.resolve('done');
        await (0, vitest_1.expect)((0, rpc_client_1.withTimeout)(fast, 500)).resolves.toBe('done');
    });
    (0, vitest_1.it)('throws TimeoutError when the promise exceeds the timeout', async () => {
        const slow = new Promise(() => { }); // never resolves
        await (0, vitest_1.expect)((0, rpc_client_1.withTimeout)(slow, 10)).rejects.toBeInstanceOf(rpc_client_1.TimeoutError);
    });
    (0, vitest_1.it)('TimeoutError message identifies it as a timeout, not a network error', async () => {
        const slow = new Promise(() => { });
        const err = await (0, rpc_client_1.withTimeout)(slow, 10).catch((e) => e);
        (0, vitest_1.expect)(err).toBeInstanceOf(rpc_client_1.TimeoutError);
        (0, vitest_1.expect)(err.message).toMatch(/timeout/i);
        (0, vitest_1.expect)(err.name).toBe('TimeoutError');
    });
    (0, vitest_1.it)('clears the timer when the wrapped promise rejects early', async () => {
        vitest_1.vi.useFakeTimers();
        const rejectPromise = Promise.reject(new Error('early failure'));
        rejectPromise.catch(() => { }); // prevent unhandled rejection
        const timed = (0, rpc_client_1.withTimeout)(rejectPromise, 5000);
        await (0, vitest_1.expect)(timed).rejects.toThrow('early failure');
        (0, vitest_1.expect)(vitest_1.vi.getTimerCount()).toBe(0);
    });
});
// ─── prepareSorobanTx auth checks ──────────────────────────────────────────
(0, vitest_1.describe)('prepareSorobanTx auth checks', () => {
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.spyOn(rpc_client_1.sorobanServer, 'simulateTransaction').mockResolvedValue({});
    });
    (0, vitest_1.it)('throws when auth contains an unexpected signer (address credentials)', async () => {
        const badKeypair = stellar_sdk_1.Keypair.random();
        const badAddress = badKeypair.publicKey();
        const rawKey = stellar_sdk_1.StrKey.decodeEd25519PublicKey(badAddress);
        const mockAuthEntry = {
            credentials: () => ({
                switch: () => stellar_sdk_1.xdr.SorobanCredentialsType.sorobanCredentialsAddress(),
                address: () => ({
                    address: () => ({
                        switch: () => stellar_sdk_1.xdr.ScAddressType.scAddressTypeAccount(),
                        accountId: () => ({
                            ed25519: () => rawKey,
                        }),
                    }),
                }),
            }),
        };
        const mockTx = {
            operations: [{ auth: [mockAuthEntry] }],
        };
        vitest_1.vi.mocked(stellar_sdk_1.rpc.assembleTransaction).mockReturnValue({
            build: vitest_1.vi.fn().mockReturnValue(mockTx),
        });
        const dummyTx = {};
        await (0, vitest_1.expect)((0, rpc_client_1.prepareSorobanTx)(dummyTx)).rejects.toThrow(/unexpected/i);
    });
    (0, vitest_1.it)('does not throw when auth entries use source account credentials', async () => {
        const mockAuthEntry = {
            credentials: () => ({
                switch: () => stellar_sdk_1.xdr.SorobanCredentialsType.sorobanCredentialsSourceAccount(),
            }),
        };
        const mockTx = {
            operations: [{ auth: [mockAuthEntry] }],
        };
        vitest_1.vi.mocked(stellar_sdk_1.rpc.assembleTransaction).mockReturnValue({
            build: vitest_1.vi.fn().mockReturnValue(mockTx),
        });
        const dummyTx = {};
        await (0, vitest_1.expect)((0, rpc_client_1.prepareSorobanTx)(dummyTx)).resolves.toBeDefined();
    });
    (0, vitest_1.it)("does not throw when address credentials match the agent's public key", async () => {
        const agentSecret = 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X';
        const agentPublicKey = stellar_sdk_1.Keypair.fromSecret(agentSecret).publicKey();
        const rawKey = stellar_sdk_1.StrKey.decodeEd25519PublicKey(agentPublicKey);
        const mockAuthEntry = {
            credentials: () => ({
                switch: () => stellar_sdk_1.xdr.SorobanCredentialsType.sorobanCredentialsAddress(),
                address: () => ({
                    address: () => ({
                        switch: () => stellar_sdk_1.xdr.ScAddressType.scAddressTypeAccount(),
                        accountId: () => ({
                            ed25519: () => rawKey,
                        }),
                    }),
                }),
            }),
        };
        const mockTx = {
            operations: [{ auth: [mockAuthEntry] }],
        };
        vitest_1.vi.mocked(stellar_sdk_1.rpc.assembleTransaction).mockReturnValue({
            build: vitest_1.vi.fn().mockReturnValue(mockTx),
        });
        const dummyTx = {};
        await (0, vitest_1.expect)((0, rpc_client_1.prepareSorobanTx)(dummyTx)).resolves.toBeDefined();
    });
});
// ─── prepareSorobanTx budget_exceeded handling ─────────────────────────────
(0, vitest_1.describe)('prepareSorobanTx budget_exceeded handling', () => {
    (0, vitest_1.it)('throws SimulationBudgetError when simulation reports budget_exceeded', async () => {
        vitest_1.vi.spyOn(rpc_client_1.sorobanServer, 'simulateTransaction').mockResolvedValue({
            error: 'HostError: Error(Budget, #0) budget_exceeded',
        });
        const dummyTx = {};
        const err = await (0, rpc_client_1.prepareSorobanTx)(dummyTx).catch((e) => e);
        (0, vitest_1.expect)(err).toBeInstanceOf(errors_1.SimulationBudgetError);
        (0, vitest_1.expect)(err.message).toContain('budget_exceeded');
    });
    (0, vitest_1.it)('throws a ContractError with error detail for non-budget simulation failures', async () => {
        vitest_1.vi.spyOn(rpc_client_1.sorobanServer, 'simulateTransaction').mockResolvedValue({
            error: 'HostError: unrelated simulation problem',
        });
        const dummyTx = {};
        const err = await (0, rpc_client_1.prepareSorobanTx)(dummyTx).catch((e) => e);
        (0, vitest_1.expect)(err).not.toBeInstanceOf(errors_1.SimulationBudgetError);
        (0, vitest_1.expect)(err).toBeInstanceOf(errors_1.ContractError);
        (0, vitest_1.expect)(err.message).toBe('Soroban simulation failed: HostError: unrelated simulation problem');
        (0, vitest_1.expect)(err.cause).toBe('HostError: unrelated simulation problem');
    });
});
// ─── Request ID headers ───────────────────────────────────────────────────────
(0, vitest_1.describe)('RPC servers with request ID headers', () => {
    (0, vitest_1.it)('horizonServer is created with X-Request-ID header', () => {
        (0, vitest_1.expect)(rpc_client_1.horizonServer).toBeDefined();
    });
    (0, vitest_1.it)('sorobanServer is created with X-Request-ID header', () => {
        (0, vitest_1.expect)(rpc_client_1.sorobanServer).toBeDefined();
    });
});
// ─── #369: Horizon account cache TTL ──────────────────────────────────────────
(0, vitest_1.describe)('loadAccount — account cache TTL', () => {
    const PUBKEY = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
    const OTHER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let fetchSpy;
    (0, vitest_1.beforeEach)(() => {
        (0, rpc_client_1.invalidateAccountCache)();
        vitest_1.vi.useFakeTimers();
        fetchSpy = vitest_1.vi
            .spyOn(rpc_client_1.horizonServer, 'loadAccount')
            .mockImplementation(async (id) => ({ accountId: () => id }));
    });
    (0, vitest_1.afterEach)(() => {
        fetchSpy.mockRestore();
        (0, rpc_client_1.invalidateAccountCache)();
        vitest_1.vi.useRealTimers();
    });
    (0, vitest_1.it)('serves the second read from cache without hitting Horizon', async () => {
        await (0, rpc_client_1.loadAccount)(PUBKEY);
        await (0, rpc_client_1.loadAccount)(PUBKEY);
        (0, vitest_1.expect)(fetchSpy).toHaveBeenCalledTimes(1);
    });
    (0, vitest_1.it)('re-fetches once the TTL has elapsed', async () => {
        await (0, rpc_client_1.loadAccount)(PUBKEY);
        (0, vitest_1.expect)(fetchSpy).toHaveBeenCalledTimes(1);
        // One millisecond short of the TTL the entry is still fresh.
        vitest_1.vi.advanceTimersByTime(29_999);
        await (0, rpc_client_1.loadAccount)(PUBKEY);
        (0, vitest_1.expect)(fetchSpy).toHaveBeenCalledTimes(1);
        // Crossing it forces a refresh.
        vitest_1.vi.advanceTimersByTime(2);
        await (0, rpc_client_1.loadAccount)(PUBKEY);
        (0, vitest_1.expect)(fetchSpy).toHaveBeenCalledTimes(2);
    });
    (0, vitest_1.it)('caches each account separately', async () => {
        await (0, rpc_client_1.loadAccount)(PUBKEY);
        await (0, rpc_client_1.loadAccount)(OTHER);
        await (0, rpc_client_1.loadAccount)(PUBKEY);
        await (0, rpc_client_1.loadAccount)(OTHER);
        // One fetch each, not one per call and not one shared entry.
        (0, vitest_1.expect)(fetchSpy).toHaveBeenCalledTimes(2);
    });
    (0, vitest_1.it)('bypasses the cache when forceRefresh is set', async () => {
        await (0, rpc_client_1.loadAccount)(PUBKEY);
        await (0, rpc_client_1.loadAccount)(PUBKEY, { forceRefresh: true });
        // This is the tx_bad_seq recovery path: it must never be served a cached
        // sequence number, which is precisely the value that was just rejected.
        (0, vitest_1.expect)(fetchSpy).toHaveBeenCalledTimes(2);
    });
    (0, vitest_1.it)('does not leave a stale entry behind when a refresh fails', async () => {
        await (0, rpc_client_1.loadAccount)(PUBKEY);
        vitest_1.vi.advanceTimersByTime(30_001);
        // TypeError so DEFAULT_IS_RETRYABLE short-circuits: a retryable error would
        // sit in withRetry's back-off, which never advances under fake timers.
        fetchSpy.mockRejectedValueOnce(new TypeError('horizon down'));
        await (0, vitest_1.expect)((0, rpc_client_1.loadAccount)(PUBKEY)).rejects.toThrow('horizon down');
        // The expired entry was dropped on the miss, so the next call refetches
        // rather than quietly serving a record that is now well past its TTL.
        fetchSpy.mockImplementation(async (id) => ({ accountId: () => id }));
        await (0, rpc_client_1.loadAccount)(PUBKEY);
        (0, vitest_1.expect)(fetchSpy).toHaveBeenCalledTimes(3);
    });
    (0, vitest_1.it)('invalidateAccountCache drops a single key or the whole cache', async () => {
        await (0, rpc_client_1.loadAccount)(PUBKEY);
        await (0, rpc_client_1.loadAccount)(OTHER);
        (0, vitest_1.expect)(fetchSpy).toHaveBeenCalledTimes(2);
        (0, rpc_client_1.invalidateAccountCache)(PUBKEY);
        await (0, rpc_client_1.loadAccount)(PUBKEY);
        await (0, rpc_client_1.loadAccount)(OTHER);
        (0, vitest_1.expect)(fetchSpy).toHaveBeenCalledTimes(3);
        (0, rpc_client_1.invalidateAccountCache)();
        await (0, rpc_client_1.loadAccount)(PUBKEY);
        await (0, rpc_client_1.loadAccount)(OTHER);
        (0, vitest_1.expect)(fetchSpy).toHaveBeenCalledTimes(5);
    });
});
// ─── #439: network partition (hang) scenarios ─────────────────────────────────
//
// A network partition is the most damaging failure mode in production: the
// connection neither resolves nor rejects — it just hangs. These tests use
// Vitest fake timers to simulate that against withTimeout/withRetry without
// waiting real wall-clock time.
(0, vitest_1.describe)('network partition simulation (#439)', () => {
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.useFakeTimers();
    });
    (0, vitest_1.afterEach)(() => {
        vitest_1.vi.useRealTimers();
    });
    (0, vitest_1.it)('withTimeout throws TimeoutError when a call hangs past the timeout window', async () => {
        // A partitioned connection: the promise never settles.
        const hung = new Promise(() => { });
        const timed = (0, rpc_client_1.withTimeout)(hung, 9_000); // config.RPC_TIMEOUT_MS
        const expectation = (0, vitest_1.expect)(timed).rejects.toBeInstanceOf(rpc_client_1.TimeoutError);
        // Just before the window the call is still pending.
        await vitest_1.vi.advanceTimersByTimeAsync(8_999);
        // Crossing it fires the TimeoutError.
        await vitest_1.vi.advanceTimersByTimeAsync(1);
        await expectation;
    });
    (0, vitest_1.it)('withTimeout still resolves if the hung call completes after the timer armed but before firing', async () => {
        let resolveFn;
        const hung = new Promise((resolve) => {
            resolveFn = resolve;
        });
        const timed = (0, rpc_client_1.withTimeout)(hung, 9_000);
        const expectation = (0, vitest_1.expect)(timed).resolves.toBe('late but alive');
        await vitest_1.vi.advanceTimersByTimeAsync(5_000);
        resolveFn('late but alive');
        await expectation;
    });
    (0, vitest_1.it)('withRetry makes exactly 3 calls when the first two timeout and the third succeeds', async () => {
        // Each attempt mirrors a real RPC call: the request itself carries a
        // per-request timeout, so a partitioned attempt settles as TimeoutError
        // instead of hanging the whole retry loop forever.
        let call = 0;
        const fn = vitest_1.vi.fn(() => {
            const t = call++;
            if (t < 2)
                return (0, rpc_client_1.withTimeout)(new Promise(() => { }), 9_000);
            return Promise.resolve('recovered');
        });
        const promise = (0, rpc_client_1.withRetry)(fn, 3, 0);
        // Attempt 1: hangs, then times out. Advance slightly past the timeout so
        // the zero-delay back-off timer scheduled at the boundary also fires.
        await vitest_1.vi.advanceTimersByTimeAsync(0);
        (0, vitest_1.expect)(fn).toHaveBeenCalledTimes(1);
        // Attempt 2: hangs, then times out.
        await vitest_1.vi.advanceTimersByTimeAsync(9_050);
        (0, vitest_1.expect)(fn).toHaveBeenCalledTimes(2);
        // Attempt 3: succeeds immediately.
        await vitest_1.vi.advanceTimersByTimeAsync(9_050);
        await (0, vitest_1.expect)(promise).resolves.toBe('recovered');
        (0, vitest_1.expect)(fn).toHaveBeenCalledTimes(3);
    });
    (0, vitest_1.it)('withRetry wraps the last TimeoutError in StellarRPCError after exhausting retries', async () => {
        const fn = vitest_1.vi.fn(() => (0, rpc_client_1.withTimeout)(new Promise(() => { }), 9_000));
        const promise = (0, rpc_client_1.withRetry)(fn, 2, 0);
        const expectation = (0, vitest_1.expect)(promise).rejects.toThrow(/RPC call failed after 2 attempt\(s\).*Transaction Timeout/i);
        // Attempt 1 times out at 9s; attempt 2 also hangs and times out. The
        // +50ms epsilon lets the zero-delay back-off timer scheduled at the
        // timeout boundary fire within the same advance.
        await vitest_1.vi.advanceTimersByTimeAsync(0);
        await vitest_1.vi.advanceTimersByTimeAsync(9_050);
        await vitest_1.vi.advanceTimersByTimeAsync(9_050);
        await expectation;
        (0, vitest_1.expect)(fn).toHaveBeenCalledTimes(2);
    });
    (0, vitest_1.it)('withRetry exits after 1 attempt when isRetryable returns false for timeouts', async () => {
        const fn = vitest_1.vi.fn(() => (0, rpc_client_1.withTimeout)(new Promise(() => { }), 9_000));
        const isRetryable = vitest_1.vi.fn(() => false);
        const promise = (0, rpc_client_1.withRetry)(fn, 3, 0, isRetryable);
        const expectation = (0, vitest_1.expect)(promise).rejects.toBeInstanceOf(rpc_client_1.TimeoutError);
        await vitest_1.vi.advanceTimersByTimeAsync(0);
        await vitest_1.vi.advanceTimersByTimeAsync(9_000);
        await expectation;
        // Non-retryable: the loop must not attempt again.
        (0, vitest_1.expect)(fn).toHaveBeenCalledTimes(1);
        (0, vitest_1.expect)(isRetryable).toHaveBeenCalled();
    });
    (0, vitest_1.it)('DEFAULT_IS_RETRYABLE returns true for a TimeoutError (a partition is worth retrying)', () => {
        (0, vitest_1.expect)((0, rpc_client_1.DEFAULT_IS_RETRYABLE)(new rpc_client_1.TimeoutError(9_000))).toBe(true);
    });
    (0, vitest_1.it)('loadAccount surfaces TimeoutError when Horizon hangs past RPC_TIMEOUT_MS', async () => {
        (0, rpc_client_1.invalidateAccountCache)();
        const fetchSpy = vitest_1.vi
            .spyOn(rpc_client_1.horizonServer, 'loadAccount')
            .mockImplementation(() => new Promise(() => { }));
        const expectation = (0, vitest_1.expect)((0, rpc_client_1.loadAccount)('GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5')).rejects.toBeInstanceOf(rpc_client_1.TimeoutError);
        // RPC_TIMEOUT_MS = 9000 in the mocked config; withRetry's back-off delay
        // is 100ms and only runs between attempts, so a single crossing of the
        // timeout window is enough to surface the TimeoutError here.
        await vitest_1.vi.advanceTimersByTimeAsync(9_000);
        await expectation;
        fetchSpy.mockRestore();
        (0, rpc_client_1.invalidateAccountCache)();
    });
});
//# sourceMappingURL=rpc_client.test.js.map