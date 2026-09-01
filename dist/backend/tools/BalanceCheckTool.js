"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BalanceCheckTool = exports.BalanceCheckInputSchema = void 0;
const stellar_sdk_1 = require("@stellar/stellar-sdk");
const zod_1 = require("zod");
const rpc_client_1 = require("../rpc_client");
const stellarPublicKeySchema = zod_1.z
    .string()
    .trim()
    .refine((value) => stellar_sdk_1.StrKey.isValidEd25519PublicKey(value), {
    message: 'Invalid Stellar public key',
});
exports.BalanceCheckInputSchema = zod_1.z.object({
    publicKey: stellarPublicKeySchema,
    assetIssuer: zod_1.z
        .string()
        .trim()
        .refine((value) => stellar_sdk_1.StrKey.isValidEd25519PublicKey(value), {
        message: 'Invalid Stellar asset issuer',
    }),
    assetCode: zod_1.z.string().trim().min(1).optional(),
});
class BalanceCheckTool {
    async execute(rawInput) {
        const input = exports.BalanceCheckInputSchema.parse(rawInput);
        const account = await (0, rpc_client_1.loadAccount)(input.publicKey);
        if (!input.assetCode)
            return '0';
        const balance = account.balances.find((entry) => entry.asset_type !== 'native' &&
            entry.asset_code === input.assetCode &&
            entry.asset_issuer === input.assetIssuer);
        return balance?.balance ?? '0';
    }
}
exports.BalanceCheckTool = BalanceCheckTool;
//# sourceMappingURL=BalanceCheckTool.js.map