"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const BalanceCheckTool_1 = require("../backend/tools/BalanceCheckTool");
(0, vitest_1.describe)("BalanceCheckInputSchema", () => {
    const validPublicKey = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
    (0, vitest_1.it)("accepts valid Stellar public keys for both fields", () => {
        const parsed = BalanceCheckTool_1.BalanceCheckInputSchema.parse({
            publicKey: validPublicKey,
            assetIssuer: validPublicKey,
        });
        (0, vitest_1.expect)(parsed.publicKey).toBe(validPublicKey);
        (0, vitest_1.expect)(parsed.assetIssuer).toBe(validPublicKey);
    });
    (0, vitest_1.it)("rejects a publicKey that is not a valid Ed25519 public key", () => {
        (0, vitest_1.expect)(() => BalanceCheckTool_1.BalanceCheckInputSchema.parse({
            publicKey: "G".repeat(56),
            assetIssuer: validPublicKey,
        })).toThrow(/Invalid Stellar public key/);
    });
    (0, vitest_1.it)("rejects an assetIssuer that is not a valid Ed25519 public key", () => {
        (0, vitest_1.expect)(() => BalanceCheckTool_1.BalanceCheckInputSchema.parse({
            publicKey: validPublicKey,
            assetIssuer: "G".repeat(56),
        })).toThrow(/Invalid Stellar asset issuer/);
    });
});
//# sourceMappingURL=balance_check.test.js.map