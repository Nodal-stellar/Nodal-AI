/**
 * tests/x402_middleware.test.ts
 * Seller-side x402 middleware (`nodalPaywall`). The facilitator is a local
 * stub, so no network access is needed.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import * as http from 'http';
import type { AddressInfo } from 'net';
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
const facilitator = vi.hoisted(() => ({
  getSupported: () =>
    Promise.resolve({
      kinds: [{ x402Version: 2, scheme: 'exact', network: 'stellar:testnet' }],
      extensions: [],
      signers: {},
    }),
}));

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

let server: http.Server | undefined;
let handlerHits = 0;

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

describe('nodalPaywall method handling', () => {
  it.each(METHODS)('%s without payment → 402', async (method) => {
    const baseUrl = await startSeller();

    const res = await fetch(`${baseUrl}/paid`, { method });

    expect(res.status).toBe(402);
    expect(res.headers.get('payment-required')).toBeTruthy();
    expect(handlerHits).toBe(0);
  });
});
