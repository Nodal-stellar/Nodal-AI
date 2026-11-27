/**
 * tests/escrow_client.test.ts
 *
 * Issue #989 — the backend must refuse to build an escrow
 * `initialize`/`initialize_with_fee` call for a token that isn't a known SAC
 * contract (native XLM, the default x402 asset, or an `ESCROW_ALLOWED_TOKENS`
 * entry). A malicious or unverified token contract can lie about
 * `transfer()`/balances or re-enter, so this check runs before any Soroban
 * call is ever built.
 */

import { describe, it, expect, vi } from 'vitest';
import { Asset, Networks } from '@stellar/stellar-sdk';
import type { AgentConfig } from '../backend/config';

const { USDC_ISSUER, EURC_ISSUER } = vi.hoisted(() => ({
  USDC_ISSUER: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  EURC_ISSUER: 'GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2',
}));

vi.mock('../backend/config', () => {
  const mockConfig: Partial<AgentConfig> = {
    STELLAR_NETWORK: 'testnet',
    HORIZON_URL: 'https://horizon-testnet.stellar.org',
    SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
    X402_ASSET_CODE: 'USDC',
    X402_ASSET_ISSUER: USDC_ISSUER,
    ESCROW_ALLOWED_TOKENS: undefined,
  };
  return { config: mockConfig };
});

import { config } from '../backend/config';
import { escrowCall, assertKnownEscrowToken } from '../backend/contracts/escrow/index';

const NETWORK_PASSPHRASE = Networks.TESTNET;
const USDC_CONTRACT = new Asset('USDC', USDC_ISSUER).contractId(NETWORK_PASSPHRASE);
const EURC_CONTRACT = new Asset('EURC', EURC_ISSUER).contractId(NETWORK_PASSPHRASE);
const XLM_CONTRACT = Asset.native().contractId(NETWORK_PASSPHRASE);

const BASE_ARGS = {
  depositor: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  recipient: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  arbiter: 'GBNZVO4ZVBVDDYCC7IAKTWDH3CSKPEFCYZ33ZTCAS7WTPUPKPIYZH3AY',
  amount: 100n,
  expiry: 9_999_999_999n,
};

describe('assertKnownEscrowToken', () => {
  it('accepts native XLM by default', () => {
    expect(() => assertKnownEscrowToken(XLM_CONTRACT)).not.toThrow();
  });

  it('accepts the default x402 asset by default', () => {
    expect(() => assertKnownEscrowToken(USDC_CONTRACT)).not.toThrow();
  });

  it('refuses an unknown token by default', () => {
    expect(() => assertKnownEscrowToken(EURC_CONTRACT)).toThrow(/not a known SAC contract/);
  });

  it('refuses an arbitrary non-SAC contract address', () => {
    expect(() =>
      assertKnownEscrowToken('CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')
    ).toThrow(/not a known SAC contract/);
  });

  it('accepts a token listed in ESCROW_ALLOWED_TOKENS', () => {
    (config as unknown as Record<string, unknown>).ESCROW_ALLOWED_TOKENS = `EURC:${EURC_ISSUER}`;
    try {
      expect(() => assertKnownEscrowToken(EURC_CONTRACT)).not.toThrow();
    } finally {
      (config as unknown as Record<string, unknown>).ESCROW_ALLOWED_TOKENS = undefined;
    }
  });

  it('still refuses a token not in ESCROW_ALLOWED_TOKENS', () => {
    (config as unknown as Record<string, unknown>).ESCROW_ALLOWED_TOKENS = `EURC:${EURC_ISSUER}`;
    try {
      const otherContract = new Asset(
        'BTC',
        'GCWKWKBH3FSM32RILGJ7H2D3STVXQ36EZWTV7BSGVAZQWSN277YUN5KG'
      ).contractId(NETWORK_PASSPHRASE);
      expect(() => assertKnownEscrowToken(otherContract)).toThrow(/not a known SAC contract/);
    } finally {
      (config as unknown as Record<string, unknown>).ESCROW_ALLOWED_TOKENS = undefined;
    }
  });
});

describe('escrowCall.initialize / initialize_with_fee — token guard', () => {
  it('throws building initialize for an unknown token', () => {
    expect(() => escrowCall.initialize({ ...BASE_ARGS, token: EURC_CONTRACT })).toThrow(
      /not a known SAC contract/
    );
  });

  it('builds initialize for the default x402 asset', () => {
    const call = escrowCall.initialize({ ...BASE_ARGS, token: USDC_CONTRACT });
    expect(call.method).toBe('initialize');
  });

  it('throws building initialize_with_fee for an unknown token', () => {
    expect(() =>
      escrowCall.initialize_with_fee({
        ...BASE_ARGS,
        token: EURC_CONTRACT,
        feeBps: 100,
        feeRecipient: BASE_ARGS.arbiter,
      })
    ).toThrow(/not a known SAC contract/);
  });
});
