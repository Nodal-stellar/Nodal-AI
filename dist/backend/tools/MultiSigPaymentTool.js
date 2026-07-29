"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MultiSigPaymentTool = exports.MultiSigInputSchema = void 0;
const stellar_sdk_1 = require("@stellar/stellar-sdk");
const zod_1 = require("zod");
const StellarPublicKeySchema = zod_1.z.string().trim().refine((value) => stellar_sdk_1.StrKey.isValidEd25519PublicKey(value), { message: "Invalid Stellar public key" });
exports.MultiSigInputSchema = zod_1.z.object({
    additionalSigners: zod_1.z.array(StellarPublicKeySchema).default([]),
});
class MultiSigPaymentTool {
    async execute(rawInput) {
        return exports.MultiSigInputSchema.parse(rawInput);
    }
}
exports.MultiSigPaymentTool = MultiSigPaymentTool;
//# sourceMappingURL=MultiSigPaymentTool.js.map