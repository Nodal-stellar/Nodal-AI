/**
 * tests/x402_middleware.test.ts
 * Seller-side x402 middleware (`nodalPaywall`): 402 shape, facilitator
 * verify/settle, method handling and asset selection. The facilitator is a
 * local stub, so no network access is needed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import express from 'express';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { FacilitatorResponseError } from '@x402/core/server';
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from '@x402/core/http';
import { nodalPaywall, type NodalPaywallOptions } from '../backend/x402/middleware';

vi.mock('../backend/config', () => ({
  config: {
    STELLAR_NETWORK: 'testnet',
    AGENT_PUBLIC_KEY: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    X402_FACILITATOR_URL: 'https://facilitator.test',
    X402_FACILITATOR_API_KEY: undefined,
    X402_ASSET_CODE: 'USDC',
    X402_ASSET_ISSUER: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
  },
}));

/** Stub facilitator standing in for HTTPFacilitatorClient. */
const facilitator = vi.hoisted(() => {
  const stub = {
    verifyResult: { isValid: true, payer: 'GDPAYER' } as {
      isValid: boolean;
      payer?: string;
      invalidReason?: string;
    },
    verifyCalls: 0,
    settleCalls: 0,
    reset() {
      stub.verifyResult = { isValid: true, payer: 'GDPAYER' };
      stub.verifyCalls = 0;
      stub.settleCalls = 0;
    },
    getSupported() {
      return Promise.resolve({
        kinds: [{ x402Version: 2, scheme: 'exact', network: 'stellar:testnet' }],
        extensions: [],
        signers: {},
      });
    },
    verify() {
      stub.verifyCalls++;
      return Promise.resolve(stub.verifyResult);
    },
    settle() {
      stub.settleCalls++;
      return Promise.resolve({
        success: true,
        transaction: 'stub-transaction-hash',
        network: 'stellar:testnet',
        payer: 'GDPAYER',
      });
    },
  };
  return stub;
});

vi.mock('@x402/core/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@x402/core/server')>();
  return {
    ...actual,
    HTTPFacilitatorClient: class {
      constructor() {
        return facilitator;
      }
    },
  };
});

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
const DEFAULT_PAY_TO = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
/** USDC Stellar Asset Contract on testnet (the scheme's default USDC asset). */
const USDC_TESTNET_SAC = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';

let server: http.Server | undefined;
let handlerHits = 0;

beforeEach(() => {
  facilitator.reset();
});

afterEach(async () => {
  handlerHits = 0;
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
});

/** A seller with one paid route answering every method. */
async function startSeller(options: Partial<NodalPaywallOptions> = {}): Promise<string> {
  const app = express();
  app.all('/paid', nodalPaywall({ price: '0.01', ...options }), (req, res) => {
    handlerHits++;
    res.json({ ok: true, method: req.method });
  });
  server = http.createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
}

interface PaymentRequirement {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
}

/** Fetch the route unpaid and decode the PAYMENT-REQUIRED header. */
async function readRequirements(baseUrl: string, method = 'GET') {
  const res = await fetch(`${baseUrl}/paid`, { method });
  const header = res.headers.get('payment-required');
  expect(header).toBeTruthy();
  const required = decodePaymentRequiredHeader(header!) as unknown as {
    x402Version: number;
    resource: unknown;
    accepts: PaymentRequirement[];
  };
  return { res, required };
}

/** Build a PAYMENT-SIGNATURE header that accepts the seller's first requirement. */
async function paymentHeaderFor(baseUrl: string, method: string): Promise<string> {
  const { required } = await readRequirements(baseUrl, method);
  return encodePaymentSignatureHeader({
    x402Version: 2,
    resource: required.resource,
    accepted: required.accepts[0],
    payload: { transaction: 'stub-signed-auth-entry' },
  } as unknown as Parameters<typeof encodePaymentSignatureHeader>[0]);
}

describe('nodalPaywall method handling', () => {
  it.each(METHODS)('%s without payment → 402', async (method) => {
    const baseUrl = await startSeller();

    const res = await fetch(`${baseUrl}/paid`, { method });

    expect(res.status).toBe(402);
    expect(res.headers.get('payment-required')).toBeTruthy();
    expect(handlerHits).toBe(0);
  });

  it.each(METHODS)('%s with a valid payment → 200 and settles', async (method) => {
    const baseUrl = await startSeller();
    const payment = await paymentHeaderFor(baseUrl, method);

    const res = await fetch(`${baseUrl}/paid`, {
      method,
      headers: { 'PAYMENT-SIGNATURE': payment },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, method });
    expect(res.headers.get('payment-response')).toBeTruthy();
    expect(facilitator.verifyCalls).toBe(1);
    expect(facilitator.settleCalls).toBe(1);
    expect(handlerHits).toBe(1);
  });
});

describe('nodalPaywall 402 response', () => {
  it('advertises the exact Stellar scheme, price, network and payTo', async () => {
    const baseUrl = await startSeller();

    const { res, required } = await readRequirements(baseUrl);

    expect(res.status).toBe(402);
    expect(required.x402Version).toBe(2);
    expect(required.accepts).toHaveLength(1);
    expect(required.accepts[0]).toMatchObject({
      scheme: 'exact',
      network: 'stellar:testnet',
      // 0.01 at 7 decimals
      amount: '100000',
      asset: USDC_TESTNET_SAC,
      payTo: DEFAULT_PAY_TO,
    });
  });

  it('uses the payTo option when given', async () => {
    const payTo = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
    const baseUrl = await startSeller({ payTo });

    const { required } = await readRequirements(baseUrl);

    expect(required.accepts[0]?.payTo).toBe(payTo);
  });

  it.each([
    ['the configured asset', {}],
    ['an explicit USDC asset option', { asset: 'USDC' }],
  ])('charges in USDC with %s', async (_label, options) => {
    const baseUrl = await startSeller(options);

    const { required } = await readRequirements(baseUrl);

    expect(required.accepts[0]?.asset).toBe(USDC_TESTNET_SAC);
  });

  it('rejects an invalid price at creation', () => {
    expect(() => nodalPaywall({ price: '0' })).toThrow(/price/);
  });
});

describe('nodalPaywall facilitator handling', () => {
  it('returns 402 and does not settle when the facilitator rejects the payment', async () => {
    const baseUrl = await startSeller();
    const payment = await paymentHeaderFor(baseUrl, 'POST');
    facilitator.verifyResult = { isValid: false, invalidReason: 'invalid_signature' };

    const res = await fetch(`${baseUrl}/paid`, {
      method: 'POST',
      headers: { 'PAYMENT-SIGNATURE': payment },
    });

    expect(res.status).toBe(402);
    expect(facilitator.verifyCalls).toBe(1);
    expect(facilitator.settleCalls).toBe(0);
    expect(handlerHits).toBe(0);
  });

  it('returns 402 for a payment that does not match the requirements', async () => {
    const baseUrl = await startSeller();
    const { required } = await readRequirements(baseUrl, 'POST');
    const payment = encodePaymentSignatureHeader({
      x402Version: 2,
      resource: required.resource,
      accepted: { ...required.accepts[0], amount: '1' },
      payload: { transaction: 'stub-signed-auth-entry' },
    } as unknown as Parameters<typeof encodePaymentSignatureHeader>[0]);

    const res = await fetch(`${baseUrl}/paid`, {
      method: 'POST',
      headers: { 'PAYMENT-SIGNATURE': payment },
    });

    expect(res.status).toBe(402);
    expect(facilitator.verifyCalls).toBe(0);
    expect(handlerHits).toBe(0);
  });

  it('returns 502 when the facilitator is down', async () => {
    const original = facilitator.getSupported;
    facilitator.getSupported = () =>
      Promise.reject(new FacilitatorResponseError('facilitator unreachable'));
    try {
      const baseUrl = await startSeller();

      const res = await fetch(`${baseUrl}/paid`, { method: 'POST' });

      expect(res.status).toBe(502);
      expect(handlerHits).toBe(0);
    } finally {
      facilitator.getSupported = original;
    }
  });
});
