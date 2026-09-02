"use strict";
/**
 * backend/tools/BatchPaymentTool.ts
 *
 * Executes 1–100 payment operations in a single atomic Stellar transaction.
 * Spending limit is enforced on the aggregate amount (sum of all payments).
 *
 * Because the batch is one transaction, it either applies in full or not at
 * all — there is no partial application to unwind. `failFast` therefore governs
 * the pre-flight check that runs before anything is submitted: with it set, the
 * first unusable payment aborts the batch and the payments behind it are
 * reported as skipped; without it every payment is checked so the caller gets
 * the full list of problems in one round trip.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BatchPaymentTool = exports.BatchPreflightError = exports.BatchPaymentInputSchema = void 0;
const stellar_sdk_1 = require("@stellar/stellar-sdk");
const zod_1 = require("zod");
const config_1 = require("../config");
const errors_1 = require("../errors");
const rpc_client_1 = require("../rpc_client");
const StellarPaymentTool_1 = require("./StellarPaymentTool");
const SorobanInvokeTool_1 = require("./SorobanInvokeTool");
exports.BatchPaymentInputSchema = zod_1.z.object({
    payments: zod_1.z.array(StellarPaymentTool_1.PaymentInputSchema).min(1).max(100),
    /**
     * Abort the batch at the first unusable payment instead of reporting every
     * problem at once. Defaults to false so existing callers are unaffected.
     */
    failFast: zod_1.z.boolean().optional().default(false),
});
/** Raised when a batch is rejected before submission, carrying the skip count. */
class BatchPreflightError extends errors_1.ValidationError {
    skipped;
    constructor(message, skipped, cause) {
        super(message, cause);
        this.skipped = skipped;
        Object.setPrototypeOf(this, BatchPreflightError.prototype);
    }
}
exports.BatchPreflightError = BatchPreflightError;
class BatchPaymentTool {
    keypair;
    networkPassphrase;
    constructor(secretKey = config_1.config.agentKeypair().secret()) {
        this.keypair = stellar_sdk_1.Keypair.fromSecret(secretKey);
        this.networkPassphrase = (0, rpc_client_1.resolveNetworkPassphrase)(config_1.config.STELLAR_NETWORK);
    }
    async execute(rawInput) {
        const { payments, failFast } = exports.BatchPaymentInputSchema.parse(rawInput);
        // Aggregate spending limit check
        const total = payments.reduce((sum, p) => sum + parseFloat(p.amount), 0);
        const limit = parseFloat(config_1.config.AGENT_SPENDING_LIMIT);
        if (total > limit) {
            throw new Error(`Batch total ${total} ${config_1.config.X402_ASSET_CODE} exceeds AGENT_SPENDING_LIMIT of ${config_1.config.AGENT_SPENDING_LIMIT}`);
        }
        // Pre-flight every payment before touching the network. Nothing here can be
        // partially applied, so a problem found now costs the caller nothing.
        const problems = [];
        for (let i = 0; i < payments.length; i++) {
            const p = payments[i];
            if (p.assetCode !== 'XLM' && !p.assetIssuer) {
                problems.push(`payment ${i}: Asset issuer is required for non-native asset ${p.assetCode}`);
                if (failFast) {
                    // Everything behind the failure is left untouched.
                    throw new BatchPreflightError(problems[0], payments.length - i - 1);
                }
            }
        }
        if (problems.length > 0) {
            throw new BatchPreflightError(problems.join('; '), 0);
        }
        const sourceAccount = await (0, rpc_client_1.loadAccount)(this.keypair.publicKey());
        const builder = new stellar_sdk_1.TransactionBuilder(sourceAccount, {
            fee: stellar_sdk_1.BASE_FEE,
            networkPassphrase: this.networkPassphrase,
        });
        for (const p of payments) {
            const asset = p.assetCode === 'XLM' ? stellar_sdk_1.Asset.native() : new stellar_sdk_1.Asset(p.assetCode, p.assetIssuer);
            builder.addOperation(stellar_sdk_1.Operation.payment({ destination: p.destination, asset, amount: p.amount }));
        }
        const tx = builder.setTimeout(SorobanInvokeTool_1.SOROBAN_TX_TIMEOUT).build();
        tx.sign(this.keypair);
        const result = StellarPaymentTool_1.SubmitResultSchema.parse(await (0, rpc_client_1.submitTransaction)(tx));
        // The batch is atomic: a submitted transaction applies every payment.
        return { txHash: result.hash, ledger: result.ledger, skipped: 0 };
    }
}
exports.BatchPaymentTool = BatchPaymentTool;
//# sourceMappingURL=BatchPaymentTool.js.map