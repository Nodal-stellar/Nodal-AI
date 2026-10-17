/**
 * backend/utils/x402Asset.ts
 *
 * Resolution of the SEP-41 SAC contract address for the configured x402 asset.
 *
 * A Stellar asset has two different addresses and mixing them up causes
 * failed payments:
 *
 *   - the CLASSIC issuer: a 56-character G-address (Ed25519 account) —
 *     used for trustlines and challenge issuer checks (config.X402_ASSET_ISSUER);
 *   - the SEP-41 token contract: a 56-character C-address — what x402
 *     payment requirements reference when moving the asset as a contract
 *     balance.
 *
 * The SAC address is deterministic from (code, issuer, network passphrase),
 * so an explicitly configured X402_ASSET_CONTRACT only needs to override the
 * derivation when an operator points at a non-standard wrapper contract.
 */

import { Asset, Networks } from '@stellar/stellar-sdk';

export type NetworkPassphrases = typeof NETWORK_PASSPHRASES;

const NETWORK_PASSPHRASES = {
  testnet: Networks.TESTNET,
  mainnet: Networks.PUBLIC,
  futurenet: Networks.FUTURENET,
} as const;

/**
 * Return the SEP-41 SAC contract address for the configured asset.
 *
 * - An explicitly configured `X402_ASSET_CONTRACT` wins (validated to start
 *   with `C` by the config schema).
 * - Otherwise the address is derived from the asset code and classic issuer
 *   via `Asset.contractId()` for the active network. Native XLM is covered
 *   too: `Asset.native().contractId()` resolves to the built-in native token
 *   contract for the network.
 */
export function resolveX402AssetContract(config: {
  readonly X402_ASSET_CODE: string;
  readonly X402_ASSET_ISSUER: string;
  readonly X402_ASSET_CONTRACT?: string | undefined;
  readonly STELLAR_NETWORK: 'testnet' | 'mainnet' | 'futurenet';
}): string {
  if (config.X402_ASSET_CONTRACT) return config.X402_ASSET_CONTRACT;

  const passphrase = NETWORK_PASSPHRASES[config.STELLAR_NETWORK];
  const asset =
    config.X402_ASSET_CODE === 'XLM'
      ? Asset.native()
      : new Asset(config.X402_ASSET_CODE, config.X402_ASSET_ISSUER);

  return asset.contractId(passphrase);
}
