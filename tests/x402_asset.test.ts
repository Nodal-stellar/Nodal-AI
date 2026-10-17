import { describe, it, expect } from 'vitest';
import { Asset, Networks } from '@stellar/stellar-sdk';
import { resolveX402AssetContract } from '../backend/utils/x402Asset';

// The canonical USDC issuer on testnet — same fixture the config tests use.
const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

function baseConfig(overrides: Partial<Parameters<typeof resolveX402AssetContract>[0]> = {}) {
  return {
    X402_ASSET_CODE: 'USDC',
    X402_ASSET_ISSUER: USDC_ISSUER,
    STELLAR_NETWORK: 'testnet' as const,
    ...overrides,
  };
}

describe('x402Asset.ts — classic issuer (G) vs SAC contract (C)', () => {
  it('derives the SAC contract from code + issuer when X402_ASSET_CONTRACT is unset', () => {
    const resolved = resolveX402AssetContract(baseConfig());
    const expected = new Asset('USDC', USDC_ISSUER).contractId(Networks.TESTNET);
    expect(resolved).toBe(expected);
  });

  it('returns a 56-character C-address, not the classic G issuer', () => {
    const resolved = resolveX402AssetContract(baseConfig());
    expect(resolved).toHaveLength(56);
    expect(resolved.startsWith('C')).toBe(true);
    expect(resolved).not.toBe(USDC_ISSUER);
  });

  it('derives a different contract per network (testnet vs pubnet)', () => {
    const testnet = resolveX402AssetContract(baseConfig());
    const pubnet = resolveX402AssetContract(baseConfig({ STELLAR_NETWORK: 'mainnet' }));
    expect(testnet).not.toBe(pubnet);
  });

  it('explicit X402_ASSET_CONTRACT overrides the derivation', () => {
    const override = 'CBIELTK6YBZACUMEW3XYW3WBZM2IBCNRNBFILKQGTQJNKLPMNVTZMVWK';
    const resolved = resolveX402AssetContract(
      baseConfig({ X402_ASSET_CONTRACT: override })
    );
    expect(resolved).toBe(override);
    expect(resolved).not.toBe(new Asset('USDC', USDC_ISSUER).contractId(Networks.TESTNET));
  });

  it('native XLM resolves to the built-in native token contract', () => {
    const resolved = resolveX402AssetContract(
      baseConfig({ X402_ASSET_CODE: 'XLM' })
    );
    expect(resolved).toBe(Asset.native().contractId(Networks.TESTNET));
  });
});
