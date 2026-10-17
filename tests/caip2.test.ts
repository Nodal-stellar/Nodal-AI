import { describe, it, expect } from 'vitest';
import {
  toCaip2,
  fromCaip2,
  isStellarNetworkName,
  isStellarCaip2,
} from '../backend/utils/caip2';

describe('caip2.ts — Stellar network <-> CAIP-2 mapping', () => {
  it('maps each STELLAR_NETWORK env name to its CAIP-2 chain ID', () => {
    expect(toCaip2('testnet')).toBe('stellar:testnet');
    expect(toCaip2('mainnet')).toBe('stellar:pubnet');
    expect(toCaip2('futurenet')).toBe('stellar:futurenet');
  });

  it('maps mainnet to stellar:pubnet, not stellar:mainnet (CAIP-2 reference)', () => {
    // The production Stellar network is referenced as "pubnet" in CAIP-2;
    // emitting "stellar:mainnet" would break interop with x402 v2 peers.
    expect(toCaip2('mainnet')).not.toBe('stellar:mainnet');
  });

  it('round-trips every supported network', () => {
    for (const name of ['testnet', 'mainnet', 'futurenet'] as const) {
      expect(fromCaip2(toCaip2(name))).toBe(name);
    }
  });

  it('returns null for malformed or non-Stellar CAIP-2 IDs', () => {
    expect(fromCaip2('')).toBeNull();
    expect(fromCaip2('stellar')).toBeNull();
    expect(fromCaip2('eip155:1')).toBeNull();
    expect(fromCaip2('stellar:localnet')).toBeNull();
    expect(fromCaip2('stellar:pubnet ')).toBeNull(); // trailing whitespace is not a valid ID
  });

  it('type guards reject unknown values on both sides', () => {
    expect(isStellarNetworkName('mainnet')).toBe(true);
    expect(isStellarNetworkName('pubnet')).toBe(false); // CAIP-2 reference is not an env name
    expect(isStellarCaip2('stellar:pubnet')).toBe(true);
    expect(isStellarCaip2('mainnet')).toBe(false);
  });
});
