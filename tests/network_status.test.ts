/**
 * tests/network_status.test.ts
 * Unit tests for NetworkStatusTool.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../backend/config', () => ({
  config: {
    STELLAR_NETWORK: 'testnet',
    HORIZON_URL: 'https://horizon-testnet.stellar.org',
    SOROBAN_RPC_URL: 'https://soroban-testnet.stellar.org',
  },
}));

vi.mock('../backend/rpc_client', () => ({
  sorobanServer: {
    getHealth: vi.fn(),
  },
}));

vi.mock('axios');

import axios from 'axios';
import { NetworkStatusTool } from '../backend/tools/NetworkStatusTool';

describe('NetworkStatusTool', () => {
  const mockSorobanServer = {
    getHealth: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns healthy status when both Horizon and Soroban respond positively', async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({
      status: 200,
      statusText: 'OK',
    } as any);

    mockSorobanServer.getHealth.mockResolvedValueOnce({ status: 'healthy' });

    const tool = new NetworkStatusTool(
      'https://horizon-testnet.stellar.org',
      mockSorobanServer as any,
      'testnet'
    );

    const result = await tool.execute();

    expect(result.network).toBe('testnet');
    expect(result.horizon.healthy).toBe(true);
    expect(result.horizon.status).toBe('OK');
    expect(result.horizon.latencyMs).toBeGreaterThanOrEqual(0);

    expect(result.soroban.healthy).toBe(true);
    expect(result.soroban.status).toBe('healthy');
    expect(result.soroban.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('handles Horizon error gracefully while Soroban succeeds', async () => {
    vi.mocked(axios.get).mockRejectedValueOnce(new Error('Network timeout'));
    mockSorobanServer.getHealth.mockResolvedValueOnce({ status: 'healthy' });

    const tool = new NetworkStatusTool(
      'https://broken-horizon.example.com',
      mockSorobanServer as any,
      'custom-net'
    );

    const result = await tool.execute();

    expect(result.horizon.healthy).toBe(false);
    expect(result.horizon.error).toBe('Network timeout');
    expect(result.soroban.healthy).toBe(true);
  });

  it('handles Soroban RPC error gracefully while Horizon succeeds', async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({
      status: 200,
      statusText: 'OK',
    } as any);

    mockSorobanServer.getHealth.mockRejectedValueOnce(new Error('RPC unavailable'));

    const tool = new NetworkStatusTool(
      'https://horizon.example.com',
      mockSorobanServer as any,
      'testnet'
    );

    const result = await tool.execute();

    expect(result.horizon.healthy).toBe(true);
    expect(result.soroban.healthy).toBe(false);
    expect(result.soroban.error).toBe('RPC unavailable');
  });

  it('marks unhealthy if Horizon responds with 500 error code', async () => {
    vi.mocked(axios.get).mockResolvedValueOnce({
      status: 503,
      statusText: 'Service Unavailable',
    } as any);

    mockSorobanServer.getHealth.mockResolvedValueOnce({ status: 'pass' });

    const tool = new NetworkStatusTool(
      'https://horizon.example.com',
      mockSorobanServer as any,
      'testnet'
    );

    const result = await tool.execute();

    expect(result.horizon.healthy).toBe(false);
    expect(result.horizon.status).toBe('Service Unavailable');
    expect(result.soroban.healthy).toBe(true);
  });
});
