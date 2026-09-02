"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const ContractEventListener_1 = require("../backend/tools/ContractEventListener");
const rpcClient = __importStar(require("../backend/rpc_client"));
vitest_1.vi.mock('../backend/rpc_client', () => ({
    sorobanServer: {
        getEvents: vitest_1.vi.fn(),
        getLatestLedger: vitest_1.vi.fn(),
    },
}));
vitest_1.vi.mock('../backend/config', () => ({
    config: {
        RETRY_DELAY_MS: 100,
        CONTRACT_EVENT_POLL_MS: 300,
    },
}));
vitest_1.vi.mock('../backend/logger', () => ({
    logger: {
        error: vitest_1.vi.fn(),
        info: vitest_1.vi.fn(),
        warn: vitest_1.vi.fn(),
        debug: vitest_1.vi.fn(),
    },
}));
const VALID_CONTRACT = 'CDPVBHPSVYKWSI5ECEA4DASBG3RBNU5EHEE3DHNFX7RMBCZV66CSC7NH';
function makeEvent(topicStr, pagingToken) {
    return {
        topic: [{ toString: () => topicStr }],
        pagingToken,
    };
}
(0, vitest_1.describe)('ContractEventListener', () => {
    let stopListening;
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.clearAllMocks();
        vitest_1.vi.useFakeTimers();
        vitest_1.vi.mocked(rpcClient.sorobanServer.getLatestLedger).mockResolvedValue({
            sequence: 1000,
        });
    });
    (0, vitest_1.afterEach)(() => {
        stopListening?.();
        vitest_1.vi.useRealTimers();
    });
    (0, vitest_1.it)('invokes onEvent for matching events on poll', async () => {
        const event = makeEvent('released', 'tok-1');
        vitest_1.vi.mocked(rpcClient.sorobanServer.getEvents).mockResolvedValue({
            events: [event],
        });
        const onEvent = vitest_1.vi.fn();
        stopListening = (0, ContractEventListener_1.listen)(VALID_CONTRACT, ['released'], onEvent);
        await vitest_1.vi.advanceTimersByTimeAsync(200);
        (0, vitest_1.expect)(onEvent).toHaveBeenCalledWith(event);
    });
    (0, vitest_1.it)('does not invoke onEvent when topic does not match eventTypes', async () => {
        const event = makeEvent('cancelled', 'tok-1');
        vitest_1.vi.mocked(rpcClient.sorobanServer.getEvents).mockResolvedValue({
            events: [event],
        });
        const onEvent = vitest_1.vi.fn();
        stopListening = (0, ContractEventListener_1.listen)(VALID_CONTRACT, ['released'], onEvent);
        await vitest_1.vi.advanceTimersByTimeAsync(200);
        (0, vitest_1.expect)(onEvent).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)('stops polling after stopListening is called', async () => {
        vitest_1.vi.mocked(rpcClient.sorobanServer.getEvents).mockResolvedValue({
            events: [],
        });
        const onEvent = vitest_1.vi.fn();
        stopListening = (0, ContractEventListener_1.listen)(VALID_CONTRACT, [], onEvent);
        await vitest_1.vi.advanceTimersByTimeAsync(200);
        const callsBeforeStop = vitest_1.vi.mocked(rpcClient.sorobanServer.getEvents).mock.calls.length;
        stopListening();
        await vitest_1.vi.advanceTimersByTimeAsync(500);
        (0, vitest_1.expect)(vitest_1.vi.mocked(rpcClient.sorobanServer.getEvents).mock.calls.length).toBe(callsBeforeStop);
    });
    (0, vitest_1.it)('logs an error and keeps polling when getEvents rejects', async () => {
        const { logger } = await Promise.resolve().then(() => __importStar(require('../backend/logger')));
        vitest_1.vi.mocked(rpcClient.sorobanServer.getEvents).mockRejectedValueOnce(new Error('RPC unavailable'));
        const onEvent = vitest_1.vi.fn();
        stopListening = (0, ContractEventListener_1.listen)(VALID_CONTRACT, [], onEvent);
        await vitest_1.vi.advanceTimersByTimeAsync(200);
        (0, vitest_1.expect)(logger.error).toHaveBeenCalled();
    });
    (0, vitest_1.it)('polls sorobanServer.getEvents() at the configured interval', async () => {
        vitest_1.vi.mocked(rpcClient.sorobanServer.getEvents).mockResolvedValue({
            events: [],
        });
        const onEvent = vitest_1.vi.fn();
        stopListening = (0, ContractEventListener_1.listen)(VALID_CONTRACT, [], onEvent);
        await vitest_1.vi.advanceTimersByTimeAsync(600);
        (0, vitest_1.expect)(rpcClient.sorobanServer.getEvents).toHaveBeenCalledTimes(3);
    });
    (0, vitest_1.it)('emits parsed events to registered callback', async () => {
        const event = makeEvent('released', 'tok-1');
        vitest_1.vi.mocked(rpcClient.sorobanServer.getEvents).mockResolvedValue({
            events: [event],
        });
        const onEvent = vitest_1.vi.fn();
        stopListening = (0, ContractEventListener_1.listen)(VALID_CONTRACT, ['released'], onEvent);
        await vitest_1.vi.advanceTimersByTimeAsync(200);
        (0, vitest_1.expect)(onEvent).toHaveBeenCalledWith(event);
    });
    (0, vitest_1.it)('handles sorobanServer.getEvents() rejection without crashing', async () => {
        vitest_1.vi.mocked(rpcClient.sorobanServer.getEvents)
            .mockRejectedValueOnce(new Error('RPC unavailable'))
            .mockResolvedValue({ events: [] });
        const onEvent = vitest_1.vi.fn();
        stopListening = (0, ContractEventListener_1.listen)(VALID_CONTRACT, [], onEvent);
        // The listener should keep polling on subsequent ticks rather than dying.
        await vitest_1.vi.advanceTimersByTimeAsync(600);
        (0, vitest_1.expect)(rpcClient.sorobanServer.getEvents).toHaveBeenCalledTimes(3);
    });
    (0, vitest_1.it)('stops polling when stop() is called', async () => {
        vitest_1.vi.mocked(rpcClient.sorobanServer.getEvents).mockResolvedValue({
            events: [],
        });
        const onEvent = vitest_1.vi.fn();
        stopListening = (0, ContractEventListener_1.listen)(VALID_CONTRACT, [], onEvent);
        await vitest_1.vi.advanceTimersByTimeAsync(200);
        const callsBeforeStop = vitest_1.vi.mocked(rpcClient.sorobanServer.getEvents).mock.calls.length;
        stopListening();
        await vitest_1.vi.advanceTimersByTimeAsync(600);
        (0, vitest_1.expect)(vitest_1.vi.mocked(rpcClient.sorobanServer.getEvents).mock.calls.length).toBe(callsBeforeStop);
    });
    (0, vitest_1.it)('does not emit events after stop() is called', async () => {
        const event = makeEvent('released', 'tok-1');
        vitest_1.vi.mocked(rpcClient.sorobanServer.getEvents).mockResolvedValue({
            events: [event],
        });
        const onEvent = vitest_1.vi.fn();
        stopListening = (0, ContractEventListener_1.listen)(VALID_CONTRACT, ['released'], onEvent);
        await vitest_1.vi.advanceTimersByTimeAsync(200);
        (0, vitest_1.expect)(onEvent).toHaveBeenCalledTimes(1);
        stopListening();
        await vitest_1.vi.advanceTimersByTimeAsync(1000);
        (0, vitest_1.expect)(onEvent).toHaveBeenCalledTimes(1);
    });
    // ── Reconnect & Exhaustion ──────────────────────────────────────────────────
    (0, vitest_1.it)('reconnects with exponential backoff when stream drops and resumes emitting events', async () => {
        const event = makeEvent('released', 'tok-2');
        vitest_1.vi.mocked(rpcClient.sorobanServer.getEvents)
            .mockRejectedValueOnce(new Error('Connection reset 1'))
            .mockRejectedValueOnce(new Error('Connection reset 2'))
            .mockResolvedValueOnce({ events: [event] })
            .mockResolvedValue({ events: [] });
        const onEvent = vitest_1.vi.fn();
        const onError = vitest_1.vi.fn();
        const handle = (0, ContractEventListener_1.listen)(VALID_CONTRACT, ['released'], onEvent);
        handle.on('error', onError);
        stopListening = handle;
        // t=0: call 1 fails (attempt 1 -> wait 300ms)
        await vitest_1.vi.advanceTimersByTimeAsync(300);
        // t=300: call 2 fails (attempt 2 -> wait 600ms)
        await vitest_1.vi.advanceTimersByTimeAsync(600);
        // t=900: call 3 succeeds, receives event!
        await vitest_1.vi.advanceTimersByTimeAsync(100);
        (0, vitest_1.expect)(onEvent).toHaveBeenCalledWith(event);
        (0, vitest_1.expect)(onError).not.toHaveBeenCalled();
        // Now advance another 300ms: pollIntervalMs has reset back to normal interval
        await vitest_1.vi.advanceTimersByTimeAsync(300);
        (0, vitest_1.expect)(rpcClient.sorobanServer.getEvents).toHaveBeenCalledTimes(4);
    });
    (0, vitest_1.it)('emits error event on returned EventEmitter when reconnect retries are exhausted (default 5)', async () => {
        const rpcError = new Error('RPC permanent drop');
        vitest_1.vi.mocked(rpcClient.sorobanServer.getEvents).mockRejectedValue(rpcError);
        const onEvent = vitest_1.vi.fn();
        const onError = vitest_1.vi.fn();
        const handle = (0, ContractEventListener_1.listen)(VALID_CONTRACT, [], onEvent);
        handle.on('error', onError);
        stopListening = handle;
        // Attempt 1: t=0, fails. Wait 300ms.
        await vitest_1.vi.advanceTimersByTimeAsync(300);
        // Attempt 2: t=300, fails. Wait 600ms.
        await vitest_1.vi.advanceTimersByTimeAsync(600);
        // Attempt 3: t=900, fails. Wait 1200ms.
        await vitest_1.vi.advanceTimersByTimeAsync(1200);
        // Attempt 4: t=2100, fails. Wait 2400ms.
        await vitest_1.vi.advanceTimersByTimeAsync(2400);
        // Attempt 5: t=4500, fails -> exhaustion!
        await vitest_1.vi.advanceTimersByTimeAsync(100);
        (0, vitest_1.expect)(onError).toHaveBeenCalledOnce();
        (0, vitest_1.expect)(onError).toHaveBeenCalledWith(rpcError);
        (0, vitest_1.expect)(rpcClient.sorobanServer.getEvents).toHaveBeenCalledTimes(5);
        // Verify polling has stopped completely
        await vitest_1.vi.advanceTimersByTimeAsync(10000);
        (0, vitest_1.expect)(rpcClient.sorobanServer.getEvents).toHaveBeenCalledTimes(5);
    });
    (0, vitest_1.it)('respects maxReconnectAttempts configurable at call time', async () => {
        const rpcError = new Error('Stream dropped');
        vitest_1.vi.mocked(rpcClient.sorobanServer.getEvents).mockRejectedValue(rpcError);
        const onEvent = vitest_1.vi.fn();
        const onError = vitest_1.vi.fn();
        const handle = (0, ContractEventListener_1.listen)(VALID_CONTRACT, [], onEvent, { maxReconnectAttempts: 2 });
        handle.on('error', onError);
        stopListening = handle;
        // Attempt 1: t=0, fails. Wait 300ms.
        await vitest_1.vi.advanceTimersByTimeAsync(300);
        // Attempt 2: t=300, fails -> exhaustion at 2!
        await vitest_1.vi.advanceTimersByTimeAsync(100);
        (0, vitest_1.expect)(onError).toHaveBeenCalledOnce();
        (0, vitest_1.expect)(onError).toHaveBeenCalledWith(rpcError);
        (0, vitest_1.expect)(rpcClient.sorobanServer.getEvents).toHaveBeenCalledTimes(2);
        await vitest_1.vi.advanceTimersByTimeAsync(5000);
        (0, vitest_1.expect)(rpcClient.sorobanServer.getEvents).toHaveBeenCalledTimes(2);
    });
    // ── Start / Stop lifecycle (#457) ──────────────────────────────────────────
    (0, vitest_1.it)('start → emit 2 events → stop → no further events arrive', async () => {
        const event1 = makeEvent('released', 'tok-10');
        const event2 = makeEvent('released', 'tok-11');
        // First two polls return events; subsequent polls return empty
        vitest_1.vi.mocked(rpcClient.sorobanServer.getEvents)
            .mockResolvedValueOnce({ events: [event1] })
            .mockResolvedValueOnce({ events: [event2] })
            .mockResolvedValue({ events: [] });
        const onEvent = vitest_1.vi.fn();
        stopListening = (0, ContractEventListener_1.listen)(VALID_CONTRACT, ['released'], onEvent);
        // Advance through two poll cycles (each 300ms)
        await vitest_1.vi.advanceTimersByTimeAsync(300);
        await vitest_1.vi.advanceTimersByTimeAsync(300);
        (0, vitest_1.expect)(onEvent).toHaveBeenCalledTimes(2);
        const callsAtStop = vitest_1.vi.mocked(rpcClient.sorobanServer.getEvents).mock.calls.length;
        stopListening();
        // Advance far past the poll interval — no further calls should occur
        await vitest_1.vi.advanceTimersByTimeAsync(2000);
        (0, vitest_1.expect)(vitest_1.vi.mocked(rpcClient.sorobanServer.getEvents).mock.calls.length).toBe(callsAtStop);
        // onEvent was invoked exactly twice and nothing more
        (0, vitest_1.expect)(onEvent).toHaveBeenCalledTimes(2);
    });
    (0, vitest_1.it)('stop() before any events arrive — listener does not throw', async () => {
        vitest_1.vi.mocked(rpcClient.sorobanServer.getEvents).mockResolvedValue({
            events: [],
        });
        const onEvent = vitest_1.vi.fn();
        // stop() immediately — the in-flight first poll may or may not have
        // fired, but nothing should throw
        (0, vitest_1.expect)(() => {
            stopListening = (0, ContractEventListener_1.listen)(VALID_CONTRACT, [], onEvent);
            stopListening();
        }).not.toThrow();
        // Confirm polling truly stops
        await vitest_1.vi.advanceTimersByTimeAsync(2000);
        (0, vitest_1.expect)(onEvent).not.toHaveBeenCalled();
    });
    (0, vitest_1.it)('stop() is idempotent — calling it twice does not throw', async () => {
        vitest_1.vi.mocked(rpcClient.sorobanServer.getEvents).mockResolvedValue({
            events: [],
        });
        const onEvent = vitest_1.vi.fn();
        stopListening = (0, ContractEventListener_1.listen)(VALID_CONTRACT, [], onEvent);
        await vitest_1.vi.advanceTimersByTimeAsync(300);
        (0, vitest_1.expect)(() => {
            stopListening();
            stopListening(); // second call should be a no-op
        }).not.toThrow();
    });
    (0, vitest_1.it)('no timer leak after stop() — clearTimeout called for the pending timer', async () => {
        vitest_1.vi.mocked(rpcClient.sorobanServer.getEvents).mockResolvedValue({
            events: [],
        });
        const clearTimeoutSpy = vitest_1.vi.spyOn(globalThis, 'clearTimeout');
        const onEvent = vitest_1.vi.fn();
        stopListening = (0, ContractEventListener_1.listen)(VALID_CONTRACT, [], onEvent);
        // Let one poll cycle complete so a next-tick timer is scheduled
        await vitest_1.vi.advanceTimersByTimeAsync(300);
        stopListening();
        // clearTimeout must have been called to cancel the scheduled next poll
        (0, vitest_1.expect)(clearTimeoutSpy).toHaveBeenCalled();
        clearTimeoutSpy.mockRestore();
    });
});
//# sourceMappingURL=contract_event_listener.test.js.map