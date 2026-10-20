/**
 * tests/friendbot.test.ts
 * Unit tests for FriendBotTool and FriendBotInputSchema.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConfigError } from '../backend/errors';

let mockNetwork = 'testnet';

vi.mock('../backend/config', () => ({
  config: {
    get STELLAR_NETWORK() {
      return mockNetwork;
    },
  },
}));

import { FriendBotTool, FriendBotInputSchema } from '../backend/tools/FriendBotTool';

describe('FriendBotTool', () => {
  const validPubKey = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
  const originalFetch = global.fetch;

  beforeEach(() => {
    mockNetwork = 'testnet';
    vi.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  describe('FriendBotInputSchema', () => {
    it('accepts a valid 56-character Stellar public key starting with G', () => {
      const parsed = FriendBotInputSchema.parse({ publicKey: validPubKey });
      expect(parsed.publicKey).toBe(validPubKey);
    });

    it('rejects a key that does not start with G', () => {
      const invalidKey = 'CBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
      expect(() => FriendBotInputSchema.parse({ publicKey: invalidKey })).toThrow(
        /Public key must start with G/
      );
    });

    it('rejects a key with incorrect length', () => {
      expect(() => FriendBotInputSchema.parse({ publicKey: 'GSHORT' })).toThrow(
        /Must be a 56-character Stellar public key/
      );
    });
  });

  describe('execute', () => {
    it('throws ConfigError on mainnet', async () => {
      mockNetwork = 'mainnet';
      const tool = new FriendBotTool();

      await expect(tool.execute({ publicKey: validPubKey })).rejects.toThrow(
        ConfigError
      );
    });

    it('fetches testnet friendbot URL and returns funding result', async () => {
      mockNetwork = 'testnet';
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ hash: 'tx-hash-friendbot-testnet-123' }),
      });
      global.fetch = mockFetch as any;

      const tool = new FriendBotTool();
      const result = await tool.execute({ publicKey: validPubKey });

      expect(mockFetch).toHaveBeenCalledWith(
        `https://friendbot.stellar.org?addr=${encodeURIComponent(validPubKey)}`
      );
      expect(result).toEqual({
        funded: true,
        txHash: 'tx-hash-friendbot-testnet-123',
      });
    });

    it('uses futurenet friendbot URL when network is futurenet', async () => {
      mockNetwork = 'futurenet';
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ txHash: 'tx-hash-futurenet-456' }),
      });
      global.fetch = mockFetch as any;

      const tool = new FriendBotTool();
      const result = await tool.execute({ publicKey: validPubKey });

      expect(mockFetch).toHaveBeenCalledWith(
        `https://friendbot-futurenet.stellar.org?addr=${encodeURIComponent(validPubKey)}`
      );
      expect(result).toEqual({
        funded: true,
        txHash: 'tx-hash-futurenet-456',
      });
    });

    it('throws error when friendbot responds with non-ok status', async () => {
      const mockFetch = vi.fn().mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'Account already funded',
      });
      global.fetch = mockFetch as any;

      const tool = new FriendBotTool();
      await expect(tool.execute({ publicKey: validPubKey })).rejects.toThrow(
        /Friendbot request failed with status 400: Account already funded/
      );
    });
  });
});
