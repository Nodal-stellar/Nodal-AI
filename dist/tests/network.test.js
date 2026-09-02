"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
// We test the network module directly
const network_1 = require("../backend/network");
(0, vitest_1.describe)('Network Rate Limiting', () => {
    (0, vitest_1.beforeEach)(() => {
        // Reset by calling handle with past timestamp to clear
        // We cant access internals, so test via public API
    });
    (0, vitest_1.it)('should not be throttled initially', () => {
        (0, vitest_1.expect)((0, network_1.isThrottled)()).toBe(false);
        (0, vitest_1.expect)((0, network_1.getBackoffStatus)().active).toBe(false);
    });
    (0, vitest_1.it)('should activate backoff on 429 with Retry-After', () => {
        (0, network_1.handleRateLimitResponse)('60');
        (0, vitest_1.expect)((0, network_1.isThrottled)()).toBe(true);
        (0, vitest_1.expect)((0, network_1.getBackoffStatus)().active).toBe(true);
        (0, vitest_1.expect)((0, network_1.getBackoffStatus)().retryAfterSeconds).toBe(60);
    });
    (0, vitest_1.it)('should use default 30s when no Retry-After header', () => {
        (0, network_1.handleRateLimitResponse)(null);
        (0, vitest_1.expect)((0, network_1.isThrottled)()).toBe(true);
        (0, vitest_1.expect)((0, network_1.getBackoffStatus)().retryAfterSeconds).toBe(30);
    });
    (0, vitest_1.it)('should not be throttled after backoff expires', async () => {
        (0, network_1.handleRateLimitResponse)('1');
        (0, vitest_1.expect)((0, network_1.isThrottled)()).toBe(true);
        await new Promise((r) => setTimeout(r, 1100));
        (0, vitest_1.expect)((0, network_1.isThrottled)()).toBe(false);
    });
});
(0, vitest_1.describe)('withBackoffGuard queuing behaviour', () => {
    (0, vitest_1.beforeEach)(() => {
        vitest_1.vi.useFakeTimers();
    });
    (0, vitest_1.afterEach)(() => {
        vitest_1.vi.useRealTimers();
    });
    (0, vitest_1.it)('queues a call when throttled and executes it after backoff clears', async () => {
        (0, network_1.handleRateLimitResponse)('5');
        (0, vitest_1.expect)((0, network_1.isThrottled)()).toBe(true);
        const fn = vitest_1.vi.fn().mockResolvedValue('done');
        const resultPromise = (0, network_1.withBackoffGuard)(fn);
        // Still throttled — the callback must not run yet.
        (0, vitest_1.expect)(fn).not.toHaveBeenCalled();
        await vitest_1.vi.advanceTimersByTimeAsync(5000);
        await (0, vitest_1.expect)(resultPromise).resolves.toBe('done');
        (0, vitest_1.expect)(fn).toHaveBeenCalledTimes(1);
    });
    (0, vitest_1.it)('drains all queued callbacks in order when lock clears', async () => {
        (0, network_1.handleRateLimitResponse)('5');
        const order = [];
        const makeFn = (n) => vitest_1.vi.fn().mockImplementation(async () => {
            order.push(n);
            return n;
        });
        const fn1 = makeFn(1);
        const fn2 = makeFn(2);
        const fn3 = makeFn(3);
        const p1 = (0, network_1.withBackoffGuard)(fn1);
        const p2 = (0, network_1.withBackoffGuard)(fn2);
        const p3 = (0, network_1.withBackoffGuard)(fn3);
        (0, vitest_1.expect)((0, network_1.getBackoffStatus)().queueSize).toBe(3);
        await vitest_1.vi.advanceTimersByTimeAsync(5000);
        await Promise.all([p1, p2, p3]);
        (0, vitest_1.expect)(order).toEqual([1, 2, 3]);
    });
    (0, vitest_1.it)('a queued callback that rejects propagates the rejection to the caller', async () => {
        (0, network_1.handleRateLimitResponse)('5');
        const error = new Error('queued callback failed');
        const fn = vitest_1.vi.fn().mockRejectedValue(error);
        const resultPromise = (0, network_1.withBackoffGuard)(fn);
        // Attach the rejection assertion before advancing timers — the queued
        // callback settles resultPromise as soon as the timer fires, and leaving
        // it unhandled until the next statement is enough for Node to flag it as
        // an unhandled rejection even though this test does go on to handle it.
        const assertion = (0, vitest_1.expect)(resultPromise).rejects.toThrow('queued callback failed');
        await vitest_1.vi.advanceTimersByTimeAsync(5000);
        await assertion;
    });
    (0, vitest_1.it)('does not strand a queued callback when a stale auto-clear timer fires mid-enqueue (concurrent enqueue + expiry race)', async () => {
        (0, network_1.handleRateLimitResponse)('5'); // generation 1, auto-clear timer fires at +5000ms
        await vitest_1.vi.advanceTimersByTimeAsync(2000);
        // A fresh 429 arrives before the first backoff expired — this activates
        // generation 2 and reschedules the auto-clear, but the generation-1
        // timer from above is still pending and will fire at the 5000ms mark.
        (0, network_1.handleRateLimitResponse)('10'); // generation 2, auto-clear timer fires at +12000ms
        const fn = vitest_1.vi.fn().mockResolvedValue('done');
        const resultPromise = (0, network_1.withBackoffGuard)(fn);
        (0, vitest_1.expect)((0, network_1.getBackoffStatus)().queueSize).toBe(1);
        // The stale generation-1 timer fires here. It must not clear the still
        // active generation-2 backoff or strand/drop the queued callback.
        await vitest_1.vi.advanceTimersByTimeAsync(3000); // total elapsed: 5000ms
        (0, vitest_1.expect)((0, network_1.isThrottled)()).toBe(true);
        (0, vitest_1.expect)((0, network_1.getBackoffStatus)().queueSize).toBe(1);
        (0, vitest_1.expect)(fn).not.toHaveBeenCalled();
        // The real generation-2 timer fires here and drains the queue.
        await vitest_1.vi.advanceTimersByTimeAsync(7000); // total elapsed: 12000ms
        await (0, vitest_1.expect)(resultPromise).resolves.toBe('done');
        (0, vitest_1.expect)((0, network_1.getBackoffStatus)().queueSize).toBe(0);
        (0, vitest_1.expect)((0, network_1.isThrottled)()).toBe(false);
    });
    (0, vitest_1.it)('rejects a callback enqueued in an earlier backoff generation once a later generation drains the queue', async () => {
        (0, network_1.handleRateLimitResponse)('5'); // generation 1
        const fn = vitest_1.vi.fn().mockResolvedValue('should not run');
        const resultPromise = (0, network_1.withBackoffGuard)(fn);
        resultPromise.catch(() => { });
        // Superseded before its own timer fires.
        (0, network_1.handleRateLimitResponse)('5'); // generation 2
        await vitest_1.vi.advanceTimersByTimeAsync(5000);
        await (0, vitest_1.expect)(resultPromise).rejects.toThrow(/superseded/i);
        (0, vitest_1.expect)(fn).not.toHaveBeenCalled();
        (0, vitest_1.expect)((0, network_1.getBackoffStatus)().queueSize).toBe(0);
    });
});
//# sourceMappingURL=network.test.js.map