/**
 * tests/triggers.test.ts
 *
 * TriggerManager validation and approval tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TriggerManager } from '../backend/triggers';
import { PayFiAgent, AgentTask } from '../backend/agent';
import { config } from '../backend/config';
import { _setDb, getDb, dbCleanup } from '../backend/persistence';

// Mock config for tests
vi.mock('../backend/config', () => ({
  config: {
    TRIGGER_ALLOW_PAYMENTS: false,
    APPROVAL_THRESHOLD: undefined,
    STELLAR_NETWORK: 'testnet',
    HORIZON_URL: 'https://horizon-testnet.stellar.org',
    SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
  },
}));

vi.mock('../backend/rpc_client', () => ({
  horizonServer: {
    payments: vi.fn().mockReturnValue({
      forAccount: vi.fn().mockReturnValue({
        stream: vi.fn(),
      }),
    }),
  },
  sorobanServer: {
    getLatestLedger: vi.fn().mockResolvedValue({ sequence: 1 }),
    getEvents: vi.fn().mockResolvedValue({ events: [], cursor: '' }),
  },
}));

// Create a mock agent for testing
function createMockAgent(): PayFiAgent {
  const agent = new PayFiAgent();
  agent.startListening = vi.fn();
  agent.stopListening = vi.fn();
  agent.startContractListener = vi.fn();
  agent.stopContractListener = vi.fn();
  agent.startStorageWatcher = vi.fn();
  agent.stopStorageWatcher = vi.fn();
  return agent;
}

describe('TriggerManager', () => {
  beforeEach(() => {
    dbCleanup();
    vi.resetAllMocks();
    // Reset config mock defaults
    (config as any).TRIGGER_ALLOW_PAYMENTS = false;
    (config as any).APPROVAL_THRESHOLD = undefined;
  });

  describe('createTrigger', () => {
    it('rejects invalid task types at creation time', async () => {
      const agent = createMockAgent();
      const manager = new TriggerManager(agent);

      const invalidTask: AgentTask = {
        type: 'unknown_task_type' as any,
        payload: {},
      };

      await expect(
        manager.createTrigger({
          source: 'payment',
          filter: {},
          task: invalidTask,
        }),
      ).rejects.toThrow(/Invalid task type "unknown_task_type"/);
    });

    it('rejects value-moving tasks when TRIGGER_ALLOW_PAYMENTS is false', async () => {
      const agent = createMockAgent();
      const manager = new TriggerManager(agent);

      const paymentTask: AgentTask = {
        type: 'stellar_payment',
        payload: {
          destination: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
          amount: '10',
          assetCode: 'XLM',
        },
      };

      await expect(
        manager.createTrigger({
          source: 'payment',
          filter: { minAmount: '1' },
          task: paymentTask,
        }),
      ).rejects.toThrow(/Value-moving triggers are disabled/);
    });

    it('accepts value-moving tasks when TRIGGER_ALLOW_PAYMENTS is true', async () => {
      (config as any).TRIGGER_ALLOW_PAYMENTS = true;

      const agent = createMockAgent();
      const manager = new TriggerManager(agent);

      const paymentTask: AgentTask = {
        type: 'stellar_payment',
        payload: {
          destination: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
          amount: '10',
          assetCode: 'XLM',
        },
      };

      const trigger = await manager.createTrigger({
        source: 'payment',
        filter: { minAmount: '1' },
        task: paymentTask,
      });

      expect(trigger).toBeDefined();
      expect(trigger.task.type).toBe('stellar_payment');
    });

    it('accepts non-value-moving tasks regardless of TRIGGER_ALLOW_PAYMENTS', async () => {
      const agent = createMockAgent();
      const manager = new TriggerManager(agent);

      const readTask: AgentTask = {
        type: 'account_info',
        payload: {
          accountId: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        },
      };

      // With TRIGGER_ALLOW_PAYMENTS=false (default)
      let trigger = await manager.createTrigger({
        source: 'payment',
        filter: {},
        task: readTask,
      });
      expect(trigger).toBeDefined();

      // Even with TRIGGER_ALLOW_PAYMENTS=true
      (config as any).TRIGGER_ALLOW_PAYMENTS = true;
      trigger = await manager.createTrigger({
        source: 'payment',
        filter: {},
        task: readTask,
      });
      expect(trigger).toBeDefined();
    });

    it('accepts all valid task types', async () => {
      (config as any).TRIGGER_ALLOW_PAYMENTS = true;

      const agent = createMockAgent();
      const manager = new TriggerManager(agent);

      const validTaskTypes = [
        'stellar_payment',
        'soroban_invoke',
        'x402_respond',
        'multisig_payment',
        'batch_payment',
        'path_payment',
        'dex_offer',
        'account_info',
        'balance_check',
      ];

      for (const type of validTaskTypes) {
        const task: AgentTask = {
          type,
          payload: type === 'account_info' || type === 'balance_check' ? {} : { amount: '1' },
        };

        await expect(
          manager.createTrigger({ source: 'payment', filter: {}, task }),
        ).resolves.toBeDefined();
      }
    });

    it('persists trigger to database', async () => {
      const agent = createMockAgent();
      const manager = new TriggerManager(agent);

      const readTask: AgentTask = {
        type: 'account_info',
        payload: {},
      };

      const trigger = await manager.createTrigger({
        source: 'payment',
        filter: { minAmount: '100' },
        task: readTask,
      });

      // Load triggers from database
      const rows = getDb()
        .prepare('SELECT id, source, filter, task FROM triggers WHERE id = ?')
        .get(trigger.id) as any;

      expect(rows).toBeDefined();
      expect(rows.id).toBe(trigger.id);
      expect(JSON.parse(rows.filter)).toEqual({ minAmount: '100' });
      expect(JSON.parse(rows.task)).toEqual({
        type: 'account_info',
        payload: {},
      });
    });

    it('logs a warning when creating value-moving triggers', async () => {
      (config as any).TRIGGER_ALLOW_PAYMENTS = true;

      const agent = createMockAgent();
      const manager = new TriggerManager(agent);

      const paymentTask: AgentTask = {
        type: 'stellar_payment',
        payload: {
          destination: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
          amount: '10',
          assetCode: 'XLM',
        },
      };

      const consoleWarn = vi.spyOn(console, 'warn');
      consoleWarn.mockImplementation(() => {});

      await manager.createTrigger({
        source: 'payment',
        filter: { minAmount: '1' },
        task: paymentTask,
      });

      expect(consoleWarn).toHaveBeenCalledWith(
        expect.objectContaining({
          triggerSource: 'payment',
          taskType: 'stellar_payment',
        }),
        'Value-moving trigger created — payments enabled',
      );

      consoleWarn.mockRestore();
    });
  });

  describe('setupPaymentListener', () => {
    it('does not perform inline spending limit check (delegates to agent)', async () => {
      const agent = createMockAgent();
      const manager = new TriggerManager(agent);

      const readTask: AgentTask = {
        type: 'account_info',
        payload: {},
      };

      await manager.createTrigger({
        source: 'payment',
        filter: { minAmount: '100' },
        task: readTask,
      });

      // Simulate a payment that would trigger
      const challenge = {
        nonce: 'test-nonce',
        assetCode: 'XLM',
        payTo: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        amount: '1000',
      };

      const agentRunSpy = vi.spyOn(agent, 'run').mockResolvedValue({
        success: true,
        taskType: 'account_info',
      });

      // The payment listener should fire the trigger
      // Get the callback registered with startListening
      const callback = (agent.startListening as vi.Mock).mock.calls[0][1];
      await callback(challenge);

      expect(agentRunSpy).toHaveBeenCalledWith(readTask);

      agentRunSpy.mockRestore();
    });

    it('large value-moving triggers go to pending approval', async () => {
      // Set approval threshold to 500
      (config as any).APPROVAL_THRESHOLD = '500';
      (config as any).TRIGGER_ALLOW_PAYMENTS = true;

      const agent = createMockAgent();
      const manager = new TriggerManager(agent);

      const paymentTask: AgentTask = {
        type: 'stellar_payment',
        payload: {
          destination: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
          amount: '1000',
          assetCode: 'XLM',
        },
      };

      await manager.createTrigger({
        source: 'payment',
        filter: { minAmount: '1' },
        task: paymentTask,
      });

      // Simulate a payment that exceeds approval threshold
      const challenge = {
        nonce: 'test-nonce',
        assetCode: 'XLM',
        payTo: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
        amount: '1000',
      };

      const agentRunSpy = vi
        .spyOn(agent, 'run')
        .mockResolvedValue({ success: false, taskType: 'stellar_payment' });

      // The payment listener should fire the trigger
      const callback = (agent.startListening as vi.Mock).mock.calls[0][1];
      await callback(challenge);

      // The trigger should call agent.run, and agent should return a pending approval result
      expect(agentRunSpy).toHaveBeenCalledWith(paymentTask);

      agentRunSpy.mockRestore();
    });
  });
});
