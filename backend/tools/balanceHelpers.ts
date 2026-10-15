/**
 * backend/tools/balanceHelpers.ts
 * Shared typed helpers for Horizon account balances.
 */

import type { Horizon } from '@stellar/stellar-sdk';

/**
 * Properly typed balance entry from Horizon account.
 */
export interface TypedBalance {
  assetType: 'native' | 'credit4' | 'credit12';
  assetCode?: string;
  assetIssuer?: string;
  balance: string;
  limit?: string;
  isAuthorized?: boolean;
  isAuthorizedToMaintainLiabilities?: boolean;
}

/**
 * Convert Horizon's account balances to properly typed entries.
 */
export function getTypedBalances(account: Horizon.AccountResponse): TypedBalance[] {
  const rawBalances = account.balances as Horizon.HorizonApi.BalanceLine[];

  const result: TypedBalance[] = [];
  for (const b of rawBalances) {
    if (b.asset_type === 'native') {
      result.push({
        assetType: 'native',
        balance: b.balance,
      });
    } else if (
      b.asset_type === 'credit_alphanum4' ||
      b.asset_type === 'credit_alphanum12' ||
      (b as { asset_type: string }).asset_type === 'credit4' ||
      (b as { asset_type: string }).asset_type === 'credit12'
    ) {
      const assetType: TypedBalance['assetType'] =
        b.asset_type === 'credit_alphanum12' || (b as { asset_type: string }).asset_type === 'credit12'
          ? 'credit12'
          : 'credit4';

      const entry: TypedBalance = {
        assetType,
        balance: b.balance,
      };

      const assetLine = b as Partial<Horizon.HorizonApi.BalanceLineAsset>;
      if (assetLine.asset_code !== undefined) {
        entry.assetCode = assetLine.asset_code;
      }
      if (assetLine.asset_issuer !== undefined) {
        entry.assetIssuer = assetLine.asset_issuer;
      }
      if (assetLine.limit !== undefined) {
        entry.limit = assetLine.limit;
      }
      if (assetLine.is_authorized !== undefined) {
        entry.isAuthorized = assetLine.is_authorized;
      }
      if (assetLine.is_authorized_to_maintain_liabilities !== undefined) {
        entry.isAuthorizedToMaintainLiabilities = assetLine.is_authorized_to_maintain_liabilities;
      }

      result.push(entry);
    }
  }
  return result;
}

/**
 * Find a balance entry by asset code and issuer.
 */
export function findBalance(
  account: Horizon.AccountResponse,
  assetCode: string = 'XLM',
  assetIssuer?: string
): TypedBalance | undefined {
  const balances = getTypedBalances(account);
  return balances.find((b) => {
    if (assetCode === 'XLM' || assetCode === 'native') {
      return b.assetType === 'native';
    }
    return b.assetCode === assetCode && b.assetIssuer === assetIssuer;
  });
}