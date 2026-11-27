/**
 * tests/mpp_per_asset_limits.test.ts
 *
 * Issue: MPP session channels used to compare `parseFloat(amount)` against
 * AGENT_SPENDING_LIMIT and reserve under the default asset, bypassing the
 * per-asset SPENDING_LIMITS map (#733) and BigInt stroop accounting (#734).
 *
 * These tests run the real SpendingTracker against an in-memory database and
 * prove that `MppSessionClient.openChannel` enforces the limit of the asset
 * the channel actually pays in.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { Asset, Keypair, Networks } from '@stellar/stellar-sdk';

const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const USDC_KEY = `USDC:${USDC_ISSUER}`;

vi.mock('../backend/config', () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Asset: A, Networks: N } = require('@stellar/stellar-sdk'); // eslint-disable-line @typescript-eslint/no-var-requires
  // Literals, not the outer consts: vi.mock factories are hoisted.
  const issuer = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
  return {
    MAINNET_SPENDING_CAP: 10_000,
    config: {
      STELLAR_NETWORK: 'testnet',
      HORIZON_URL: 'https://horizon-testnet.stellar.org',
      SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
      AGENT_SPENDING_LIMIT: '1000',
      SPENDING_LIMITS_MAP: new Map<string, string>([
        ['XLM', '10'],
        [`USDC:${issuer}`, '5'],
      ]),
      SPENDING_LIMITS_ALLOW_UNKNOWN: false,
      SPENDING_WINDOW_MS: 86_400_000,
      STORAGE_BACKEND: 'sqlite',
      DB_PATH: ':memory:',
      PAUSED: false,
      X402_ASSET_CODE: 'USDC',
      X402_ASSET_ISSUER: issuer,
      X402_ASSET_CONTRACT: new A('USDC', issuer).contractId(N.TESTNET),
      // "XLM" lets the native SAC resolve to the 'XLM' spending key.
      X402_ALLOWED_ASSETS: `USDC:${issuer},XLM`,
    },
  };
});

vi.mock('../backend/rpc_client', () => ({
  loadAccount: vi.fn(),
  prepareSorobanTx: vi.fn(),
  resolveNetworkPassphrase: vi.fn(() => 'Test SDF Network ; September 2015'),
}));

import { _setDb } from '../backend/persistence';
import { _setStorage } from '../backend/db/storage';
import { MppSessionClient } from '../backend/payments/mpp_session';
import { spendingTracker } from '../backend/spending_tracker';
import { KeypairSigner } from '../backend/signer';
import { _resetKillSwitch } from '../backend/kill_switch';

const TEST_SECRET = 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X';
const payerKp = Keypair.fromSecret(TEST_SECRET);
const RECIPIENT = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const USDC_SAC = new Asset('USDC', USDC_ISSUER).contractId(Networks.TESTNET);
const XLM_SAC = Asset.native().contractId(Networks.TESTNET);
/** A SAC that is neither the default asset nor in X402_ALLOWED_ASSETS. */
const EURC_SAC = new Asset(
  'EURC',
  'GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2'
).contractId(Networks.TESTNET);

// openChannel takes the total in base units (7 decimals): '60000000' = 6.0.
const SIX = '60000000';
const FOUR = '40000000';
const ELEVEN = '110000000';
const NINE = '90000000';

describe('MPP session per-asset spending limits', () => {
  let client: MppSessionClient;

  beforeEach(() => {
    _setDb(new Database(':memory:'));
    _setStorage(null);
    _resetKillSwitch();
    spendingTracker._resetForTests();
    client = new MppSessionClient(new KeypairSigner(payerKp));
  });

  afterEach(() => {
    _setDb(null);
  });

  it('enforces the USDC per-asset limit, not the global one', async () => {
    // 6 USDC exceeds the USDC:… limit of 5 even though the global limit is 1000.
    await expect(client.openChannel(RECIPIENT, USDC_SAC, SIX, 60)).rejects.toThrow(
      /exceeds limit/
    );

    // 4 USDC is within the USDC limit and opens fine.
    const opened = await client.openChannel(RECIPIENT, USDC_SAC, FOUR, 60);
    expect(opened.status).toBe('Active');
    expect(spendingTracker.totalForAsset(USDC_KEY)).toBe(4n * 10_000_000n);
  });

  it('enforces the XLM per-asset limit independently of USDC', async () => {
    await client.openChannel(RECIPIENT, USDC_SAC, FOUR, 60);

    // 11 XLM exceeds the XLM limit of 10; the USDC reservation does not count.
    await expect(client.openChannel(RECIPIENT, XLM_SAC, ELEVEN, 60)).rejects.toThrow(
      /exceeds limit/
    );

    const opened = await client.openChannel(RECIPIENT, XLM_SAC, NINE, 60);
    expect(opened.status).toBe('Active');
    expect(spendingTracker.totalForAsset('XLM')).toBe(9n * 10_000_000n);
  });

  it('denies an asset that is not in SPENDING_LIMITS when unknown assets are off', async () => {
    await expect(client.openChannel(RECIPIENT, EURC_SAC, FOUR, 60)).rejects.toThrow(
      /not in the per-asset spending limits/
    );
  });
});
