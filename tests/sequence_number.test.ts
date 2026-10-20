/**
 * tests/sequence_number.test.ts
 * Unit tests for SequenceNumberTool and SequenceNumberInputSchema.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair, Account } from '@stellar/stellar-sdk';

const mockKeypair = Keypair.random();

vi.mock('../backend/config', () => ({
  config: {
    STELLAR_NETWORK: 'testnet',
    agentKeypair: () => mockKeypair,
  },
}));

vi.mock('../backend/rpc_client', () => ({
  loadAccount: vi.fn(),
  submitTransaction: vi.fn(),
  resolveNetworkPassphrase: vi.fn(() => 'Test SDF Network ; September 2015'),
}));

import {
  SequenceNumberTool,
  SequenceNumberInputSchema,
} from '../backend/tools/SequenceNumberTool';
import * as rpcClient from '../backend/rpc_client';

describe('SequenceNumberTool', () => {
  const agentPubkey = mockKeypair.publicKey();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('SequenceNumberInputSchema', () => {
    it('validates a valid get request without accountId', () => {
      const parsed = SequenceNumberInputSchema.parse({ action: 'get' });
      expect(parsed.action).toBe('get');
    });

    it('validates a valid get request with valid Stellar accountId', () => {
      const parsed = SequenceNumberInputSchema.parse({
        action: 'get',
        accountId: agentPubkey,
      });
      expect(parsed.action).toBe('get');
      if (parsed.action === 'get') {
        expect(parsed.accountId).toBe(agentPubkey);
      }
    });

    it('rejects invalid Stellar public key for get request', () => {
      expect(() =>
        SequenceNumberInputSchema.parse({
          action: 'get',
          accountId: 'invalid-key-format',
        })
      ).toThrow();
    });

    it('validates bump request with numeric bumpTo and transforms to string', () => {
      const parsed = SequenceNumberInputSchema.parse({
        action: 'bump',
        bumpTo: 12345678,
      });
      expect(parsed.action).toBe('bump');
      if (parsed.action === 'bump') {
        expect(parsed.bumpTo).toBe('12345678');
      }
    });

    it('validates bump request with string bumpTo', () => {
      const parsed = SequenceNumberInputSchema.parse({
        action: 'bump',
        bumpTo: '999999999',
      });
      if (parsed.action === 'bump') {
        expect(parsed.bumpTo).toBe('999999999');
      }
    });
  });

  describe('execute', () => {
    it('executes get action and returns sequence number for default account', async () => {
      const mockAccount = new Account(agentPubkey, '1000');
      vi.mocked(rpcClient.loadAccount).mockResolvedValueOnce(mockAccount as any);

      const tool = new SequenceNumberTool(mockKeypair.secret());
      const result = await tool.execute({ action: 'get' });

      expect(rpcClient.loadAccount).toHaveBeenCalledWith(agentPubkey, { forceRefresh: true });
      expect(result).toEqual({
        accountId: agentPubkey,
        sequence: '1000',
      });
    });

    it('executes get action for a specified accountId', async () => {
      const otherKeypair = Keypair.random();
      const mockAccount = new Account(otherKeypair.publicKey(), '5555');
      vi.mocked(rpcClient.loadAccount).mockResolvedValueOnce(mockAccount as any);

      const tool = new SequenceNumberTool(mockKeypair.secret());
      const result = await tool.execute({
        action: 'get',
        accountId: otherKeypair.publicKey(),
      });

      expect(rpcClient.loadAccount).toHaveBeenCalledWith(otherKeypair.publicKey(), {
        forceRefresh: true,
      });
      expect(result).toEqual({
        accountId: otherKeypair.publicKey(),
        sequence: '5555',
      });
    });

    it('executes bump action and submits transaction', async () => {
      const mockAccount = new Account(agentPubkey, '1000');
      vi.mocked(rpcClient.loadAccount).mockResolvedValueOnce(mockAccount as any);
      vi.mocked(rpcClient.submitTransaction).mockResolvedValueOnce({
        hash: 'tx-hash-bump-123',
        ledger: 424242,
        successful: true,
      } as any);

      const tool = new SequenceNumberTool(mockKeypair.secret());
      const result = await tool.execute({
        action: 'bump',
        bumpTo: '2000',
      });

      expect(rpcClient.loadAccount).toHaveBeenCalledWith(agentPubkey, { forceRefresh: true });
      expect(rpcClient.submitTransaction).toHaveBeenCalled();
      expect(result).toEqual({
        txHash: 'tx-hash-bump-123',
        ledger: 424242,
        bumpedTo: '2000',
        sequence: '2000',
      });
    });
  });
});
