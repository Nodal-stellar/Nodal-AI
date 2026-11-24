/**
 * tests/env_example_parity.test.ts
 *
 * Enforces parity between backend/config.ts EnvSchema and .env.example.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');

function read(relPath: string): string {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

describe('Environment Example Parity', () => {
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
