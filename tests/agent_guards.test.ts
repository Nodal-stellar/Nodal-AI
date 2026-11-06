/**
 * tests/agent_guards.test.ts
 *
 * Pins what PayFiAgent's guards actually do: which amount and asset a task is
 * charged, what gets held for approval, what reaches the audit log, and what is
 * stripped from errors and logged payloads. The mutation run (npm run
 * test:mutation) showed these could all be broken without a test noticing.
 *
 * Tools are replaced on the agent instance rather than mocked per module, so
 * the guards run for real in front of a stub.
 */

import { createHash } from 'crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import {
  PayFiAgent,
  VALUE_MOVING_TASK_TYPES,
  spendingTracker,
  type AgentTask,
} from '../backend/agent';
import { failureAlerts } from '../backend/alerts';
import { config } from '../backend/config';
import { ErrorType, ValidationError } from '../backend/errors';
import {
  appendAuditEntry,
  decideApproval,
  expirePendingApprovals,
  getIdempotencyResult,
  getPendingApproval,
  listPendingApprovals,
  pruneIdempotencyKeys,
  saveIdempotencyResult,
  savePendingApproval,
  saveResult,
} from '../backend/persistence';
import { StellarRPCError } from '../backend/rpc_client';
import { assetKey } from '../backend/spending_tracker';
import { dispatchWebhook } from '../backend/webhook';

const { log } = vi.hoisted(() => {
  const log: Record<string, ReturnType<typeof vi.fn>> = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
  log.child!.mockReturnValue(log);
  return { log };
});

vi.mock('../backend/utils/logger', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../backend/utils/logger')>()),
  logger: log,
  createLogger: () => log,
}));

vi.mock('../backend/persistence', () => ({
  getDb: vi.fn(() => ({})),
  saveResult: vi.fn(),
  saveTrackedSpendingRecord: vi.fn(),
  deleteTrackedSpendingRecord: vi.fn(),
  clearSpendingRecords: vi.fn(),
  getSpendingRecordsSince: vi.fn(() => []),
  pruneSpendingRecords: vi.fn(),
  loadRecentSpend: vi.fn(() => 0),
  appendAuditEntry: vi.fn(),
  savePendingApproval: vi.fn(),
  getPendingApproval: vi.fn(),
  listPendingApprovals: vi.fn(() => []),
  decideApproval: vi.fn(() => true),
  expirePendingApprovals: vi.fn(() => []),
  getIdempotencyResult: vi.fn(),
  saveIdempotencyResult: vi.fn(),
  pruneIdempotencyKeys: vi.fn(),
}));

vi.mock('../backend/webhook', () => ({ dispatchWebhook: vi.fn() }));

vi.mock('../backend/config', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Keypair } = require('@stellar/stellar-sdk');
  const secret = Keypair.random().secret();
  return {
    config: {
      STELLAR_NETWORK: 'testnet',
      HORIZON_URL: 'https://horizon-testnet.stellar.org',
      SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
      AGENT_PUBLIC_KEY: Keypair.fromSecret(secret).publicKey(),
      X402_ASSET_CODE: 'USDC',
      X402_ASSET_ISSUER: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      MAX_RETRIES: 3,
      RETRY_DELAY_MS: 100,
      AGENT_SPENDING_LIMIT: '1000',
      SPENDING_LIMITS_MAP: new Map<string, string>(),
      SPENDING_LIMITS_ALLOW_UNKNOWN: true,
      SPENDING_WINDOW_MS: 86_400_000,
      QUEUE_CAPACITY: 0,
      MAX_CONCURRENT_TASKS: 10,
      PAYMENT_DESTINATION_POLICY: 'open',
      PAYMENT_DESTINATIONS: [],
      agentKeypair: () => Keypair.fromSecret(secret),
    },
    MAINNET_SPENDING_CAP: 10_000,
  };
});

const DEST = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const USDC = `USDC:${ISSUER}`;
// A syntactically valid Stellar secret; never a real account.
const SECRET = 'SADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQP54X';

const mutableConfig = config as unknown as Record<string, unknown>;

const TOOL_FIELDS = {
  stellar_payment: ['paymentTool', 'execute'],
  x402_respond: ['x402Tool', 'respond'],
  multisig_payment: ['multiSigTool', 'execute'],
  batch_payment: ['batchPaymentTool', 'execute'],
  path_payment: ['pathPaymentTool', 'execute'],
  dex_offer: ['dexOfferTool', 'execute'],
  account_info: ['accountInfoTool', 'fetch'],
  friendbot: ['friendBotTool', 'execute'],
} as const;

describe('PayFiAgent guards', () => {
  let agent: PayFiAgent;

  /** Replace a built-in tool on this agent with a stub and return the stub's method. */
  function stubTool(
    type: keyof typeof TOOL_FIELDS,
    result: unknown = { txHash: 'hash', ledger: 1 }
  ) {
    const [field, method] = TOOL_FIELDS[type];
    const fn = vi.fn().mockResolvedValue(result);
    (agent as unknown as Record<string, unknown>)[field] = { [method]: fn };
    return fn;
  }

  function stubAllTools() {
    for (const type of Object.keys(TOOL_FIELDS) as (keyof typeof TOOL_FIELDS)[]) stubTool(type);
  }

  /** The (amount, assetKey) pairs a task reserved against the spending window. */
  async function spendsOf(task: unknown): Promise<unknown[][]> {
    const reserve = vi.spyOn(spendingTracker, 'reserve');
    await agent.run(task as AgentTask);
    return reserve.mock.calls;
  }

  const failingPayment = (error: unknown, payload: unknown = { amount: '1' }) => {
    stubTool('stellar_payment').mockRejectedValue(error);
    return agent.run({ type: 'stellar_payment', payload } as AgentTask);
  };

  beforeEach(() => {
    spendingTracker.clear();
    vi.mocked(getPendingApproval).mockReset();
    vi.mocked(getIdempotencyResult).mockReset();
    vi.mocked(decideApproval).mockReset().mockReturnValue(true);
    vi.mocked(expirePendingApprovals).mockReset().mockReturnValue([]);
    vi.mocked(listPendingApprovals).mockReset().mockReturnValue([]);
    vi.mocked(savePendingApproval).mockReset();
    vi.mocked(appendAuditEntry).mockReset();
    vi.mocked(pruneIdempotencyKeys).mockReset();
    log.child!.mockReturnValue(log);
    agent = new PayFiAgent();
    stubAllTools();
    vi.clearAllMocks();
  });

  afterEach(() => {
    agent.destroy();
    mutableConfig.STELLAR_NETWORK = 'testnet';
    mutableConfig.AGENT_SPENDING_LIMIT = '1000';
    mutableConfig.QUEUE_CAPACITY = 0;
    mutableConfig.MAX_CONCURRENT_TASKS = 10;
    mutableConfig.PAYMENT_DESTINATION_POLICY = 'open';
    mutableConfig.PAYMENT_DESTINATIONS = [];
    (config.SPENDING_LIMITS_MAP as Map<string, string>).clear();
    delete mutableConfig.APPROVAL_THRESHOLD;
    delete mutableConfig.APPROVAL_TTL_MS;
  });

  describe('secret redaction in errors', () => {
    it('replaces only the secret and keeps the rest of the message', async () => {
      const result = await failingPayment(new Error(`bad key "${SECRET}" in request`));
      expect(result.error).toBe('bad key "[REDACTED]" in request');
    });

    it('redacts every secret in a message, not just the first', async () => {
      const result = await failingPayment(new Error(`a ${SECRET} b ${SECRET}`));
      expect(result.error).toBe('a [REDACTED] b [REDACTED]');
    });

    it('redacts a secret on a later line of a multi-line message', async () => {
      const result = await failingPayment(new Error(`first line\nkey ${SECRET}\nlast line`));
      expect(result.error).toBe('first line\nkey [REDACTED]\nlast line');
    });

    it('leaves ordinary text alone', async () => {
      const message = 'transaction simulation failed because the network was unavailable today';
      const result = await failingPayment(new Error(message));
      expect(result.error).toBe(message);
    });

    it('redacts the task log line, the task:failed event and the persisted result', async () => {
      const failed = vi.fn();
      agent.on('task:failed', failed);

      await failingPayment(new Error(`oops ${SECRET}`));

      expect(failed.mock.calls[0]![0].error).toBe('oops [REDACTED]');
      expect(vi.mocked(saveResult).mock.calls[0]![0].error).toBe('oops [REDACTED]');
      expect(JSON.stringify(log.error!.mock.calls)).not.toContain(SECRET);
    });

    it('redacts middleware failures too', async () => {
      agent.use(async () => {
        throw new Error(`middleware ${SECRET}`);
      });

      const result = await agent.run({ type: 'stellar_payment', payload: {} } as AgentTask);

      expect(result.error).toBe('middleware [REDACTED]');
      expect(JSON.stringify(log.error!.mock.calls)).not.toContain(SECRET);
    });

    it('redacts unhandled "error" events before logging them', () => {
      agent.emit('error', new Error(`boom ${SECRET} and ${SECRET}`));

      expect(log.error).toHaveBeenCalledWith(
        { error: 'boom [REDACTED] and [REDACTED]' },
        'Unhandled agent error'
      );
    });
  });

  describe('error descriptions', () => {
    it('stringifies a thrown non-Error', async () => {
      expect((await failingPayment('plain string failure')).error).toBe('plain string failure');
    });

    it('appends a structured cause as JSON context', async () => {
      const result = await failingPayment(new ValidationError('rejected', { signer: 'GABC' }));
      expect(result.error).toBe('rejected | context: {"signer":"GABC"}');
      expect(result.errorType).toBe(ErrorType.ValidationError);
    });

    it('keeps the bare message when the cause does not serialise to a string', async () => {
      const result = await failingPayment(new ValidationError('rejected', () => undefined));
      expect(result.error).toBe('rejected');
    });

    it('keeps the bare message when the cause is circular', async () => {
      const cause: Record<string, unknown> = {};
      cause.self = cause;
      // sanitizeCause recurses, so a circular cause overflows the stack and has
      // to land in the same catch as a JSON.stringify failure.
      const result = await failingPayment(new ValidationError('rejected', cause));
      expect(result.error).toBe('rejected');
    });
  });

  describe('logged payload sanitisation', () => {
    const loggedPayload = () => {
      const call = log.error!.mock.calls.find(([, msg]) => msg === 'Task failed');
      return (call![0] as { sanitizedPayload: unknown }).sanitizedPayload;
    };

    it('drops every sensitive key at any depth and keeps everything else', async () => {
      await failingPayment(new Error('x'), {
        amount: '1',
        memo: null,
        ' secretKey ': 'a',
        API_KEY: 'b',
        seedPhrase: 'c',
        mnemonic: 'd',
        privateValue: 'e',
        ' spaced ': 'kept',
        nested: {
          signer: { secretKey: 'f', address: 'GX' },
          list: [{ privateKey: 'g', ok: 1 }, 'text', null, 7],
        },
      });

      expect(loggedPayload()).toEqual({
        amount: '1',
        memo: null,
        spaced: 'kept',
        nested: { signer: { address: 'GX' }, list: [{ ok: 1 }, 'text', null, 7] },
      });
    });

    it('passes primitive and null payloads through unchanged', async () => {
      await failingPayment(new Error('x'), 'just text');
      expect(loggedPayload()).toBe('just text');

      log.error!.mockClear();
      await failingPayment(new Error('x'), null);
      expect(loggedPayload()).toBeNull();
    });

    it('sanitises an array payload element by element', async () => {
      await failingPayment(new Error('x'), [{ seed: 'a', b: 1 }]);
      expect(loggedPayload()).toEqual([{ b: 1 }]);
    });

    it('sanitises the payload when middleware throws', async () => {
      agent.use(async () => {
        throw new Error('nope');
      });
      await agent.run({
        type: 'stellar_payment',
        payload: { secretKey: 'a', amount: '1' },
      } as AgentTask);
      expect(loggedPayload()).toEqual({ amount: '1' });
    });
  });

  describe('what each task is charged', () => {
    it('stellar_payment defaults to XLM and uses a named asset otherwise', async () => {
      expect(await spendsOf({ type: 'stellar_payment', payload: { amount: '5' } })).toEqual([
        ['5', 'XLM'],
      ]);
      vi.restoreAllMocks();
      expect(
        await spendsOf({
          type: 'stellar_payment',
          payload: { amount: '5', assetCode: 'USDC', assetIssuer: ISSUER },
        })
      ).toEqual([['5', USDC]]);
    });

    it('ignores non-string asset fields and a non-string amount', async () => {
      expect(
        await spendsOf({
          type: 'stellar_payment',
          payload: { amount: '5', assetCode: 7, assetIssuer: 7 },
        })
      ).toEqual([['5', 'XLM']]);
      vi.restoreAllMocks();
      expect(await spendsOf({ type: 'stellar_payment', payload: { amount: 5 } })).toEqual([]);
    });

    it('x402_respond defaults to the configured settlement asset', async () => {
      expect(await spendsOf({ type: 'x402_respond', payload: { amount: '2' } })).toEqual([
        ['2', assetKey(config.X402_ASSET_CODE, config.X402_ASSET_ISSUER)],
      ]);
      vi.restoreAllMocks();
      expect(
        await spendsOf({
          type: 'x402_respond',
          payload: { amount: '2', assetCode: 'EURC', assetIssuer: ISSUER },
        })
      ).toEqual([['2', `EURC:${ISSUER}`]]);
    });

    it('multisig_payment is charged only once it has enough signatures', async () => {
      const multisig = (extra: object) => ({
        type: 'multisig_payment',
        payload: { amount: '3', ...extra },
      });

      expect(await spendsOf(multisig({}))).toEqual([]);
      vi.restoreAllMocks();
      expect(await spendsOf(multisig({ signatures: 'nope' }))).toEqual([]);
      vi.restoreAllMocks();
      expect(await spendsOf(multisig({ signatures: ['a'], minSignatures: 2 }))).toEqual([]);
      vi.restoreAllMocks();
      expect(await spendsOf(multisig({ signatures: ['a'] }))).toEqual([['3', 'XLM']]);
      vi.restoreAllMocks();
      expect(
        await spendsOf(
          multisig({
            signatures: ['a', 'b'],
            minSignatures: 2,
            assetCode: 'USDC',
            assetIssuer: ISSUER,
          })
        )
      ).toEqual([['3', USDC]]);
    });

    it('batch_payment sums per asset and skips unusable entries', async () => {
      expect(
        await spendsOf({
          type: 'batch_payment',
          payload: {
            payments: [
              { amount: '0.1' },
              { amount: '0.2' },
              { amount: '4', assetCode: 'USDC', assetIssuer: ISSUER },
              { amount: 9 },
              { amount: 'not-a-number' },
              null,
            ],
          },
        })
      ).toEqual([
        ['0.3000000', 'XLM'],
        ['4.0000000', USDC],
      ]);
      vi.restoreAllMocks();
      expect(await spendsOf({ type: 'batch_payment', payload: { payments: 'x' } })).toEqual([]);
    });

    it('path_payment is charged the send amount in the send asset', async () => {
      expect(
        await spendsOf({
          type: 'path_payment',
          payload: { sendAmount: '6', amount: '99', sendAsset: { code: 'USDC', issuer: ISSUER } },
        })
      ).toEqual([['6', USDC]]);
      vi.restoreAllMocks();
      expect(await spendsOf({ type: 'path_payment', payload: { sendAmount: '6' } })).toEqual([
        ['6', 'XLM'],
      ]);
      vi.restoreAllMocks();
      expect(
        await spendsOf({
          type: 'path_payment',
          payload: { sendAmount: '6', sendAsset: { code: 1, issuer: 1 } },
        })
      ).toEqual([['6', 'XLM']]);
    });

    it('dex_offer is charged the selling asset, except when deleting (amount 0)', async () => {
      expect(
        await spendsOf({
          type: 'dex_offer',
          payload: { amount: '8', selling: { code: 'USDC', issuer: ISSUER } },
        })
      ).toEqual([['8', USDC]]);
      vi.restoreAllMocks();
      expect(await spendsOf({ type: 'dex_offer', payload: { amount: '0' } })).toEqual([]);
      vi.restoreAllMocks();
      expect(await spendsOf({ type: 'dex_offer', payload: {} })).toEqual([]);
    });

    it('read-only tasks are not charged, whatever their payload says', async () => {
      expect(await spendsOf({ type: 'account_info', payload: { amount: '5' } })).toEqual([]);
    });

    it('classifies exactly the tasks that move value or spend fees', () => {
      expect([...VALUE_MOVING_TASK_TYPES].sort()).toEqual(
        [
          'batch_payment',
          'change_trust',
          'cross_border_payment',
          'data_entry',
          'dex_offer',
          'fee_bump',
          'liquidity_pool',
          'multisig_payment',
          'path_payment',
          'sequence_number',
          'set_options',
          'soroban_deploy',
          'soroban_invoke',
          'sponsored_account',
          'stellar_payment',
          'swap',
          'x402_respond',
        ].sort()
      );
    });
  });

  describe('spending caps and reservations', () => {
    const pay = (amount: string) =>
      agent.run({ type: 'stellar_payment', payload: { amount } } as AgentTask);

    it('AGENT_SPENDING_LIMIT rejects anything over it and allows exactly it', async () => {
      const over = await pay('1000.0000001');
      expect(over.error).toBe(
        'Payment amount 1000.0000001 XLM exceeds AGENT_SPENDING_LIMIT of 1000'
      );
      expect((await pay('1000')).success).toBe(true);
    });

    it('per-asset limits replace the single-payment AGENT_SPENDING_LIMIT check', async () => {
      (config.SPENDING_LIMITS_MAP as Map<string, string>).set('XLM', '5000');

      expect((await pay('2000')).success).toBe(true);
    });

    it('the mainnet cap rejects anything over it and allows exactly it', async () => {
      mutableConfig.STELLAR_NETWORK = 'mainnet';
      mutableConfig.AGENT_SPENDING_LIMIT = '50000';

      expect((await pay('10000.0000001')).error).toBe(
        'Payment amount 10000.0000001 XLM exceeds mainnet spending cap of 10000'
      );
      expect((await pay('10000')).success).toBe(true);
    });

    it('the mainnet cap does not apply on testnet', async () => {
      mutableConfig.AGENT_SPENDING_LIMIT = '50000';

      expect((await pay('10001')).success).toBe(true);
    });

    it('commits the reservation on success', async () => {
      const commit = vi.spyOn(spendingTracker, 'commit');

      await pay('5');

      expect(commit).toHaveBeenCalledTimes(1);
      expect(spendingTracker.totalWithReserved()).toBe(5);
    });

    it('releases the reservation when the tool fails, so quota is not consumed', async () => {
      await failingPayment(new Error('network down'), { amount: '5' });

      expect(spendingTracker.totalWithReserved()).toBe(0);
    });

    it('releases earlier reservations when a later asset in a batch is refused', async () => {
      (config.SPENDING_LIMITS_MAP as Map<string, string>).set('XLM', '100');
      (config.SPENDING_LIMITS_MAP as Map<string, string>).set(USDC, '1');

      const result = await agent.run({
        type: 'batch_payment',
        payload: {
          payments: [{ amount: '10' }, { amount: '2', assetCode: 'USDC', assetIssuer: ISSUER }],
        },
      } as AgentTask);

      expect(result.success).toBe(false);
      expect(spendingTracker.totalWithReserved()).toBe(0);
    });
  });

  describe('destination policy', () => {
    it('names the destination and the policy in the rejection', async () => {
      mutableConfig.PAYMENT_DESTINATION_POLICY = 'allowlist';

      const result = await agent.run({
        type: 'stellar_payment',
        payload: { destination: DEST, amount: '1' },
      } as AgentTask);

      expect(result.error).toBe(
        `Destination ${DEST} is not permitted by the allowlist payment destination policy`
      );
    });

    it('ignores blank and non-string destinations', async () => {
      mutableConfig.PAYMENT_DESTINATION_POLICY = 'allowlist';

      const result = await agent.run({
        type: 'batch_payment',
        payload: {
          destination: '',
          payTo: 7,
          payments: [null, { destination: '' }, { destination: 5 }],
        },
      } as AgentTask);

      expect(result.errorType).not.toBe(ErrorType.PolicyViolation);
    });

    it('checks the destination, payTo and batch entries of the same task', async () => {
      mutableConfig.PAYMENT_DESTINATION_POLICY = 'denylist';
      mutableConfig.PAYMENT_DESTINATIONS = ['GDENIED'];

      for (const payload of [
        { destination: 'GDENIED' },
        { payTo: 'GDENIED' },
        { payments: [{ destination: 'GDENIED' }] },
      ]) {
        const result = await agent.run({ type: 'batch_payment', payload } as AgentTask);
        expect(result.errorType).toBe(ErrorType.PolicyViolation);
      }
    });
  });

  describe('approvals', () => {
    const big = {
      type: 'stellar_payment',
      payload: { destination: DEST, amount: '600' },
    } as AgentTask;

    const saved = () => vi.mocked(savePendingApproval).mock.calls[0]![0];
    const held = () => ({ ...saved(), status: 'pending_approval' as const, decidedAt: null });

    beforeEach(() => {
      mutableConfig.APPROVAL_THRESHOLD = '500';
      mutableConfig.APPROVAL_TTL_MS = 60_000;
    });

    it('stores the task with its amount, correlation id and a TTL-based expiry', async () => {
      const now = 1_700_000_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const result = await agent.run({ ...big, correlationId: 'corr-1' });

      expect(saved()).toEqual({
        id: expect.any(String),
        taskType: 'stellar_payment',
        payload: big.payload,
        amount: '600',
        correlationId: 'corr-1',
        createdAt: now,
        expiresAt: now + 60_000,
      });
      expect(result).toEqual({
        success: false,
        taskType: 'stellar_payment',
        data: {
          status: 'pending_approval',
          approvalId: saved().id,
          expiresAt: new Date(now + 60_000).toISOString(),
        },
        error: 'Amount 600 exceeds APPROVAL_THRESHOLD of 500 — awaiting approval',
        errorType: ErrorType.PendingApproval,
        correlationId: 'corr-1',
      });
      expect(dispatchWebhook).toHaveBeenCalledWith(result);
    });

    it('compares a batch by its total and a path payment by its send amount', async () => {
      const batch = await agent.run({
        type: 'batch_payment',
        payload: {
          payments: [{ amount: '300' }, { amount: '300' }, { amount: 'junk' }, null],
        },
      } as AgentTask);
      expect(batch.errorType).toBe(ErrorType.PendingApproval);
      expect(saved().amount).toBe('600');
      spendingTracker.clear();

      const path = await agent.run({
        type: 'path_payment',
        payload: { sendAmount: '600', amount: '1' },
      } as AgentTask);
      expect(path.errorType).toBe(ErrorType.PendingApproval);

      const smallPath = await agent.run({
        type: 'path_payment',
        payload: { sendAmount: '1', amount: '600' },
      } as AgentTask);
      expect(smallPath.success).toBe(true);
    });

    it('does not hold a task with no string amount, or a read-only task', async () => {
      const noAmount = await agent.run({
        type: 'stellar_payment',
        payload: { amount: 600 },
      } as AgentTask);
      expect(noAmount.errorType).not.toBe(ErrorType.PendingApproval);

      const readOnly = await agent.run({
        type: 'account_info',
        payload: { amount: '600' },
      } as AgentTask);
      expect(readOnly.errorType).not.toBe(ErrorType.PendingApproval);
      expect(savePendingApproval).not.toHaveBeenCalled();
    });

    it('does not hold anything when no threshold is configured', async () => {
      delete mutableConfig.APPROVAL_THRESHOLD;

      expect((await agent.run(big)).success).toBe(true);
      expect(savePendingApproval).not.toHaveBeenCalled();
    });

    it('releases the reservation if the approval cannot be stored', async () => {
      vi.mocked(savePendingApproval).mockImplementation(() => {
        throw new Error('db locked');
      });

      const result = await agent.run(big);

      expect(result.success).toBe(false);
      expect(result.error).toBe('db locked');
      expect(spendingTracker.totalWithReserved()).toBe(0);
    });

    it('sweeps expired approvals when the TTL elapses', async () => {
      vi.useFakeTimers();
      await agent.run(big);
      vi.mocked(expirePendingApprovals).mockReturnValue([saved().id]);

      await vi.advanceTimersByTimeAsync(59_999);
      expect(spendingTracker.totalWithReserved()).toBe(600);

      await vi.advanceTimersByTimeAsync(1);
      expect(spendingTracker.totalWithReserved()).toBe(0);
    });

    it('approve() runs the stored task under its original correlation id', async () => {
      const payment = stubTool('stellar_payment');
      await agent.run({ ...big, correlationId: 'corr-2' });
      const approval = held();
      const decided = { ...approval, status: 'approved' as const };
      vi.mocked(getPendingApproval).mockReturnValueOnce(approval).mockReturnValue(decided);

      const outcome = await agent.approve(approval.id);

      expect(decideApproval).toHaveBeenCalledWith(approval.id, 'approved');
      expect(payment).toHaveBeenCalledWith(big.payload);
      expect(outcome?.result).toMatchObject({ success: true, correlationId: 'corr-2' });
      expect(outcome?.approval).toEqual(decided);
      // The approved run re-reserves and commits, so exactly one 600 remains.
      expect(spendingTracker.totalWithReserved()).toBe(600);
    });

    it('approve() falls back to the approval it read if it can no longer be found', async () => {
      await agent.run(big);
      const approval = held();
      vi.mocked(getPendingApproval).mockReturnValueOnce(approval).mockReturnValue(undefined);

      expect((await agent.approve(approval.id))?.approval).toEqual(approval);
    });

    it('approve() returns the current state and runs nothing if already decided', async () => {
      const payment = stubTool('stellar_payment');
      await agent.run(big);
      const approval = held();
      vi.mocked(getPendingApproval).mockReturnValue(approval);
      vi.mocked(decideApproval).mockReturnValue(false);

      expect(await agent.approve(approval.id)).toEqual({ approval });
      expect(payment).not.toHaveBeenCalled();
      // Still held: losing the decision race must not release the reservation.
      expect(spendingTracker.totalWithReserved()).toBe(600);
    });

    it('deny() keeps the reservation when another decision got there first', async () => {
      await agent.run(big);
      const approval = held();
      vi.mocked(getPendingApproval).mockReturnValue(approval);
      vi.mocked(decideApproval).mockReturnValue(false);

      expect(agent.deny(approval.id)).toEqual(approval);
      expect(spendingTracker.totalWithReserved()).toBe(600);
    });

    it('approve(), deny() and listApprovals() expire overdue approvals first', async () => {
      vi.mocked(getPendingApproval).mockReturnValue(undefined);

      await agent.approve('a');
      agent.deny('b');
      expect(agent.listApprovals()).toEqual([]);

      expect(expirePendingApprovals).toHaveBeenCalledTimes(3);
    });
  });

  describe('audit log', () => {
    const audited = async (type: keyof typeof TOOL_FIELDS, data: unknown, payload: object) => {
      stubTool(type, data);
      await agent.run({ type, payload, correlationId: 'corr-3' } as AgentTask);
      return vi.mocked(appendAuditEntry).mock.calls[0]?.[0];
    };

    it('records the full entry, with the same timestamp as the saved result', async () => {
      const entry = await audited(
        'stellar_payment',
        { txHash: 'tx1', envelopeXdr: 'xdr1' },
        { destination: DEST, amount: '5', assetCode: 'USDC', assetIssuer: ISSUER }
      );

      expect(entry).toEqual({
        ts: vi.mocked(saveResult).mock.calls[0]![0].timestamp,
        correlationId: 'corr-3',
        taskType: 'stellar_payment',
        txHash: 'tx1',
        envelopeHash: createHash('sha256').update('xdr1').digest('hex'),
        destination: DEST,
        asset: `USDC:${ISSUER}`,
        amount: '5',
      });
    });

    it('accepts envelope_xdr, falls back to payTo, and omits an absent issuer', async () => {
      const entry = await audited(
        'x402_respond',
        { txHash: 'tx2', envelope_xdr: 'xdr2' },
        { payTo: DEST, amount: '1', assetCode: 'XLM' }
      );

      expect(entry).toMatchObject({
        envelopeHash: createHash('sha256').update('xdr2').digest('hex'),
        destination: DEST,
        asset: 'XLM',
      });
    });

    it('stores null for missing and empty fields', async () => {
      const entry = await audited(
        'stellar_payment',
        { txHash: 'tx3', envelopeXdr: '' },
        { destination: '', amount: 5 }
      );

      expect(entry).toMatchObject({
        envelopeHash: null,
        destination: null,
        asset: null,
        amount: null,
      });
    });

    it.each([
      ['no txHash', { ledger: 1 }],
      ['an empty txHash', { txHash: '' }],
      ['a non-string txHash', { txHash: 7 }],
      ['null data', null],
      ['primitive data', 'text'],
    ])('records nothing for %s', async (_label, data) => {
      expect(await audited('stellar_payment', data, { amount: '1' })).toBeUndefined();
    });

    it('records nothing for Friendbot, which the agent does not sign', async () => {
      expect(await audited('friendbot', { txHash: 'tx4' }, {})).toBeUndefined();
    });

    it('reports success even if the audit write fails, because the tx is on-chain', async () => {
      vi.mocked(appendAuditEntry).mockImplementation(() => {
        throw new Error(`disk full ${SECRET}`);
      });

      const result = await agent.run({
        type: 'stellar_payment',
        payload: { amount: '1' },
      } as AgentTask);

      expect(result.success).toBe(true);
      expect(log.error).toHaveBeenCalledWith(
        { taskType: 'stellar_payment', error: 'disk full [REDACTED]' },
        'Failed to append audit log entry'
      );
    });
  });

  describe('idempotency', () => {
    const keyed = { type: 'stellar_payment', payload: { amount: '1' }, idempotencyKey: 'k1' };

    it('refuses a reused key with a different payload, without running the tool', async () => {
      const payment = stubTool('stellar_payment');
      vi.mocked(getIdempotencyResult).mockReturnValue({ conflict: true } as never);

      const result = await agent.run({ ...keyed, correlationId: 'c' } as AgentTask);

      expect(result).toEqual({
        success: false,
        taskType: 'stellar_payment',
        error: 'Idempotency key "k1" already used with a different payload',
        errorType: ErrorType.IdempotencyConflict,
        correlationId: 'c',
      });
      expect(payment).not.toHaveBeenCalled();
    });

    it('replays a cached result under the new correlation id, without paying again', async () => {
      const payment = stubTool('stellar_payment');
      vi.mocked(getIdempotencyResult).mockReturnValue({
        success: true,
        taskType: 'stellar_payment',
        data: { txHash: 'old' },
        correlationId: 'old-corr',
      } as never);

      const result = await agent.run({ ...keyed, correlationId: 'new-corr' } as AgentTask);

      expect(result).toMatchObject({ data: { txHash: 'old' }, correlationId: 'new-corr' });
      expect(payment).not.toHaveBeenCalled();
    });

    it('stores the outcome for success and failure, and only with a key', async () => {
      const ok = await agent.run(keyed as AgentTask);
      expect(saveIdempotencyResult).toHaveBeenCalledWith(
        'k1',
        'stellar_payment',
        keyed.payload,
        ok
      );

      vi.mocked(saveIdempotencyResult).mockClear();
      stubTool('stellar_payment').mockRejectedValue(new Error('x'));
      const failed = await agent.run(keyed as AgentTask);
      expect(saveIdempotencyResult).toHaveBeenCalledWith(
        'k1',
        'stellar_payment',
        keyed.payload,
        failed
      );

      vi.mocked(saveIdempotencyResult).mockClear();
      await agent.run({ type: 'stellar_payment', payload: { amount: '1' } } as AgentTask);
      expect(saveIdempotencyResult).not.toHaveBeenCalled();
      expect(getIdempotencyResult).toHaveBeenCalledTimes(2);
    });

    it('stores the outcome when middleware throws', async () => {
      agent.use(async () => {
        throw new Error('blocked');
      });

      const result = await agent.run(keyed as AgentTask);

      expect(result.error).toBe('blocked');
      expect(saveIdempotencyResult).toHaveBeenCalledWith(
        'k1',
        'stellar_payment',
        keyed.payload,
        result
      );
    });
  });

  describe('concurrency', () => {
    const slots = () => agent as unknown as { activeTasks: number; taskQueue: unknown[] };
    const read = { type: 'account_info', payload: {} } as AgentTask;

    it('rejects at capacity when there is no queue', async () => {
      mutableConfig.MAX_CONCURRENT_TASKS = 1;
      slots().activeTasks = 1;

      const result = await agent.run({ ...read, correlationId: 'c' });

      expect(result).toEqual({
        success: false,
        taskType: 'account_info',
        error: 'Agent is at capacity — 1/1 concurrent tasks in flight; task rejected',
        correlationId: 'c',
      });
      slots().activeTasks = 0;
    });

    it('runs below capacity', async () => {
      mutableConfig.MAX_CONCURRENT_TASKS = 2;
      slots().activeTasks = 1;

      expect((await agent.run(read)).success).toBe(true);
      expect(slots().activeTasks).toBe(1);
      slots().activeTasks = 0;
    });

    it('queues at capacity, announces it, and runs queued tasks in order', async () => {
      mutableConfig.MAX_CONCURRENT_TASKS = 1;
      mutableConfig.QUEUE_CAPACITY = 2;
      slots().activeTasks = 1;
      const queued = vi.fn();
      agent.on('task:queued', queued);

      const order: string[] = [];
      const first = agent.run({ ...read, correlationId: 'first' }).then((r) => {
        order.push(r.correlationId as string);
        return r;
      });
      const second = agent.run({ ...read, correlationId: 'second' }).then((r) => {
        order.push(r.correlationId as string);
        return r;
      });

      expect(queued.mock.calls.map(([e]) => e)).toEqual([
        { taskType: 'account_info', correlationId: 'first', queueLength: 1 },
        { taskType: 'account_info', correlationId: 'second', queueLength: 2 },
      ]);
      expect(slots().taskQueue).toHaveLength(2);

      // A third task overflows the queue and is rejected outright.
      const overflow = await agent.run(read);
      expect(overflow.error).toMatch(/at capacity/);

      // Freeing the slot and finishing one task drains the queue one by one.
      slots().activeTasks = 0;
      await agent.run({ ...read, correlationId: 'trigger' });

      expect((await first).success).toBe(true);
      expect((await second).success).toBe(true);
      expect(order).toEqual(['first', 'second']);
      expect(slots().taskQueue).toHaveLength(0);
      expect(slots().activeTasks).toBe(0);
    });

    it('does not start a queued task while the agent is still at capacity', async () => {
      mutableConfig.MAX_CONCURRENT_TASKS = 1;
      mutableConfig.QUEUE_CAPACITY = 1;
      slots().activeTasks = 1;
      void agent.run({ ...read, correlationId: 'waiting' });

      (agent as unknown as { dispatchQueued(): void }).dispatchQueued();

      expect(slots().taskQueue).toHaveLength(1);
      agent.drain();
      slots().activeTasks = 0;
    });
  });

  describe('task lifecycle', () => {
    it('reports success through the event, the saved result and the webhook', async () => {
      stubTool('stellar_payment', { txHash: 'tx', ledger: 9 });
      const started = vi.fn();
      const complete = vi.fn();
      agent.on('task:started', started);
      agent.on('task:complete', complete);

      const result = await agent.run({
        type: 'stellar_payment',
        payload: { amount: '1' },
        correlationId: 'c',
      } as AgentTask);

      expect(started).toHaveBeenCalledWith({ taskType: 'stellar_payment', correlationId: 'c' });
      expect(result).toEqual({
        success: true,
        taskType: 'stellar_payment',
        data: { txHash: 'tx', ledger: 9, network: 'testnet' },
        correlationId: 'c',
        durationMs: expect.any(Number),
      });
      expect(complete).toHaveBeenCalledWith(result);
      expect(saveResult).toHaveBeenCalledWith({ ...result, timestamp: expect.any(String) });
      expect(dispatchWebhook).toHaveBeenCalledWith(result);
      expect(log.info).toHaveBeenCalledWith({ taskType: 'stellar_payment' }, 'Task complete');
    });

    it('reports failure through the event, the saved result and the webhook', async () => {
      const failed = vi.fn();
      agent.on('task:failed', failed);

      const result = await failingPayment(new ValidationError('bad'));

      expect(result).toEqual({
        success: false,
        taskType: 'stellar_payment',
        error: 'bad',
        errorType: ErrorType.ValidationError,
        correlationId: expect.any(String),
        durationMs: expect.any(Number),
      });
      expect(failed).toHaveBeenCalledWith(result);
      expect(saveResult).toHaveBeenCalledWith({ ...result, timestamp: expect.any(String) });
      expect(dispatchWebhook).toHaveBeenCalledWith(result);
      expect(log.warn).toHaveBeenCalledWith(
        { taskType: 'stellar_payment', error: 'bad' },
        'Task failed'
      );
    });

    it('reports a middleware throw the same way as a tool failure', async () => {
      const failed = vi.fn();
      agent.on('task:failed', failed);
      agent.use(async () => {
        throw new ValidationError('blocked');
      });

      const result = await agent.run({
        type: 'stellar_payment',
        payload: {},
        correlationId: 'c',
      } as AgentTask);

      expect(result).toEqual({
        success: false,
        taskType: 'stellar_payment',
        error: 'blocked',
        errorType: ErrorType.ValidationError,
        correlationId: 'c',
        durationMs: expect.any(Number),
      });
      expect(failed).toHaveBeenCalledWith(result);
      expect(saveResult).toHaveBeenCalledWith({ ...result, timestamp: expect.any(String) });
      expect(dispatchWebhook).toHaveBeenCalledWith(result);
    });

    it('announces retry exhaustion only for an RPC error', async () => {
      const exhausted = vi.fn();
      agent.on('task:retry_exhausted', exhausted);
      let toThrow: Error = new Error('plain');
      agent.use(async () => {
        throw toThrow;
      });
      const task = { type: 'stellar_payment', payload: {} } as AgentTask;

      await agent.run(task);
      expect(exhausted).not.toHaveBeenCalled();

      toThrow = new StellarRPCError('rpc down', {});
      await agent.run(task);
      expect(exhausted).toHaveBeenCalledWith({ taskType: 'stellar_payment', attempts: 3 });
    });

    it('feeds the failure alerts from the outcome of each task', async () => {
      const success = vi.spyOn(failureAlerts, 'recordSuccess');
      const failure = vi.spyOn(failureAlerts, 'recordFailure');

      await agent.run({ type: 'stellar_payment', payload: { amount: '1' } } as AgentTask);
      expect(success).toHaveBeenCalledTimes(1);
      expect(failure).not.toHaveBeenCalled();

      await failingPayment(new Error('x'));
      expect(failure).toHaveBeenCalledWith('stellar_payment');
      expect(success).toHaveBeenCalledTimes(1);
    });

    it('prunes idempotency keys occasionally and ignores a pruning failure', async () => {
      const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
      const read = { type: 'account_info', payload: {} } as AgentTask;

      await agent.run(read);
      expect(pruneIdempotencyKeys).not.toHaveBeenCalled();

      random.mockReturnValue(0.001);
      vi.mocked(pruneIdempotencyKeys).mockImplementation(() => {
        throw new Error('locked');
      });
      expect((await agent.run(read)).success).toBe(true);
      expect(pruneIdempotencyKeys).toHaveBeenCalledTimes(1);
    });

    it('balance_check prefers execute(), falls back to getBalance(), else fails', async () => {
      const set = (tool: object) => {
        (agent as unknown as { balanceCheckTool: object }).balanceCheckTool = tool;
      };
      const run = () => agent.run({ type: 'balance_check', payload: { a: 1 } } as AgentTask);

      const execute = vi.fn().mockResolvedValue('from-execute');
      set({ execute, getBalance: vi.fn() });
      expect((await run()).data).toBe('from-execute');
      expect(execute).toHaveBeenCalledWith({ a: 1 });

      set({ getBalance: vi.fn().mockResolvedValue('from-getBalance') });
      expect((await run()).data).toBe('from-getBalance');

      set({});
      expect((await run()).error).toBe(
        'Balance check tool does not implement execute() or getBalance().'
      );
    });
  });

  describe('registered tools', () => {
    const custom = (execute: (input: unknown, ctx: never) => Promise<unknown>) => ({
      name: 'custom_tool' as never,
      description: 'test tool',
      inputSchema: z.object({ amount: z.unknown() }),
      valueMoving: true,
      execute,
    });
    const run = (amount: unknown) =>
      agent.run({ type: 'custom_tool', payload: { amount }, correlationId: 'c' } as never);

    it('gives the tool its parsed input and a context', async () => {
      const execute = vi.fn().mockResolvedValue('done');
      agent.registerTool(custom(execute));

      const result = await run('1');

      expect(result.data).toBe('done');
      expect(execute).toHaveBeenCalledWith(
        { amount: '1' },
        expect.objectContaining({ correlationId: 'c', network: 'testnet' })
      );
    });

    it('charges assertWithinSpendingLimit to the settlement asset and commits it', async () => {
      const reserve = vi.spyOn(spendingTracker, 'reserve');
      agent.registerTool(
        custom(async (input, ctx: { assertWithinSpendingLimit(a: unknown): void }) => {
          ctx.assertWithinSpendingLimit((input as { amount: unknown }).amount);
          return 'done';
        })
      );

      await run('7');

      expect(reserve).toHaveBeenCalledWith('7', USDC);
      expect(spendingTracker.totalWithReserved()).toBe(7);
    });

    it('releases what the tool reserved when it throws', async () => {
      agent.registerTool(
        custom(async (input, ctx: { assertWithinSpendingLimit(a: unknown): void }) => {
          ctx.assertWithinSpendingLimit((input as { amount: unknown }).amount);
          throw new Error('tool failed');
        })
      );

      expect((await run('7')).error).toBe('tool failed');
      expect(spendingTracker.totalWithReserved()).toBe(0);
    });

    it('fails the task when the tool goes over the limit', async () => {
      agent.registerTool(
        custom(async (input, ctx: { assertWithinSpendingLimit(a: unknown): void }) => {
          ctx.assertWithinSpendingLimit((input as { amount: unknown }).amount);
          return 'should not get here';
        })
      );

      expect((await run('1000.5')).error).toBe(
        `Payment amount 1000.5 ${USDC} exceeds AGENT_SPENDING_LIMIT of 1000`
      );
    });

    it('ignores a non-string amount, which the tool schema would reject', async () => {
      const reserve = vi.spyOn(spendingTracker, 'reserve');
      agent.registerTool(
        custom(async (input, ctx: { assertWithinSpendingLimit(a: unknown): void }) => {
          ctx.assertWithinSpendingLimit((input as { amount: unknown }).amount);
          return 'done';
        })
      );

      expect((await run(7)).success).toBe(true);
      expect(reserve).not.toHaveBeenCalled();
    });

    it('fails a task whose payload does not match the tool schema', async () => {
      const execute = vi.fn();
      agent.registerTool({ ...custom(execute), inputSchema: z.object({ amount: z.string() }) });

      expect((await run(7)).success).toBe(false);
      expect(execute).not.toHaveBeenCalled();
    });

    it('refuses to replace a tool that is already registered', () => {
      agent.registerTool(custom(vi.fn()));

      expect(() => agent.registerTool(custom(vi.fn()))).toThrow(
        'A tool named "custom_tool" is already registered'
      );
    });
  });
});
