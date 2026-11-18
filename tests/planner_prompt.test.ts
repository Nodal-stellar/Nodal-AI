/**
 * Regression tests for the planner prompt template.
 *
 * String.prototype.replace interprets $, $&, $' and $$ in a string replacement
 * as replacement patterns. A user request containing any of those sequences
 * must reach the LLM unchanged.
 */
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PayFiAgent } from '../backend/agent';
import { Planner } from '../backend/planner';

describe('planner prompt substitution', () => {
  let server: Server;
  let endpoint: string;
  let capturedBody: string | undefined;

  beforeEach(async () => {
    capturedBody = undefined;
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        capturedBody = Buffer.concat(chunks).toString('utf8');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: '[]' } }] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no server address');
    endpoint = `http://127.0.0.1:${address.port}/llm`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it('passes replacement-pattern sequences through verbatim', async () => {
    const request = 'pay $$5 to bob $& and $` and $\'';
    const planner = new Planner(new PayFiAgent(), { llmEndpoint: endpoint });

    await planner.plan(request, { runReadonly: false });

    expect(capturedBody).toBeDefined();
    const body = JSON.parse(capturedBody!) as { messages: Array<{ role: string; content: string }> };
    const prompt = body.messages[0]!.content;
    expect(prompt).toContain(`User request: ${request}\n`);
    expect(prompt).toContain('Respond with JSON array of tasks:');
    expect(prompt).not.toContain('{request}');
  });

  it('does not let the request inject the rest of the template twice', async () => {
    const request = '$&';
    const planner = new Planner(new PayFiAgent(), { llmEndpoint: endpoint });

    await planner.plan(request, { runReadonly: false });

    const body = JSON.parse(capturedBody!) as { messages: Array<{ role: string; content: string }> };
    const prompt = body.messages[0]!.content;
    const marker = 'You are a financial planning assistant';
    expect(prompt.split(marker)).toHaveLength(2);
  });
});
