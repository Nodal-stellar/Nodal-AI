import { StrKey } from "@stellar/stellar-sdk";
import { z } from "zod";

const StellarPublicKeySchema = z.string().trim().refine(
  (value) => StrKey.isValidEd25519PublicKey(value),
  { message: "Invalid Stellar public key" }
);

export const MultiSigInputSchema = z.object({
  additionalSigners: z.array(StellarPublicKeySchema).default([]),
});

export type MultiSigInput = z.infer<typeof MultiSigInputSchema>;

export class MultiSigPaymentTool {
  async execute(rawInput: unknown): Promise<MultiSigInput> {
    return MultiSigInputSchema.parse(rawInput);
  }
}
