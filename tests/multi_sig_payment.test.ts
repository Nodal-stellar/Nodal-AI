import { describe, expect, it } from "vitest";
import { MultiSigInputSchema } from "../backend/tools/MultiSigPaymentTool";

describe("MultiSigInputSchema", () => {
  const validSigner = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

  it("accepts valid Stellar public keys in additionalSigners", () => {
    const parsed = MultiSigInputSchema.parse({
      additionalSigners: [validSigner, validSigner],
    });

    expect(parsed.additionalSigners).toEqual([validSigner, validSigner]);
  });

  it("rejects an invalid additional signer at validation time", () => {
    expect(() =>
      MultiSigInputSchema.parse({
        additionalSigners: [validSigner, "G".repeat(56)],
      })
    ).toThrow(/Invalid Stellar public key/);
  });
});
