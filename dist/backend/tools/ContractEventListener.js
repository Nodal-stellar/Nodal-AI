"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.listen = listen;
const events_1 = require("events");
const config_1 = require("../config");
const logger_1 = require("../logger");
const rpc_client_1 = require("../rpc_client");
function createListenerHandle(onStop) {
    const handle = function () {
        onStop();
    };
    Object.setPrototypeOf(handle, events_1.EventEmitter.prototype);
    events_1.EventEmitter.call(handle);
    handle.stop = onStop;
    return handle;
}
function listen(contractId, eventTypes, onEvent, options) {
    let cursor;
    let startLedgerPromise;
    const maxReconnectAttempts = typeof options === 'number' ? options : (options?.maxReconnectAttempts ?? 5);
    const pollIntervalMs = (typeof options === 'object' && options?.pollIntervalMs) ||
        config_1.config.CONTRACT_EVENT_POLL_MS ||
        config_1.config.RETRY_DELAY_MS * 2;
    let reconnectAttempts = 0;
    let isStopped = false;
    let timerId;
    const stop = () => {
        isStopped = true;
        if (timerId) {
            clearTimeout(timerId);
            timerId = undefined;
        }
    };
    const handle = createListenerHandle(stop);
    const poll = async () => {
        if (isStopped)
            return;
        try {
            if (!cursor && !startLedgerPromise) {
                startLedgerPromise = rpc_client_1.sorobanServer.getLatestLedger().then((l) => l.sequence);
            }
            const response = await rpc_client_1.sorobanServer.getEvents({
                filters: [{ type: 'contract', contractIds: [contractId] }],
                ...(cursor ? { cursor } : { startLedger: await startLedgerPromise }),
            });
            // Successfully contacted RPC: reset reconnect attempts
            reconnectAttempts = 0;
            for (const event of response.events) {
                const matches = eventTypes.length === 0 || event.topic.some((t) => eventTypes.includes(t.toString()));
                if (matches)
                    onEvent(event);
            }
            if (response.events.length > 0) {
                const lastEvent = response.events[response.events.length - 1];
                if (lastEvent) {
                    cursor = lastEvent.pagingToken;
                }
            }
            else if ('cursor' in response && response.cursor) {
                cursor = response.cursor;
            }
            if (!isStopped) {
                timerId = setTimeout(poll, pollIntervalMs);
            }
        }
        catch (err) {
            reconnectAttempts++;
            logger_1.logger.error('ContractEventListener polling error', {
                contractId,
                reconnectAttempts,
                maxReconnectAttempts,
                error: err.message,
            });
            if (reconnectAttempts >= maxReconnectAttempts) {
                isStopped = true;
                if (timerId) {
                    clearTimeout(timerId);
                    timerId = undefined;
                }
                handle.emit('error', err);
                return;
            }
            if (!isStopped) {
                const baseDelay = pollIntervalMs;
                const exponential = baseDelay * Math.pow(2, reconnectAttempts - 1);
                const backoffDelay = Math.min(exponential, 30_000);
                timerId = setTimeout(poll, backoffDelay);
            }
        }
    };
    void poll();
    return handle;
}
//# sourceMappingURL=ContractEventListener.js.map