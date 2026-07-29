import { z } from "zod";
export declare const BalanceCheckInputSchema: z.ZodObject<{
    publicKey: z.ZodEffects<z.ZodString, string, string>;
    assetIssuer: z.ZodEffects<z.ZodString, string, string>;
}, "strip", z.ZodTypeAny, {
    assetIssuer: string;
    publicKey: string;
}, {
    assetIssuer: string;
    publicKey: string;
}>;
export type BalanceCheckInput = z.infer<typeof BalanceCheckInputSchema>;
export declare class BalanceCheckTool {
    execute(rawInput: unknown): Promise<BalanceCheckInput>;
}
//# sourceMappingURL=BalanceCheckTool.d.ts.map