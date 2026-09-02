"use strict";
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
const BalanceCheckTool_1 = require("../backend/tools/BalanceCheckTool");
const rpcClient = __importStar(require("../backend/rpc_client"));
vitest_1.vi.mock('../backend/rpc_client', () => ({ loadAccount: vitest_1.vi.fn() }));
(0, vitest_1.describe)('BalanceCheckInputSchema', () => {
    const validPublicKey = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
    (0, vitest_1.it)('accepts valid Stellar public keys for both fields', () => {
        const parsed = BalanceCheckTool_1.BalanceCheckInputSchema.parse({
            publicKey: validPublicKey,
            assetIssuer: validPublicKey,
            assetCode: 'USDC',
        });
        (0, vitest_1.expect)(parsed.publicKey).toBe(validPublicKey);
        (0, vitest_1.expect)(parsed.assetIssuer).toBe(validPublicKey);
    });
    (0, vitest_1.it)('rejects a publicKey that is not a valid Ed25519 public key', () => {
        (0, vitest_1.expect)(() => BalanceCheckTool_1.BalanceCheckInputSchema.parse({
            publicKey: 'G'.repeat(56),
            assetIssuer: validPublicKey,
            assetCode: 'USDC',
        })).toThrow(/Invalid Stellar public key/);
    });
    (0, vitest_1.it)('retrieves the matching asset balance', async () => {
        vitest_1.vi.mocked(rpcClient.loadAccount).mockResolvedValue({
            balances: [
                {
                    asset_type: 'credit_alphanum4',
                    asset_code: 'USDC',
                    asset_issuer: validPublicKey,
                    balance: '2.5',
                },
            ],
        });
        await (0, vitest_1.expect)(new BalanceCheckTool_1.BalanceCheckTool().execute({
            publicKey: validPublicKey,
            assetIssuer: validPublicKey,
            assetCode: 'USDC',
        })).resolves.toBe('2.5');
    });
    (0, vitest_1.it)('returns zero when the asset balance is absent', async () => {
        vitest_1.vi.mocked(rpcClient.loadAccount).mockResolvedValue({ balances: [] });
        await (0, vitest_1.expect)(new BalanceCheckTool_1.BalanceCheckTool().execute({
            publicKey: validPublicKey,
            assetIssuer: validPublicKey,
            assetCode: 'USDC',
        })).resolves.toBe('0');
    });
    (0, vitest_1.it)('rejects an assetIssuer that is not a valid Ed25519 public key', () => {
        (0, vitest_1.expect)(() => BalanceCheckTool_1.BalanceCheckInputSchema.parse({
            publicKey: validPublicKey,
            assetIssuer: 'G'.repeat(56),
            assetCode: 'USDC',
        })).toThrow(/Invalid Stellar asset issuer/);
    });
});
//# sourceMappingURL=balance_check.test.js.map