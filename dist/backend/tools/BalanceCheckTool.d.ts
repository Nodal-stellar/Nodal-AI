import { z } from 'zod';
export declare const BalanceCheckInputSchema: z.ZodObject<{
    publicKey: z.ZodEffects<z.ZodString, string, string>;
    assetIssuer: z.ZodEffects<z.ZodString, string, string>;
    assetCode: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    assetIssuer: string;
    publicKey: string;
    assetCode?: string | undefined;
}, {
    assetIssuer: string;
    publicKey: string;
    assetCode?: string | undefined;
}>;
export type BalanceCheckInput = z.infer<typeof BalanceCheckInputSchema>;
export declare class BalanceCheckTool {
    execute(rawInput: unknown): Promise<string>;
}
//# sourceMappingURL=BalanceCheckTool.d.ts.map