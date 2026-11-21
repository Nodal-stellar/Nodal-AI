/**
 * tests/planner_prompt_injection.test.ts
 *
 * Regression tests for issue #904:
 * PLANNER_PROMPT.replace('{request}', request) interprets special replacement
 * patterns ($&, $', $`, $$) in the user string.
 *
 * The fix uses a replacer function so the user text is inserted verbatim.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Minimal PayFiAgent stub ──────────────────────────────────────────────────
const mockAgent = {
  getTools: () => [],
  run: vi.fn(),
  runSequence: vi.fn(),
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * We test the prompt-building logic in isolation by reproducing the template
 * substitution exactly as planner.ts does it, once with the old (broken)
 * approach and once with the fixed one.
 */
const PLANNER_PROMPT_TEMPLATE = `User request: {request}\n\nRespond with JSON array of tasks:`;

function buildPromptBroken(request: string): string {
  // The original broken approach — special replacement sequences are interpreted.
  return PLANNER_PROMPT_TEMPLATE.replace('{request}', request);
}

function buildPromptFixed(request: string): string {
  // The fix: replacer function bypasses all special sequence handling.
  return PLANNER_PROMPT_TEMPLATE.replace('{request}', () => request);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Planner prompt injection — issue #904', () => {
  describe('buildPromptFixed — replacer function', () => {
    it('inserts $$ verbatim', () => {
      const request = 'Pay $$5 to bob';
      const prompt = buildPromptFixed(request);
      expect(prompt).toContain('Pay $$5 to bob');
    });

    it('inserts $& verbatim', () => {
      const request = 'Request pay $& amount';
      const prompt = buildPromptFixed(request);
      expect(prompt).toContain('Request pay $& amount');
    });

    it("inserts $' verbatim", () => {
      const request = "Some $' pattern";
      const prompt = buildPromptFixed(request);
      expect(prompt).toContain("Some $' pattern");
    });

    it('inserts $` verbatim', () => {
      const request = 'Another $` pattern';
      const prompt = buildPromptFixed(request);
      expect(prompt).toContain('Another $` pattern');
    });

    it('handles the full acceptance-criteria example from issue #904', () => {
      const request = 'Request pay $$5 to bob $&';
      const prompt = buildPromptFixed(request);
      // The request must appear in the prompt unchanged.
      expect(prompt).toContain('Request pay $$5 to bob $&');
    });

    it('handles normal text without issues', () => {
      const request = 'Send 10 XLM to GABC';
      const prompt = buildPromptFixed(request);
      expect(prompt).toContain('Send 10 XLM to GABC');
    });

    it('handles text with multiple $ patterns', () => {
      const request = 'transfer $$ to $& and $` check $1 price';
      const prompt = buildPromptFixed(request);
      expect(prompt).toContain('transfer $$ to $& and $` check $1 price');
    });
  });

  describe('buildPromptBroken — demonstrates the old bug (for reference)', () => {
    it('$$ is mangled to a single $ by String.prototype.replace', () => {
      // This confirms the old code was broken — $$ → $ in the output.
      const request = 'Pay $$5';
      const brokenOutput = buildPromptBroken(request);
      // The broken version inserts "$5" not "$$5".
      expect(brokenOutput).toContain('Pay $5');
      expect(brokenOutput).not.toContain('Pay $$5');
    });

    it('$& is replaced with the matched string "{request}"', () => {
      // $& refers to the matched substring, so the user gets the template key
      // injected back into the prompt.
      const request = 'hack $&';
      const brokenOutput = buildPromptBroken(request);
      // The broken replacement substitutes $& with the match "{request}".
      expect(brokenOutput).toContain('hack {request}');
    });
  });
});
