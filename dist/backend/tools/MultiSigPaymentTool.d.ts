import { z } from "zod";
export declare const MultiSigInputSchema: z.ZodObject<{
    additionalSigners: z.ZodDefault<z.ZodArray<z.ZodEffects<z.ZodString, string, string>, "many">>;
}, "strip", z.ZodTypeAny, {
    additionalSigners: string[];
}, {
    additionalSigners?: string[] | undefined;
}>;
export type MultiSigInput = z.infer<typeof MultiSigInputSchema>;
export declare class MultiSigPaymentTool {
    execute(rawInput: unknown): Promise<MultiSigInput>;
}
//# sourceMappingURL=MultiSigPaymentTool.d.ts.map