/**
 * tests/docs_sync.test.ts
 *
 * Contract test for #826 — the built-in TaskTypes are listed in several places
 * (the tool registry, the `BuiltinTaskType` union, the README API table,
 * ARCHITECTURE.md and the feature-request issue template) and had already
 * drifted: `friendbot`, `stellar_identity_auth` and `soroban_event_query` were
 * missing from the template, and the README table covered barely a third of
 * the registry. This fails as soon as any of them disagree.
 *
 * Sources are read as text rather than imported: importing backend/agent.ts
 * or backend/tools/builtin.ts pulls in config, whose loader exits the process
 * when the required env vars are absent.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');

function read(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

/** Task names registered in createBuiltinTools() — the source of truth. */
function registryTaskTypes(): string[] {
  const src = read('backend/tools/builtin.ts');
  return [...src.matchAll(/^\s*name:\s*['"]([a-z0-9_]+)['"]/gm)].map((m) => m[1]!);
}

/** Members of the `BuiltinTaskType` union in backend/agent.ts. */
function unionTaskTypes(): string[] {
  const src = read('backend/agent.ts');
  const match = src.match(/export type BuiltinTaskType\s*=([\s\S]*?);/);
  if (!match) throw new Error('BuiltinTaskType union not found in backend/agent.ts');
  return [...match[1]!.matchAll(/['"]([a-z0-9_]+)['"]/g)].map((m) => m[1]!);
}

/**
 * First-column task names of the markdown table that follows `heading`
 * (rows shaped like "| `task_type` | ... |"), up to the next heading.
 */
function tableTaskTypes(relPath: string, heading: string): string[] {
  const src = read(relPath);
  const start = src.indexOf(heading);
  if (start === -1) throw new Error(`"${heading}" not found in ${relPath}`);
  const rest = src.slice(start + heading.length);
  const nextHeading = rest.search(/^#{1,6} /m);
  const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  return [...section.matchAll(/^\|\s*`([a-z0-9_]+)`\s*\|/gm)].map((m) => m[1]!);
}

/** Checkbox entries ("- [ ] `task_type`") in the feature-request template. */
function templateTaskTypes(): string[] {
  const src = read('.github/ISSUE_TEMPLATE/feature_request.md');
  return [...src.matchAll(/^- \[ \] `([a-z0-9_]+)`\s*$/gm)].map((m) => m[1]!);
}

const sorted = (xs: string[]): string[] => [...new Set(xs)].sort();

describe('TaskType documentation stays in sync with the registry', () => {
  const registry = registryTaskTypes();

  it('finds the registry (guards against the extractor silently matching nothing)', () => {
    expect(registry.length).toBeGreaterThan(20);
    expect(registry).toContain('stellar_payment');
  });

  it('registers each task type only once', () => {
    expect(registry).toHaveLength(new Set(registry).size);
  });

  it('BuiltinTaskType union matches the registry', () => {
    expect(sorted(unionTaskTypes())).toEqual(sorted(registry));
  });

  it('README TaskType table lists exactly the registered task types', () => {
    expect(sorted(tableTaskTypes('README.md', '### TaskType'))).toEqual(sorted(registry));
  });

  it('ARCHITECTURE.md Registered Task Types table lists exactly the registered task types', () => {
    expect(sorted(tableTaskTypes('ARCHITECTURE.md', '### Registered Task Types'))).toEqual(
      sorted(registry)
    );
  });

  it('feature-request template offers exactly the registered task types', () => {
    expect(sorted(templateTaskTypes())).toEqual(sorted(registry));
  });
});
