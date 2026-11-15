/**
 * tests/triggers.test.ts
 * Tests for TriggerManager listener lifecycle and isolation (#943)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { _setDb } from '../backend/persistence';

const {
  mockStopStream,
  mockStream,
  mockForAccount,
  mockPayments,
  mockStopContractListener,
  mockListenContractEvents,
  mockStopStorageWatcher,
  mockWatchContractStorage,
} = vi.hoisted(() => {
  const mockStopStream = vi.fn();
  const mockStream = vi.fn(() => mockStopStream);
  const mockForAccount = vi.fn(() => ({ stream: mockStream }));
  const mockPayments = vi.fn(() => ({ forAccount: mockForAccount }));
  const mockStopContractListener = vi.fn();
  const mockListenContractEvents = vi.fn(() => mockStopContractListener);
  const mockStopStorageWatcher = vi.fn();
  const mockWatchContractStorage = vi.fn(() => ({
    on: vi.fn(),
    stop: mockStopStorageWatcher,
  }));
  return {
    mockStopStream,
    mockStream,
    mockForAccount,
    mockPayments,
    mockStopContractListener,
    mockListenContractEvents,
    mockStopStorageWatcher,
    mockWatchContractStorage,
  };
});

vi.mock('../backend/rpc_client', () => ({
  loadAccount: vi.fn(),
  submitTransaction: vi.fn(),
  simulateSorobanTx: vi.fn(),
  prepareSorobanTx: vi.fn(),
  horizonServer: { payments: mockPayments },
  sorobanServer: {},
  resolveNetworkPassphrase: vi.fn(() => 'Test SDF Network ; September 2015'),
}));

vi.mock('../backend/contract_event_listener', () => ({
  listenContractEvents: mockListenContractEvents,
}));

vi.mock('../backend/contract_storage_watcher', () => ({
  watchContractStorage: mockWatchContractStorage,
}));

vi.mock('../backend/config', () => ({
  config: {
    STELLAR_NETWORK: 'testnet',
    HORIZON_URL: 'https://horizon-testnet.stellar.org',
    SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
    AGENT_PUBLIC_KEY: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    X402_ASSET_CODE: 'USDC',
    X402_ASSET_ISSUER: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
    MAX_RETRIES: 3,
    RETRY_DELAY_MS: 100,
    AGENT_SPENDING_LIMIT: '100',
    SIGNER_BACKEND: 'local',
    agentKeypair: () => ({
      publicKey: () => 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      secret: () => 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X',
    }),
  },
  MAINNET_SPENDING_CAP: 10_000,
}));

import { PayFiAgent } from '../backend/agent';
import { TriggerManager } from '../backend/triggers';

describe('TriggerManager.stop() listener isolation (#943)', () => {
  let agent: PayFiAgent;
  let db: Database.Database;

  beforeEach(() => {
    vi.clearAllMocks();
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE IF NOT EXISTS triggers (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        filter TEXT NOT NULL,
        task TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        last_fired_at TEXT
      );
      CREATE TABLE IF NOT EXISTS trigger_events (
        key TEXT PRIMARY KEY,
        fired_at TEXT NOT NULL
      );
    `);
    _setDb(db);

    mockStream.mockReturnValue(mockStopStream);
    mockForAccount.mockReturnValue({ stream: mockStream });
    mockPayments.mockReturnValue({ forAccount: mockForAccount });
    mockListenContractEvents.mockReturnValue(mockStopContractListener);
    mockWatchContractStorage.mockReturnValue({
      on: vi.fn(),
      stop: mockStopStorageWatcher,
    });

    agent = new PayFiAgent();
  });

  afterEach(() => {
    agent.destroy();
  });

  it('keeps application payment, contract, and storage listeners running after TriggerManager.stop()', async () => {
    let capturedOpts: Record<string, (...args: unknown[]) => void> = {};
    (mockStream as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (opts: Record<string, (...args: unknown[]) => void>) => {
        capturedOpts = opts;
        return mockStopStream;
      }
    );

    const appChallengeListener = vi.fn();
    agent.startListening('https://app.example.com/resource', appChallengeListener);
    agent.startContractListener(
      'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
      ['transfer'],
      vi.fn()
    );
    agent.startStorageWatcher(
      {
        contractId: 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC',
        keys: ['AAAA'],
      },
      vi.fn()
    );

    const manager = new TriggerManager(agent);
    await manager.start();

    const runSpy = vi.spyOn(agent, 'run').mockResolvedValue({
      success: true,
      taskType: 'balance_check',
    });
    await manager.createTrigger({
      source: 'payment',
      filter: { assetCode: 'USDC' },
      task: { type: 'balance_check', payload: {} },
    });

    // Stop the TriggerManager — application listeners must stay active
    manager.stop();

    expect(mockStopStream).not.toHaveBeenCalled();
    expect(mockStopContractListener).not.toHaveBeenCalled();
    expect(mockStopStorageWatcher).not.toHaveBeenCalled();

    // Emit an incoming x402 payment event after TriggerManager.stop()
    const challenge = {
      resource: 'https://app.example.com/resource',
      amount: '5',
      assetCode: 'USDC',
      assetIssuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      payTo: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      nonce: '550e8400-e29b-41d4-a716-446655440099',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    const memo = `x402:${Buffer.from(JSON.stringify(challenge)).toString('base64')}`;
    capturedOpts['onmessage']?.({ memo });

    // App listener still receives the event, while TriggerManager does not fire
    expect(appChallengeListener).toHaveBeenCalledOnce();
    expect(appChallengeListener).toHaveBeenCalledWith(challenge);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('closes the Horizon payment stream when TriggerManager was the only subscriber', async () => {
    const manager = new TriggerManager(agent);
    await manager.start();

    expect(mockStream).toHaveBeenCalledOnce();
    expect(mockStopStream).not.toHaveBeenCalled();

    manager.stop();

    expect(mockStopStream).toHaveBeenCalledOnce();
  });
});
