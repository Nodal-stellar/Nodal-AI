"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BalanceCheckTool = exports.BalanceCheckInputSchema = void 0;
const stellar_sdk_1 = require("@stellar/stellar-sdk");
const zod_1 = require("zod");
const stellarPublicKeySchema = zod_1.z.string().trim().refine((value) => stellar_sdk_1.StrKey.isValidEd25519PublicKey(value), { message: "Invalid Stellar public key" });
exports.BalanceCheckInputSchema = zod_1.z.object({
    publicKey: stellarPublicKeySchema,
    assetIssuer: zod_1.z.string().trim().refine((value) => stellar_sdk_1.StrKey.isValidEd25519PublicKey(value), { message: "Invalid Stellar asset issuer" }),
});
class BalanceCheckTool {
    async execute(rawInput) {
        return exports.BalanceCheckInputSchema.parse(rawInput);
    }
}
exports.BalanceCheckTool = BalanceCheckTool;
//# sourceMappingURL=BalanceCheckTool.js.map