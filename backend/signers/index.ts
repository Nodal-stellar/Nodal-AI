/**
 * backend/signers/index.ts
 *
 * Selects the signing backend from `SIGNER_BACKEND`.
 */

import { config, getVaultToken } from '../config';
import { LocalSigner } from './LocalSigner';
import { VaultTransitSigner } from './VaultTransitSigner';
import type { Signer } from './Signer';

export type { Signer, SignerBackend } from './Signer';
export { signTransaction } from './Signer';
export { LocalSigner } from './LocalSigner';
export { VaultTransitSigner } from './VaultTransitSigner';
export { PolicyAccountSigner } from '../signer';

/**
 * Build the signer configured by `SIGNER_BACKEND`.
 *
 * - `local` (default): signs with `config.agentKeypair()`.
 *   - `vault`: signs with a HashiCorp Vault transit key. Requires `VAULT_ADDR`,
 *   `VAULT_TRANSIT_KEY` and `VAULT_TOKEN`. The token is validated by config and
 *   retrieved through its secret accessor rather than stored on `config`.
 */
export function createSigner(): Signer {
  switch (config.SIGNER_BACKEND) {
    case 'vault': {
      const token = getVaultToken();
      if (!config.VAULT_ADDR || !config.VAULT_TRANSIT_KEY || !token) {
        throw new Error(
          'SIGNER_BACKEND=vault requires VAULT_ADDR, VAULT_TRANSIT_KEY and VAULT_TOKEN to be set'
        );
      }
      return new VaultTransitSigner({
        address: config.VAULT_ADDR,
        token,
        keyName: config.VAULT_TRANSIT_KEY,
        mount: config.VAULT_TRANSIT_MOUNT,
      });
    }

    case 'local':
    default:
      return new LocalSigner(config.agentKeypair());
  }
}
