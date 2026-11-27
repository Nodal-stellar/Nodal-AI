import { Contract, rpc, scValToNative, TransactionBuilder } from '@stellar/stellar-sdk';
import { config } from './config';
import { loadAccount, resolveNetworkPassphrase, simulateSorobanTx } from './rpc_client';
import { toStroops } from './utils/amount';

export interface OnChainPolicy {
  limit: string;
  window: number;
  spent: string;
  windowStart: number;
  owner: string;
  token: string;
}

function nativePolicy(value: unknown): OnChainPolicy {
  const p = value as Record<string, unknown>;
  const get = (key: string, fallback: unknown) => p[key] ?? p[key.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] ?? fallback;
  return {
    owner: String(get('owner', '')),
    token: String(get('token', '')),
    limit: String(get('limit', '0')),
    window: Number(get('window', 0)),
    windowStart: Number(get('window_start', get('windowStart', 0))),
    spent: String(get('spent', '0')),
  };
}

export async function getOnChainPolicy(): Promise<OnChainPolicy | null> {
  if (!config.AGENT_POLICY_ACCOUNT) return null;
  const account = await loadAccount(config.AGENT_PUBLIC_KEY);
  const tx = new TransactionBuilder(account, {
    fee: '0',
    networkPassphrase: resolveNetworkPassphrase(config.STELLAR_NETWORK),
  })
    .addOperation(new Contract(config.AGENT_POLICY_ACCOUNT).call('get_policy'))
    .setTimeout(30)
    .build();
  const result = await simulateSorobanTx(tx);
  if (rpc.Api.isSimulationError(result)) throw new Error(`Policy query failed: ${result.error ?? 'simulation error'}`);
  return nativePolicy(scValToNative(result.result.retval));
}

export async function validateOnChainPolicy(): Promise<void> {
  const policy = await getOnChainPolicy();
  if (!policy) return;
  const configured = toStroops(config.AGENT_SPENDING_LIMIT);
  if (BigInt(policy.limit) < configured) {
    throw new Error(
      `AGENT_SPENDING_LIMIT ${config.AGENT_SPENDING_LIMIT} exceeds on-chain policy limit ${policy.limit} stroops`
    );
  }
}
