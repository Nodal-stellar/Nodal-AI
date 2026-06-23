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
vitest_1.vi.mock("../backend/config", () => ({
    config: {
        STELLAR_NETWORK: "testnet",
        HORIZON_URL: "https://horizon-testnet.stellar.org",
        SOROBAN_RPC_URL: "https://soroban-testnet.stellar.org",
        AGENT_SECRET_KEY: "SBPTNBEQQVQD5NIPZTCXHKM5ZVONK2ENLP5DTZJBGSUPOPWQSIFWZKX",
        X402_ASSET_CODE: "USDC",
        X402_ASSET_ISSUER: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
        MAX_RETRIES: 3,
        RETRY_DELAY_MS: 100,
    },
}));
// ─── DEFAULT_IS_RETRYABLE ─────────────────────────────────────────────────────
(0, vitest_1.describe)("DEFAULT_IS_RETRYABLE", () => {
    (0, vitest_1.it)("returns false for ZodError", () => {
        (0, vitest_1.expect)((0, rpc_client_1.DEFAULT_IS_RETRYABLE)(new zod_1.ZodError([]))).toBe(false);
    });
    (0, vitest_1.it)("returns false for TypeError", () => {
        (0, vitest_1.expect)((0, rpc_client_1.DEFAULT_IS_RETRYABLE)(new TypeError("bad type"))).toBe(false);
    });
    (0, vitest_1.it)("returns true for a generic Error", () => {
        (0, vitest_1.expect)((0, rpc_client_1.DEFAULT_IS_RETRYABLE)(new Error("503 Service Unavailable"))).toBe(true);
    });
    (0, vitest_1.it)("returns true for a plain string error", () => {
        (0, vitest_1.expect)((0, rpc_client_1.DEFAULT_IS_RETRYABLE)("network failure")).toBe(true);
    });
});
// ─── withRetry ────────────────────────────────────────────────────────────────
(0, vitest_1.describe)("withRetry", () => {
    (0, vitest_1.it)("throws ZodError immediately without retrying", async () => {
        const zodError = zod_1.z.string().safeParse(42).error;
        const fn = vitest_1.vi.fn().mockRejectedValue(zodError);
        await (0, vitest_1.expect)((0, rpc_client_1.withRetry)(fn, 3, 0)).rejects.toBeInstanceOf(zod_1.ZodError);
        // Deterministic failure — must not retry at all
        (0, vitest_1.expect)(fn).toHaveBeenCalledTimes(1);
    });
    (0, vitest_1.it)("throws TypeError immediately without retrying", async () => {
        const fn = vitest_1.vi.fn().mockRejectedValue(new TypeError("cannot read property"));
        await (0, vitest_1.expect)((0, rpc_client_1.withRetry)(fn, 3, 0)).rejects.toBeInstanceOf(TypeError);
        (0, vitest_1.expect)(fn).toHaveBeenCalledTimes(1);
    });
    (0, vitest_1.it)("retries the full MAX_RETRIES times for a transient error (e.g. HTTP 503)", async () => {
        const fn = vitest_1.vi.fn().mockRejectedValue(new Error("503 Service Unavailable"));
        await (0, vitest_1.expect)((0, rpc_client_1.withRetry)(fn, 3, 0)).rejects.toThrow("503");
        (0, vitest_1.expect)(fn).toHaveBeenCalledTimes(3);
    });
    (0, vitest_1.it)("resolves on the first successful attempt without retrying", async () => {
        const fn = vitest_1.vi.fn().mockResolvedValue("ok");
        await (0, vitest_1.expect)((0, rpc_client_1.withRetry)(fn, 3, 0)).resolves.toBe("ok");
        (0, vitest_1.expect)(fn).toHaveBeenCalledTimes(1);
    });
    (0, vitest_1.it)("resolves after a transient failure followed by success", async () => {
        const fn = vitest_1.vi.fn()
            .mockRejectedValueOnce(new Error("transient"))
            .mockResolvedValue("recovered");
        await (0, vitest_1.expect)((0, rpc_client_1.withRetry)(fn, 3, 0)).resolves.toBe("recovered");
        (0, vitest_1.expect)(fn).toHaveBeenCalledTimes(2);
    });
});
//# sourceMappingURL=rpc_client.test.js.map