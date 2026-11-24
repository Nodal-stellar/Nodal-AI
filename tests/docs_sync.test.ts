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

describe('.env.example parity with EnvSchema', () => {
  it('every non-derived schema key appears in .env.example', () => {
    const configSrc = read('backend/config.ts');
    const envSrc = read('.env.example');

    const schemaBlockMatch = configSrc.match(/export const EnvSchema = z\.object\(\{([\s\S]*?)\}\);/);
    expect(schemaBlockMatch).toBeTruthy();
    const schemaBlock = schemaBlockMatch![1]!;

    const schemaKeys = [...schemaBlock.matchAll(/^\s*([A-Z0-9_]+)\s*:/gm)].map((m) => m[1]!);
    expect(schemaKeys.length).toBeGreaterThan(50);

    const envKeys = new Set([...envSrc.matchAll(/^[#\s]*([A-Z0-9_]+)=/gm)].map((m) => m[1]!));

    for (const key of schemaKeys) {
      expect(envKeys.has(key)).toBe(true);
    }
  });
});

// ─── Feature guides (#1008, #1009, #1010, #1011) ─────────────────────────────

const FEATURE_GUIDES = [
  'docs/guide/mcp.md',
  'docs/guide/triggers.md',
  'docs/guide/planning.md',
  'docs/guide/mpp.md',
  'docs/guide/approvals.md',
  'docs/guide/ai-safety.md',
];

const TUTORIALS = ['docs/tutorials/mcp-client.md', 'docs/tutorials/trigger-escrow-release.md'];

/** String members of a `const <name> ... = new Set<TaskType>([...])` literal, if there is one. */
function taskTypeSet(relPath: string, name: string): string[] | null {
  const match = read(relPath).match(
    new RegExp(`const ${name}[^=]*=\\s*new Set<TaskType>\\(\\[([\\s\\S]*?)\\]\\)`)
  );
  return match ? [...match[1]!.matchAll(/['"]([a-z0-9_]+)['"]/g)].map((m) => m[1]!) : null;
}

/** Task name → remaining cells, for the table under `heading`. */
function tableRows(relPath: string, heading: string): Map<string, string[]> {
  const src = read(relPath);
  const start = src.indexOf(heading);
  if (start === -1) throw new Error(`"${heading}" not found in ${relPath}`);
  const rest = src.slice(start + heading.length);
  const nextHeading = rest.search(/^#{1,6} /m);
  const section = nextHeading === -1 ? rest : rest.slice(0, nextHeading);
  const rows = section.matchAll(/^\|\s*`([a-z0-9_]+)`\s*\|(.*)\|\s*$/gm);
  return new Map([...rows].map((m) => [m[1]!, m[2]!.split('|').map((cell) => cell.trim())]));
}

function envSchemaKeys(): Set<string> {
  const src = read('backend/config.ts');
  const start = src.indexOf('export const EnvSchema');
  const block = src.slice(start, src.indexOf('\n});', start));
  return new Set([...block.matchAll(/^ {2}([A-Z0-9_]+)\s*:/gm)].map((m) => m[1]!));
}

/** Parsed ```json blocks of a markdown file. */
function jsonBlocks(relPath: string): unknown[] {
  return [...read(relPath).matchAll(/^```json\n([\s\S]*?)^```/gm)].map((m) => JSON.parse(m[1]!));
}

describe('Feature guides stay in sync with the code', () => {
  it.each(FEATURE_GUIDES)('%s is linked from the README and the sidebar', (guide) => {
    expect(read('README.md')).toContain(`(./${guide}`);
    const route = guide.replace(/^docs/, '').replace(/\.md$/, '');
    expect(read('docs/.vitepress/config.ts')).toContain(`'${route}'`);
  });

  it.each(TUTORIALS)('%s is linked from the README', (tutorial) => {
    expect(read('README.md')).toContain(`(./${tutorial})`);
  });

  it('SECURITY.md links the AI safety guide', () => {
    expect(read('SECURITY.md')).toContain('(./docs/guide/ai-safety.md)');
  });

  it.each([...FEATURE_GUIDES, ...TUTORIALS])('%s has only resolvable relative links', (page) => {
    const links = [...read(page).matchAll(/\]\((\.{1,2}\/[^)#\s]+)(?:#[^)]*)?\)/g)];
    for (const [, target] of links) {
      const resolved = path.resolve(ROOT, path.dirname(page), target!);
      expect(fs.existsSync(resolved), `${page} → ${target}`).toBe(true);
    }
  });

  it.each(FEATURE_GUIDES)('%s documents only settings that exist', (guide) => {
    const schemaKeys = envSchemaKeys();
    expect(schemaKeys.size).toBeGreaterThan(50);
    const documented = [...read(guide).matchAll(/^\|\s*`([A-Z][A-Z0-9_]+)`\s*\|/gm)];
    for (const [, key] of documented) {
      expect(schemaKeys.has(key!), `${guide}: ${key}`).toBe(true);
    }
  });

  it('marks experimental features', () => {
    for (const guide of ['mcp', 'triggers', 'planning', 'mpp']) {
      expect(read(`docs/guide/${guide}.md`)).toMatch(/experimental/i);
    }
  });
});

describe('Trigger guide lists exactly the task types triggers accept', () => {
  const rows = tableRows('docs/guide/triggers.md', '## Supported task types');

  it('matches VALID_TRIGGER_TASK_TYPES', () => {
    const accepted = taskTypeSet('backend/triggers.ts', 'VALID_TRIGGER_TASK_TYPES');
    expect(accepted).not.toBeNull();
    expect(sorted([...rows.keys()])).toEqual(sorted(accepted!));
  });
});

describe('AI safety guide covers every entry point and control', () => {
  const guide = read('docs/guide/ai-safety.md');
  const start = guide.indexOf('## Entry point × control matrix');
  const matrix = guide
    .slice(start, guide.indexOf('\n### ', start))
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
  const [header = [], , ...rows] = matrix;

  it('has a column for each control', () => {
    expect(header).toEqual([
      'Entry point',
      'Opt-in',
      'Spending limit',
      'Destination allowlist',
      'Approval',
      'Kill switch',
      'Guardrails',
    ]);
  });

  it('has a row for the planner, both MCP transports and triggers', () => {
    const entryPoints = rows.map(([name]) => name);
    for (const expected of ['Planner', 'MCP stdio', 'MCP HTTP', 'Triggers']) {
      expect(entryPoints.some((name) => name?.startsWith(expected)), expected).toBe(true);
    }
  });

  it('fills every cell', () => {
    for (const row of rows) {
      expect(row).toHaveLength(header.length);
      for (const cell of row) expect(cell).not.toBe('');
    }
  });
});

describe('MCP client configurations', () => {
  it.each(['docs/guide/mcp.md', 'docs/tutorials/mcp-client.md', 'README.md'])(
    '%s contains valid testnet configurations',
    (page) => {
      const configs = jsonBlocks(page).filter(
        (block): block is { mcpServers: Record<string, { env: Record<string, string> }> } =>
          typeof block === 'object' && block !== null && 'mcpServers' in block
      );
      expect(configs.length).toBeGreaterThan(0);

      for (const { mcpServers } of configs) {
        const env = mcpServers['nodal-ai']!.env;
        expect(env.STELLAR_NETWORK).toBe('testnet');
        expect(env.PAUSED).toBe('true');
        for (const key of ['HORIZON_URL', 'SOROBAN_RPC_URL', 'X402_ASSET_ISSUER']) {
          expect(env[key], key).toBeTruthy();
        }
        // Never a real key.
        expect(env.AGENT_SECRET_KEY).toBe('S...');
      }
    }
  );

  it('tutorial covers Claude Desktop and Cursor', () => {
    const tutorial = read('docs/tutorials/mcp-client.md');
    expect(tutorial).toContain('### Claude Desktop');
    expect(tutorial).toContain('### Cursor');
  });
});
