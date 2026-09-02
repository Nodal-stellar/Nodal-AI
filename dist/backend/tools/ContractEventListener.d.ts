/**
 * backend/tools/ContractEventListener.ts
 * Polling-based listener for Soroban contract events with automatic reconnect
 * and exponential backoff on stream drop.
 *
 * Soroban RPC has no WebSocket stream, so this tool polls getEvents()
 * on an interval and invokes a callback for each new matching event.
 *
 * Architecture: poll getEvents() → filter by eventTypes → invoke onEvent → repeat
 */
import { EventEmitter } from 'events';
import { rpc } from '@stellar/stellar-sdk';
export interface ContractEventListenerOptions {
    maxReconnectAttempts?: number;
    pollIntervalMs?: number;
}
export interface ContractEventListenerHandle extends EventEmitter {
    (): void;
    stop(): void;
}
export declare function listen(contractId: string, eventTypes: string[], onEvent: (event: rpc.Api.EventResponse) => void, options?: number | ContractEventListenerOptions): ContractEventListenerHandle;
//# sourceMappingURL=ContractEventListener.d.ts.map