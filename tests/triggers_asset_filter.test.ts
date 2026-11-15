/**
 * tests/triggers_asset_filter.test.ts
 * Tests for trigger asset issuer validation and BigInt amount matching (#940)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { _setDb } from '../backend/persistence';

const { mockStopStream, mockStream, mockForAccount, mockPayments } = vi.hoisted(() => {
  const mockStopStream = vi.fn();
  const mockStream = vi.fn(() => mockStopStream);
  const mockForAccount = vi.fn(() => ({ stream: mockStream }));
  const mockPayments = vi.fn(() => ({ forAccount: mockForAccount }));
  return { mockStopStream, mockStream, mockForAccount, mockPayments };
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
import { TriggerManager, matchesFilter } from '../backend/triggers';

const REAL_USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const FAKE_USDC_ISSUER = 'GDVEU3DD4KOFECV66VIHWEZOYX4ZKR3WV27L464SIIPOU2IUI3JCZA57';

describe('Trigger asset filter & BigInt amount comparison (#940)', () => {
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

    agent = new PayFiAgent();
  });

  afterEach(() => {
    agent.destroy();
  });

  it('rejects creating a non-native trigger without an assetIssuer', async () => {
    const manager = new TriggerManager(agent);

    await expect(
      manager.createTrigger({
        source: 'payment',
        filter: { assetCode: 'USDC' },
        task: { type: 'balance_check', payload: {} },
      })
    ).rejects.toThrow(/assetIssuer/);
  });

  it('rejects creating a non-native trigger with an invalid assetIssuer', async () => {
    const manager = new TriggerManager(agent);

    await expect(
      manager.createTrigger({
        source: 'payment',
        filter: { assetCode: 'USDC', assetIssuer: 'GNOTVALID' },
        task: { type: 'balance_check', payload: {} },
      })
    ).rejects.toThrow(/assetIssuer/);
  });

  it('allows creating a native XLM trigger without an assetIssuer', async () => {
    const manager = new TriggerManager(agent);

    const trigger = await manager.createTrigger({
      source: 'payment',
      filter: { assetCode: 'XLM', minAmount: '10' },
      task: { type: 'balance_check', payload: {} },
    });

    expect(trigger.filter.assetCode).toBe('XLM');
  });

  it('does not fire when incoming asset has the same code but a different issuer', async () => {
    let capturedOpts: Record<string, (...args: unknown[]) => Promise<void> | void> = {};
    (mockStream as ReturnType<typeof vi.fn>).mockImplementationOnce(
      (opts: Record<string, (...args: unknown[]) => Promise<void> | void>) => {
        capturedOpts = opts;
        return mockStopStream;
      }
    );

    const runSpy = vi.spyOn(agent, 'run').mockResolvedValue({
      success: true,
      taskType: 'balance_check',
    });

    const manager = new TriggerManager(agent);
    await manager.start();
    await manager.createTrigger({
      source: 'payment',
      filter: {
        assetCode: 'USDC',
        assetIssuer: REAL_USDC_ISSUER,
        minAmount: '5.0000000',
      },
      task: { type: 'balance_check', payload: {} },
    });

    // 1. Incoming fake USDC (wrong issuer) -> must NOT fire
    const fakeChallenge = {
      resource: 'https://api.example.com/data',
      amount: '500.0000000',
      assetCode: 'USDC',
      assetIssuer: FAKE_USDC_ISSUER,
      payTo: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      nonce: '550e8400-e29b-41d4-a716-446655440001',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await capturedOpts['onmessage']?.({
      memo: `x402:${Buffer.from(JSON.stringify(fakeChallenge)).toString('base64')}`,
    });
    expect(runSpy).not.toHaveBeenCalled();

    // 2. Incoming real USDC (matching issuer & amount >= minAmount) -> fires
    const realChallenge = {
      ...fakeChallenge,
      assetIssuer: REAL_USDC_ISSUER,
      nonce: '550e8400-e29b-41d4-a716-446655440002',
    };
    await capturedOpts['onmessage']?.({
      memo: `x402:${Buffer.from(JSON.stringify(realChallenge)).toString('base64')}`,
    });
    await vi.waitFor(() => expect(runSpy).toHaveBeenCalledOnce());
  });

  it('compares minAmount with exact BigInt stroop arithmetic instead of parseFloat', () => {
    const filter = {
      assetCode: 'USDC',
      assetIssuer: REAL_USDC_ISSUER,
      minAmount: '10.0000002',
    };

    expect(
      matchesFilter(
        {
          assetCode: 'USDC',
          assetIssuer: REAL_USDC_ISSUER,
          amount: '10.0000001',
        },
        filter
      )
    ).toBe(false);

    expect(
      matchesFilter(
        {
          assetCode: 'USDC',
          assetIssuer: REAL_USDC_ISSUER,
          amount: '10.0000002',
        },
        filter
      )
    ).toBe(true);

    // Reject scientific notation or malformed strings that parseFloat would coerce
    expect(
      matchesFilter(
        {
          assetCode: 'USDC',
          assetIssuer: REAL_USDC_ISSUER,
          amount: '1e2',
        },
        filter
      )
    ).toBe(false);
  });
});
