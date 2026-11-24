/**
 * tests/nano_payment.test.ts
 *
 * Tests for NanoPaymentTool feeless settlement rail beside Stellar (#715).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { NanoPaymentTool, NanoPaymentInputSchema } from '../backend/tools/NanoPaymentTool';

const { nanoConfig } = vi.hoisted(() => ({
  nanoConfig: {
    NANO_RPC_URL: 'http://127.0.0.1:7076',
    NANO_ALLOW_SKIP_PRECHECK: false,
    STELLAR_NETWORK: 'testnet',
  },
}));

vi.mock('../backend/config', () => ({
  config: nanoConfig,
  getNanoSeed: () => 'A'.repeat(64),
}));
vi.mock('axios');

describe('NanoPaymentTool — Feeless settlement rail (#715)', () => {
  let tool: NanoPaymentTool;
  const VALID_NANO_ADDR = 'nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3';
  const VALID_XRB_ADDR = 'xrb_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3';
  const SUB_CENT_RAW = '1000000000000000000000000'; // 0.000001 XNO (sub-cent micro-payment)

  beforeEach(() => {
    vi.clearAllMocks();
    nanoConfig.NANO_ALLOW_SKIP_PRECHECK = false;
    tool = new NanoPaymentTool();
  });

  describe('Input validation', () => {
    it('accepts valid nano_ and xrb_ addresses with positive raw amount', () => {
      const parsedNano = NanoPaymentInputSchema.parse({
        recipient: VALID_NANO_ADDR,
        amountRaw: SUB_CENT_RAW,
      });
      expect(parsedNano.recipient).toBe(VALID_NANO_ADDR);

      const parsedXrb = NanoPaymentInputSchema.parse({
        recipient: VALID_XRB_ADDR,
        amountRaw: '1',
      });
      expect(parsedXrb.recipient).toBe(VALID_XRB_ADDR);
    });

    it('rejects a task-supplied RPC URL', () => {
      expect(() =>
        NanoPaymentInputSchema.parse({
          recipient: VALID_NANO_ADDR,
          amountRaw: SUB_CENT_RAW,
          rpcUrl: 'http://127.0.0.1:8080',
        })
      ).toThrow(/Unrecognized key/);
    });

    it('rejects a task-supplied RPC URL before making any request', async () => {
      await expect(
        tool.execute({
          recipient: VALID_NANO_ADDR,
          amountRaw: SUB_CENT_RAW,
          rpcUrl: 'http://127.0.0.1:8080',
        })
      ).rejects.toThrow(/Unrecognized key/);
      expect(axios.post).not.toHaveBeenCalled();
    });

    it('rejects invalid recipient addresses', () => {
      expect(() =>
        NanoPaymentInputSchema.parse({
          recipient: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', // Stellar addr
          amountRaw: SUB_CENT_RAW,
        })
      ).toThrow(/Invalid Nano address/);

      expect(() =>
        NanoPaymentInputSchema.parse({
          recipient: 'nano_invalid_short',
          amountRaw: SUB_CENT_RAW,
        })
      ).toThrow(/Invalid Nano address/);
    });

    it('rejects non-positive or non-numeric amountRaw', () => {
      expect(() =>
        NanoPaymentInputSchema.parse({
          recipient: VALID_NANO_ADDR,
          amountRaw: '0',
        })
      ).toThrow(/greater than zero/);

      expect(() =>
        NanoPaymentInputSchema.parse({
          recipient: VALID_NANO_ADDR,
          amountRaw: '-500',
        })
      ).toThrow(/unsigned integer/);

      expect(() =>
        NanoPaymentInputSchema.parse({
          recipient: VALID_NANO_ADDR,
          amountRaw: '0.001',
        })
      ).toThrow(/unsigned integer/);
    });
  });

  describe('Simulation gate / Pre-check', () => {
    it('passes pre-check when recipient account is open', async () => {
      vi.mocked(axios.post).mockResolvedValueOnce({
        data: {
          frontier: 'A'.repeat(64),
          open_block: 'B'.repeat(64),
          balance: '5000000000000000000000000',
        },
      });

      const result = await tool.precheckRecipient(VALID_NANO_ADDR);
      expect(result).toEqual({ passed: true, accountStatus: 'open' });
    });

    it('passes pre-check when recipient account is unopened (valid for open block)', async () => {
      vi.mocked(axios.post).mockResolvedValueOnce({
        data: {
          error: 'Account not found',
        },
      });

      const result = await tool.precheckRecipient(VALID_NANO_ADDR);
      expect(result).toEqual({ passed: true, accountStatus: 'unopened' });
    });

    it('fails closed when the recipient precheck cannot reach the Nano node', async () => {
      vi.mocked(axios.post).mockRejectedValueOnce(new Error('connection refused'));

      const result = await tool.precheckRecipient(VALID_NANO_ADDR);
      expect(result).toEqual({ passed: false, reason: 'network_error' });
    });
  });

  describe('Execution & Feeless Receipt', () => {
    it('executes a sub-cent payment and returns block hash receipt', async () => {
      vi.mocked(axios.post).mockResolvedValue({
        data: { frontier: 'D'.repeat(64), hash: 'C'.repeat(64) },
      });

      const result = await tool.execute({
        recipient: VALID_NANO_ADDR,
        amountRaw: SUB_CENT_RAW,
      });

      expect(result.network).toBe('nano');
      expect(result.recipient).toBe(VALID_NANO_ADDR);
      expect(result.amountRaw).toBe(SUB_CENT_RAW);
      expect(result.precheckPassed).toBe(true);
      expect(result.blockHash).toMatch(/^[A-F0-9]{64}$/);
      expect(result.timestamp).toBeDefined();
    });

    it('blocks a requested precheck bypass unless operator config explicitly allows it', async () => {
      await expect(
        tool.execute({
          recipient: VALID_NANO_ADDR,
          amountRaw: SUB_CENT_RAW,
          skipPrecheck: true,
        })
      ).rejects.toThrow(/disabled by operator configuration/);
      expect(axios.post).not.toHaveBeenCalled();
    });

    it('supports skipping precheck when operator config explicitly allows it', async () => {
      nanoConfig.NANO_ALLOW_SKIP_PRECHECK = true;
      const result = await tool.execute({
        recipient: VALID_NANO_ADDR,
        amountRaw: SUB_CENT_RAW,
        skipPrecheck: true,
      });

      expect(result.precheckPassed).toBe(true);
      expect(result.blockHash).toBeDefined();
    });

    it('does not broadcast when recipient precheck fails', async () => {
      vi.mocked(axios.post).mockRejectedValueOnce(new Error('connection refused'));

      await expect(
        tool.execute({ recipient: VALID_NANO_ADDR, amountRaw: SUB_CENT_RAW })
      ).rejects.toThrow(/Nano recipient precheck failed/);
      expect(axios.post).toHaveBeenCalledTimes(1);
    });
  });
});
