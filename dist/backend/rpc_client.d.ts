/**
 * backend/rpc_client.ts
 * Thin wrapper around Horizon + Soroban RPC with retry logic and rate-limit awareness.
 */
import { Horizon, rpc, Transaction, FeeBumpTransaction, xdr } from '@stellar/stellar-sdk';
import CircuitBreaker from 'opossum';
export declare const RPC_BREAKER_OPTIONS: {
    errorThresholdPercentage: number;
    resetTimeout: number;
    timeout: number;
    volumeThreshold: number;
    rollingCountTimeout: number;
    rollingCountBuckets: number;
};
type HorizonAccount = Awaited<ReturnType<Horizon.Server['loadAccount']>>;
/** Drop a cached account, or the whole cache when no key is given. */
export declare function invalidateAccountCache(publicKey?: string): void;
export declare function attachBreakerTelemetry<TArgs extends unknown[], TResult>(breaker: CircuitBreaker<TArgs, TResult>, name: string): CircuitBreaker<TArgs, TResult>;
export declare function createRpcBreaker<TArgs extends unknown[], TResult>(name: string, action: (...args: TArgs) => Promise<TResult>): CircuitBreaker<TArgs, TResult>;
export declare function resolveNetworkPassphrase(network: string): string;
export declare class TimeoutError extends Error {
    constructor(ms: number);
}
export declare class StellarRPCError extends Error {
    readonly cause: unknown;
    constructor(message: string, cause: unknown);
}
export declare class RateLimitError extends Error {
    readonly retryAfterSeconds: number;
    constructor(retryAfterSeconds: number);
}
export declare function DEFAULT_IS_RETRYABLE(err: unknown): boolean;
export declare function withRetry<T>(fn: () => Promise<T>, retries?: number, delayMs?: number, isRetryable?: (err: unknown) => boolean, maxDelayMs?: number): Promise<T>;
export declare function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T>;
export declare const horizonServer: Horizon.Server;
/**
 * Load a Horizon account, serving a cached copy when one is still fresh.
 *
 * **The cache is bypassed with `forceRefresh` on the sequence-recovery paths,
 * and cleared after every submission.** A Horizon account carries the source
 * sequence number, and `TransactionBuilder` increments it in place while
 * building. Serving one cached record to two builders would hand out the same
 * (or a locally-drifted) sequence, which is the `tx_bad_seq` failure this cache
 * is meant to reduce. Anything that can move the sequence therefore drops the
 * entry — the cache exists to collapse bursts of *read-only* lookups
 * (balances, trustlines, account info), not to survive a transaction.
 */
export declare function loadAccount(publicKey: string, options?: {
    forceRefresh?: boolean;
}): Promise<HorizonAccount>;
export declare function submitTransaction(tx: Transaction | FeeBumpTransaction): Promise<Horizon.HorizonApi.SubmitTransactionResponse>;
export declare const sorobanServer: rpc.Server;
export declare function simulateSorobanTx(tx: Transaction): Promise<rpc.Api.SimulateTransactionResponse>;
/**
 * A simulated + assembled Soroban transaction alongside the diagnostic events
 * the simulation produced.
 *
 * The events are what the transaction would emit on-chain. Tools that move
 * value (e.g. contract invocations that internally call the Stellar Asset
 * Contract) inspect them to learn how much would actually be transferred
 * before signing or broadcasting — see {@link SorobanInvokeTool}.
 */
export interface PreparedSorobanTx {
    /** The transaction with the Soroban resource footprint attached. */
    tx: Transaction;
    /** Diagnostic events predicted by the simulation, in XDR form. */
    events: xdr.DiagnosticEvent[];
}
export declare function prepareSorobanTxWithEvents(tx: Transaction): Promise<PreparedSorobanTx>;
export declare function prepareSorobanTx(tx: Transaction): Promise<Transaction>;
export {};
//# sourceMappingURL=rpc_client.d.ts.map