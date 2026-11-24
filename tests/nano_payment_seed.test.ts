import { describe, expect, it, vi } from 'vitest';

vi.mock('../backend/config', () => ({
  config: {
    NANO_RPC_URL: 'http://127.0.0.1:7076',
    NANO_ALLOW_SKIP_PRECHECK: true,
    STELLAR_NETWORK: 'testnet',
  },
  getNanoSeed: () => undefined,
}));

vi.mock('axios', () => ({
  default: { post: vi.fn().mockResolvedValue({ data: {} }) },
}));

import { NanoPaymentTool } from '../backend/tools/NanoPaymentTool';
import { ConfigError, ValidationError } from '../backend/errors';

const recipient = `nano_${'1'.repeat(60)}`;
const seed = 'A'.repeat(64);

describe('NanoPaymentTool seed handling (#975)', () => {
  it('rejects a payload that carries senderSeed', async () => {
    const tool = new NanoPaymentTool(seed);
    await expect(
      tool.execute({ recipient, amountRaw: '1', senderSeed: seed, skipPrecheck: true })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('fails instead of falling back to a default seed when none is configured', async () => {
    const tool = new NanoPaymentTool();
    await expect(
      tool.execute({ recipient, amountRaw: '1', skipPrecheck: true })
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it('uses the configured seed when the payload is clean', async () => {
    const tool = new NanoPaymentTool(seed);
    const result = await tool.execute({ recipient, amountRaw: '1', skipPrecheck: true });
    expect(result.network).toBe('nano');
    expect(result.recipient).toBe(recipient);
  });
});
