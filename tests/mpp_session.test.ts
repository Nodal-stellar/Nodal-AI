/**
 * tests/mpp_session.test.ts
 *
 * MPP Session channel expiry: `commitPayment` refuses payments once a channel
 * passes `timeoutAt`, and the sweeper is what actually moves those channels to
 * `Expired`, releases their spending reservation and alerts the operator.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { Asset, Keypair, Networks } from '@stellar/stellar-sdk';

vi.mock('../backend/config', () => ({
  MAINNET_SPENDING_CAP: 10_000,
  config: {
    STELLAR_NETWORK: 'testnet',
    AGENT_SPENDING_LIMIT: '100',
    STORAGE_BACKEND: 'sqlite',
    DB_PATH: ':memory:',
    PAUSED: false,
    MPP_SESSION_SWEEP_INTERVAL_MS: 1_000,
  },
}));

vi.mock('../backend/rpc_client', () => ({
  loadAccount: vi.fn(),
  prepareSorobanTx: vi.fn(),
  resolveNetworkPassphrase: vi.fn(() => 'Test SDF Network ; September 2015'),
}));

vi.mock('../backend/spending_tracker', () => ({
  spendingTracker: {
    reserve: vi.fn(),
    commit: vi.fn(),
    release: vi.fn(),
  },
  assetKeyForPaymentAsset: vi.fn((asset: string) => asset),
}));

vi.mock('../backend/webhook', () => ({
  dispatchWebhook: vi.fn(),
}));

import { _setDb } from '../backend/persistence';
import { _setStorage, getStorage } from '../backend/db/storage';
import {
  MppSessionClient,
  startMppSessionSweeper,
  sweepExpiredChannels,
} from '../backend/payments/mpp_session';
import { spendingTracker } from '../backend/spending_tracker';
import { dispatchWebhook } from '../backend/webhook';
import { clearNotifiers, registerNotifier } from '../backend/alerts';
import type { AlertEvent, Notifier } from '../backend/alerts';
import { KeypairSigner } from '../backend/signer';
import { _resetKillSwitch } from '../backend/kill_switch';

const TEST_SECRET = 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X';
const payerKp = Keypair.fromSecret(TEST_SECRET);
const RECIPIENT = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const XLM_SAC = Asset.native().contractId(Networks.TESTNET);
const T0 = new Date('2026-01-01T00:00:00.000Z');

const alerts: AlertEvent[] = [];
const testNotifier: Notifier = {
  name: 'test',
  notify: vi.fn(async (event: AlertEvent) => {
    alerts.push(event);
  }),
};

/** The sweeper's async work is all microtasks once the timer has fired. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('MPP session expiry sweeper', () => {
  let client: MppSessionClient;
  let reservationSeq: number;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    _setDb(new Database(':memory:'));
    _setStorage(null);
    _resetKillSwitch();
    clearNotifiers();
    registerNotifier(testNotifier);
    alerts.length = 0;

    reservationSeq = 0;
    vi.mocked(spendingTracker.reserve).mockImplementation(() => `res-${++reservationSeq}`);
    vi.mocked(spendingTracker.release).mockReset();

    client = new MppSessionClient(new KeypairSigner(payerKp));
  });

  afterEach(() => {
    _setDb(null);
  });

  it('marks a timed-out channel Expired, releases its reservation and alerts', async () => {
    const opened = await client.openChannel(RECIPIENT, XLM_SAC, '10000000', 60);
    expect(opened.reservationId).toBe('res-1');
    // The channel total is reserved under the paid asset's key.
    expect(spendingTracker.reserve).toHaveBeenCalledWith('1.0000000', XLM_SAC);

    // Not yet expired: the sweep is a no-op.
    expect(await sweepExpiredChannels()).toEqual([]);
    expect((await client.getChannel(opened.id))?.status).toBe('Active');
    expect(spendingTracker.release).not.toHaveBeenCalled();

    vi.setSystemTime(new Date(new Date(opened.timeoutAt).getTime() + 1));

    const expired = await sweepExpiredChannels();

    expect(expired.map((s) => s.id)).toEqual([opened.id]);
    const state = await client.getChannel(opened.id);
    expect(state?.status).toBe('Expired');
    expect(state?.closedAt).toBe(
      new Date(new Date(opened.timeoutAt).getTime() + 1).toISOString()
    );

    expect(spendingTracker.release).toHaveBeenCalledWith('res-1');
    expect(spendingTracker.release).toHaveBeenCalledTimes(1);
    expect(dispatchWebhook).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'mpp.channel_expired', channelId: opened.id })
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      type: 'channel_expired',
      severity: 'warning',
      details: expect.objectContaining({ channelId: opened.id }),
    });

    // Idempotent: a second sweep does not re-release or re-alert.
    expect(await sweepExpiredChannels()).toEqual([]);
    expect(spendingTracker.release).toHaveBeenCalledTimes(1);
    expect(alerts).toHaveLength(1);
  });

  it('sweeps an expired channel within one sweep interval', async () => {
    const opened = await client.openChannel(RECIPIENT, XLM_SAC, '10000000', 30);
    const stop = startMppSessionSweeper(1_000);
    try {
      await vi.advanceTimersByTimeAsync(29_000);
      await flushMicrotasks();
      expect((await client.getChannel(opened.id))?.status).toBe('Active');

      // The channel times out at T0+30s; the next 1s tick must catch it.
      await vi.advanceTimersByTimeAsync(2_000);
      await flushMicrotasks();
      expect((await client.getChannel(opened.id))?.status).toBe('Expired');
      expect(spendingTracker.release).toHaveBeenCalledWith('res-1');
    } finally {
      stop();
    }
  });

  it('does not touch channels that are already Closed', async () => {
    const opened = await client.openChannel(RECIPIENT, XLM_SAC, '10000000', 60);
    await client.closeChannel(opened.id);

    vi.setSystemTime(new Date(new Date(opened.timeoutAt).getTime() + 1));
    expect(await sweepExpiredChannels()).toEqual([]);

    const state = await client.getChannel(opened.id);
    expect(state?.status).toBe('Closed');
    expect(spendingTracker.release).not.toHaveBeenCalled();
  });

  it('still expires the channel when the reservation is already gone', async () => {
    const opened = await client.openChannel(RECIPIENT, XLM_SAC, '10000000', 60);
    vi.mocked(spendingTracker.release).mockImplementation(() => {
      throw new Error('No active reservation');
    });

    vi.setSystemTime(new Date(new Date(opened.timeoutAt).getTime() + 1));
    const expired = await sweepExpiredChannels();

    expect(expired.map((s) => s.id)).toEqual([opened.id]);
    expect((await client.getChannel(opened.id))?.status).toBe('Expired');
    expect(alerts).toHaveLength(1);
  });

  it('skips malformed session records without failing the sweep', async () => {
    await getStorage().saveMppSession('not-a-channel', 'not json');
    const opened = await client.openChannel(RECIPIENT, XLM_SAC, '10000000', 60);

    vi.setSystemTime(new Date(new Date(opened.timeoutAt).getTime() + 1));
    const expired = await sweepExpiredChannels();

    expect(expired.map((s) => s.id)).toEqual([opened.id]);
  });
});
