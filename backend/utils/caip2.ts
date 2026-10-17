/**
 * backend/utils/caip2.ts
 *
 * CAIP-2 chain identifier helpers for the x402 layer.
 *
 * x402 v2 identifies chains by CAIP-2 chain IDs (`namespace:reference`).
 * The Stellar networks map as:
 *
 *   testnet   -> stellar:testnet
 *   mainnet   -> stellar:pubnet   (the CAIP-2 reference of the production network)
 *   futurenet -> stellar:futurenet
 *
 * x402 proofs previously reported the bare `STELLAR_NETWORK` env name
 * (`'testnet' | 'mainnet' | 'futurenet'`), which peers that only speak CAIP-2
 * cannot interpret. These helpers keep both directions total: unknown input
 * returns `null` instead of throwing, so a malformed identifier from a peer
 * can be logged and skipped rather than crash the caller.
 */

export type StellarNetworkName = 'testnet' | 'mainnet' | 'futurenet';

const NAME_TO_CAIP2: Record<StellarNetworkName, string> = {
  testnet: 'stellar:testnet',
  mainnet: 'stellar:pubnet',
  futurenet: 'stellar:futurenet',
};

const CAIP2_TO_NAME: Record<string, StellarNetworkName> = {
  'stellar:testnet': 'testnet',
  'stellar:pubnet': 'mainnet',
  'stellar:futurenet': 'futurenet',
};

export function isStellarNetworkName(value: string): value is StellarNetworkName {
  return value in NAME_TO_CAIP2;
}

export function isStellarCaip2(value: string): boolean {
  return value in CAIP2_TO_NAME;
}

/**
 * Convert a `STELLAR_NETWORK` env name to its CAIP-2 chain identifier.
 *
 * The parameter is typed as {@link StellarNetworkName} because config already
 * validates the env var against the same enum — if a fourth network is ever
 * added there, this Record will fail to compile until the mapping is updated,
 * which keeps the two vocabularies from drifting apart.
 */
export function toCaip2(network: StellarNetworkName): string {
  return NAME_TO_CAIP2[network];
}

/**
 * Convert a CAIP-2 chain identifier back to the `STELLAR_NETWORK` env name.
 * Returns `null` for non-Stellar or malformed identifiers.
 */
export function fromCaip2(id: string): StellarNetworkName | null {
  return CAIP2_TO_NAME[id] ?? null;
}
