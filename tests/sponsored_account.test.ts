/**
 * tests/sponsored_account.test.ts
 * Unit tests for SponsoredAccountTool and SponsoredAccountInputSchema.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Keypair, Account } from '@stellar/stellar-sdk';

const mockAgentKeypair = Keypair.random();

vi.mock('../backend/config', () => ({
  config: {
    STELLAR_NETWORK: 'testnet',
    agentKeypair: () => mockAgentKeypair,
  },
}));

vi.mock('../backend/rpc_client', () => ({
  loadAccount: vi.fn(),
  submitTransaction: vi.fn(),
  resolveNetworkPassphrase: vi.fn(() => 'Test SDF Network ; September 2015'),
}));

import {
  SponsoredAccountTool,
  SponsoredAccountInputSchema,
} from '../backend/tools/SponsoredAccountTool';
import * as rpcClient from '../backend/rpc_client';

describe('SponsoredAccountTool', () => {
  const agentPubkey = mockAgentKeypair.publicKey();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('SponsoredAccountInputSchema', () => {
    it('validates a valid public key with default startingBalance', () => {
      const newKeypair = Keypair.random();
      const parsed = SponsoredAccountInputSchema.parse({
        newAccountPublicKey: newKeypair.publicKey(),
      });

      expect(parsed.newAccountPublicKey).toBe(newKeypair.publicKey());
      expect(parsed.startingBalance).toBe('0');
    });

    it('rejects an invalid Stellar public key', () => {
      expect(() =>
        SponsoredAccountInputSchema.parse({
          newAccountPublicKey: 'not-a-valid-pubkey',
        })
      ).toThrow();
    });

    it('accepts custom starting balance and optional signatures', () => {
      const newKeypair = Keypair.random();
      const parsed = SponsoredAccountInputSchema.parse({
        newAccountPublicKey: newKeypair.publicKey(),
        startingBalance: '10.5',
        newAccountSignature: 'c2lnbmF0dXJl',
      });

      expect(parsed.startingBalance).toBe('10.5');
      expect(parsed.newAccountSignature).toBe('c2lnbmF0dXJl');
    });
  });

  describe('execute', () => {
    it('creates sponsored account transaction using co-signer secret', async () => {
      const newKeypair = Keypair.random();
      const mockAccount = new Account(agentPubkey, '500');

      vi.mocked(rpcClient.loadAccount).mockResolvedValueOnce(mockAccount as any);
      vi.mocked(rpcClient.submitTransaction).mockResolvedValueOnce({
        hash: 'tx-hash-sponsor-123',
        ledger: 100200,
        successful: true,
      } as any);

      const tool = new SponsoredAccountTool(mockAgentKeypair.secret());
      const result = await tool.execute({
        newAccountPublicKey: newKeypair.publicKey(),
        startingBalance: '5',
        newAccountSecret: newKeypair.secret(),
      });

      expect(rpcClient.loadAccount).toHaveBeenCalledWith(agentPubkey);
      expect(rpcClient.submitTransaction).toHaveBeenCalled();
      expect(result).toEqual({
        txHash: 'tx-hash-sponsor-123',
        ledger: 100200,
        newAccountPublicKey: newKeypair.publicKey(),
        startingBalance: '5',
      });
    });

    it('creates sponsored account transaction without co-signer secret', async () => {
      const newKeypair = Keypair.random();
      const mockAccount = new Account(agentPubkey, '500');

      vi.mocked(rpcClient.loadAccount).mockResolvedValueOnce(mockAccount as any);
      vi.mocked(rpcClient.submitTransaction).mockResolvedValueOnce({
        hash: 'tx-hash-sponsor-456',
        ledger: 100201,
        successful: true,
      } as any);

      const tool = new SponsoredAccountTool(mockAgentKeypair.secret());
      const result = await tool.execute({
        newAccountPublicKey: newKeypair.publicKey(),
        startingBalance: '0',
      });

      expect(result.txHash).toBe('tx-hash-sponsor-456');
      expect(result.newAccountPublicKey).toBe(newKeypair.publicKey());
    });
  });
});
