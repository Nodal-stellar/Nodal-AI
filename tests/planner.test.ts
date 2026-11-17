import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PayFiAgent } from '../backend/agent';
import { llmUsage } from '../backend/ai/llm';
import { Planner } from '../backend/planner';

function response(status: number, body: unknown, headers?: Record<string, string>): Response {
  const init: ResponseInit = { status };
  if (headers) init.headers = headers;
  return new Response(JSON.stringify(body), init);
}

function testAgent(): PayFiAgent {
  return { run: vi.fn() } as unknown as PayFiAgent;
}

describe('Planner LLM reliability', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('retries 429 and 5xx responses twice before succeeding and records usage', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(503, { error: 'temporary outage' }))
      .mockResolvedValueOnce(response(429, { error: 'rate limited' }))
      .mockResolvedValueOnce(
        response(200, {
          choices: [{ message: { content: '[]' } }],
          usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    const planner = new Planner(testAgent(), {
      llmEndpoint: 'https://llm.test/v1/chat/completions',
      llmRetryBaseDelayMs: 0,
      sessionId: 'planner-retry-test',
    });

    const plan = await planner.plan('check my balance', { runReadonly: false });

    expect(plan.tasks).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    for (const call of fetchMock.mock.calls) {
      expect(call[1]?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(llmUsage.getSessionUsage('planner-retry-test')?.totalTokens).toBe(15);
  });

  it('stops retrying after two retryable failures', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response(500, { error: 'server failure' }));
    vi.stubGlobal('fetch', fetchMock);

    const planner = new Planner(testAgent(), {
      llmEndpoint: 'https://llm.test/v1/chat/completions',
      llmRetryBaseDelayMs: 0,
      sessionId: 'planner-exhausted-test',
    });

    await expect(planner.plan('check my balance', { runReadonly: false })).rejects.toThrow(
      'LLM call failed: 500'
    );
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(llmUsage.getSessionUsage('planner-exhausted-test')?.totalTokens).toBe(0);
  });

  it('aborts a hung provider call at the configured timeout', async () => {
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
        })
    );
    vi.stubGlobal('fetch', fetchMock);

    const planner = new Planner(testAgent(), {
      llmEndpoint: 'https://llm.test/v1/chat/completions',
      llmTimeoutMs: 10,
      sessionId: 'planner-timeout-test',
    });

    await expect(planner.plan('check my balance', { runReadonly: false })).rejects.toThrow(
      'LLM call timed out after 10ms'
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
