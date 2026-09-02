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
import { z } from 'zod';
import { ValidationError } from '../errors';
export declare const BatchPaymentInputSchema: z.ZodObject<{
    payments: z.ZodArray<z.ZodEffects<z.ZodObject<{
        destination: z.ZodEffects<z.ZodString, string, string>;
        amount: z.ZodEffects<z.ZodString, string, string>;
        assetCode: z.ZodDefault<z.ZodString>;
        assetIssuer: z.ZodOptional<z.ZodString>;
        memoType: z.ZodDefault<z.ZodOptional<z.ZodEnum<["text", "id", "hash", "return"]>>>;
        memo: z.ZodOptional<z.ZodUnion<[z.ZodString, z.ZodNumber]>>;
    }, "strip", z.ZodTypeAny, {
        destination: string;
        amount: string;
        assetCode: string;
        memoType: "id" | "text" | "hash" | "return";
        assetIssuer?: string | undefined;
        memo?: string | number | undefined;
    }, {
        destination: string;
        amount: string;
        assetCode?: string | undefined;
        assetIssuer?: string | undefined;
        memoType?: "id" | "text" | "hash" | "return" | undefined;
        memo?: string | number | undefined;
    }>, {
        destination: string;
        amount: string;
        assetCode: string;
        memoType: "id" | "text" | "hash" | "return";
        assetIssuer?: string | undefined;
        memo?: string | number | undefined;
    }, {
        destination: string;
        amount: string;
        assetCode?: string | undefined;
        assetIssuer?: string | undefined;
        memoType?: "id" | "text" | "hash" | "return" | undefined;
        memo?: string | number | undefined;
    }>, "many">;
    /**
     * Abort the batch at the first unusable payment instead of reporting every
     * problem at once. Defaults to false so existing callers are unaffected.
     */
    failFast: z.ZodDefault<z.ZodOptional<z.ZodBoolean>>;
}, "strip", z.ZodTypeAny, {
    payments: {
        destination: string;
        amount: string;
        assetCode: string;
        memoType: "id" | "text" | "hash" | "return";
        assetIssuer?: string | undefined;
        memo?: string | number | undefined;
    }[];
    failFast: boolean;
}, {
    payments: {
        destination: string;
        amount: string;
        assetCode?: string | undefined;
        assetIssuer?: string | undefined;
        memoType?: "id" | "text" | "hash" | "return" | undefined;
        memo?: string | number | undefined;
    }[];
    failFast?: boolean | undefined;
}>;
export type BatchPaymentInput = z.infer<typeof BatchPaymentInputSchema>;
export interface BatchPaymentResult {
    txHash: string;
    ledger: number;
    /**
     * Payments that were never attempted. Only non-zero when a failed pre-flight
     * ended the batch early under `failFast`; a submitted batch is atomic, so on
     * success nothing is skipped.
     */
    skipped: number;
}
/** Raised when a batch is rejected before submission, carrying the skip count. */
export declare class BatchPreflightError extends ValidationError {
    readonly skipped: number;
    constructor(message: string, skipped: number, cause?: unknown);
}
export declare class BatchPaymentTool {
    private keypair;
    private networkPassphrase;
    constructor(secretKey?: string);
    execute(rawInput: unknown): Promise<BatchPaymentResult>;
}
//# sourceMappingURL=BatchPaymentTool.d.ts.map