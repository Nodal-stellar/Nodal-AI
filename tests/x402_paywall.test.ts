/**
 * tests/x402_paywall.test.ts
 * `nodalPaywall({ asset })` puts the configured asset into the 402 payment
 * requirements instead of falling back to the library default (#928).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Asset, Networks } from '@stellar/stellar-sdk';
import { nodalPaywall } from '../backend/x402/middleware';

const { paymentMiddlewareFromConfig } = vi.hoisted(() => ({
  paymentMiddlewareFromConfig: vi.fn().mockReturnValue(async () => {}),
}));

vi.mock('@x402/express', () => ({ paymentMiddlewareFromConfig }));
vi.mock('@x402/core/server', () => ({ HTTPFacilitatorClient: class {} }));
vi.mock('@x402/stellar/exact/server', () => ({ ExactStellarScheme: class {} }));

const EURC_ISSUER = 'GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2';
const EURC_CONTRACT = new Asset('EURC', EURC_ISSUER).contractId(Networks.TESTNET);
const PAY_TO = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

vi.mock('../backend/config', () => ({
  config: {
    STELLAR_NETWORK: 'testnet',
    AGENT_PUBLIC_KEY: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    X402_FACILITATOR_URL: 'https://facilitator.example.com',
    X402_FACILITATOR_API_KEY: undefined,
    X402_ASSET_CODE: 'USDC',
    X402_ASSET_ISSUER: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    X402_ASSET_CONTRACT: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
    X402_ALLOWED_ASSETS: 'EURC:GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2',
  },
}));

/** The payment option nodalPaywall handed to @x402/express. */
function acceptsFromLastCall(): Record<string, unknown> {
  const routes = paymentMiddlewareFromConfig.mock.calls.at(-1)![0];
  return routes['GET *'].accepts;
}

describe('nodalPaywall asset (#928)', () => {
  beforeEach(() => {
    paymentMiddlewareFromConfig.mockClear();
  });

  it('puts the configured asset contract into the payment requirements', () => {
    nodalPaywall({ price: '0.01', asset: 'EURC', payTo: PAY_TO });

    expect(acceptsFromLastCall().price).toEqual({ amount: '100000', asset: EURC_CONTRACT });
  });

  it('defaults to X402_ASSET_CONTRACT when no asset is given', () => {
    nodalPaywall({ price: '0.5', payTo: PAY_TO });

    expect(acceptsFromLastCall().price).toEqual({
      amount: '5000000',
      asset: 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75',
    });
  });

  it('charges native XLM through its asset contract', () => {
    nodalPaywall({ price: '2', asset: 'XLM', payTo: PAY_TO });

    expect(acceptsFromLastCall().price).toEqual({
      amount: '20000000',
      asset: Asset.native().contractId(Networks.TESTNET),
    });
  });

  it('rejects an asset the agent is not configured for', () => {
    expect(() => nodalPaywall({ price: '0.01', asset: 'BTC', payTo: PAY_TO })).toThrow(
      /unknown asset "BTC"/
    );
    expect(paymentMiddlewareFromConfig).not.toHaveBeenCalled();
  });
});
