"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const MultiSigPaymentTool_1 = require("../backend/tools/MultiSigPaymentTool");
(0, vitest_1.describe)("MultiSigInputSchema", () => {
    const validSigner = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
    (0, vitest_1.it)("accepts valid Stellar public keys in additionalSigners", () => {
        const parsed = MultiSigPaymentTool_1.MultiSigInputSchema.parse({
            additionalSigners: [validSigner, validSigner],
        });
        (0, vitest_1.expect)(parsed.additionalSigners).toEqual([validSigner, validSigner]);
    });
    (0, vitest_1.it)("rejects an invalid additional signer at validation time", () => {
        (0, vitest_1.expect)(() => MultiSigPaymentTool_1.MultiSigInputSchema.parse({
            additionalSigners: [validSigner, "G".repeat(56)],
        })).toThrow(/Invalid Stellar public key/);
    });
});
//# sourceMappingURL=multi_sig_payment.test.js.map