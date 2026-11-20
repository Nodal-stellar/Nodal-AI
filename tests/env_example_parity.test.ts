import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { EnvSchema } from '../backend/config.js';

/**
 * Guards against `.env.example` drifting behind `EnvSchema`.
 *
 * The example file is the first thing a new operator copies, so a key that
 * exists in the schema but not in the example is effectively undocumented —
 * exactly the gap this test exists to close (see the parity test requested in
 * the issue that added the missing keys).
 *
 * A key counts as documented when it appears either as an assignment
 * (`KEY=value`) or as a commented assignment (`# KEY=`), since the example
 * file documents optional keys in comments.
 */

const repoRoot = join(__dirname, '..');
const examplePath = join(repoRoot, '.env.example');

/** Keys the schema computes rather than reads from the environment. */
const DERIVED_KEYS = new Set<string>([
  // Built from SPENDING_LIMITS by the config layer.
  'SPENDING_LIMITS_MAP',
]);

/**
 * Keys that are derived when unset but still settable, so `.env.example`
 * documents them on purpose. They must satisfy parity but are excluded from the
 * "derived keys stay out" check.
 */
const DERIVED_BUT_SETTABLE = new Set<string>([
  // Derived from X402_ASSET_CODE + X402_ASSET_ISSUER when unset (#776).
  'X402_ASSET_CONTRACT',
]);

function documentedKeys(source: string): Set<string> {
  const keys = new Set<string>();
  // Matches `KEY=` at line start and commented `# KEY=` / `#KEY=`.
  const re = /^(?:#\s*)?([A-Z][A-Z0-9_]{2,})=/gm;
  for (const match of source.matchAll(re)) {
    const key = match[1];
    if (key) keys.add(key);
  }
  return keys;
}

/**
 * Keys read by standalone scripts via `process.env` rather than validated by
 * `EnvSchema`, so they legitimately appear in `.env.example` without being
 * schema keys. Each entry names where it is read.
 */
const SCRIPT_ONLY_KEYS = new Map<string, string>([
  ['ANCHOR_ASSET_CODE', 'scripts/examples/anchor_deposit.ts'],
  ['ANCHOR_ASSET_ISSUER', 'scripts/examples/anchor_deposit.ts'],
  ['ANCHOR_DEPOSIT_AMOUNT', 'scripts/examples/anchor_deposit.ts'],
  ['ANCHOR_URL', 'scripts/examples/anchor_deposit.ts'],
  ['DEPLOYER_SECRET_KEY', 'scripts/deploy_escrow.ts'],
  // Read directly by the Vault signer, which resolves the token itself so the
  // secret never passes through the config object.
  ['VAULT_TOKEN', 'backend/signers/index.ts'],
]);

describe('.env.example parity with EnvSchema', () => {
  const schemaKeys = Object.keys(EnvSchema.shape).filter((key) => !DERIVED_KEYS.has(key));
  const documented = documentedKeys(readFileSync(examplePath, 'utf8'));

  it('documents every schema key except the derived ones', () => {
    const missing = schemaKeys.filter((key) => !documented.has(key));

    expect(
      missing,
      `these keys exist in EnvSchema but are missing from .env.example:\n  ${missing.join('\n  ')}`
    ).toEqual([]);
  });

  it('does not document keys the schema no longer reads', () => {
    // Catches the opposite drift: a key removed from the schema but left behind
    // in the example, which misleads operators into setting something inert.
    // Script-read keys are exempt — they are not schema keys by design.
    const known = new Set([...Object.keys(EnvSchema.shape), ...SCRIPT_ONLY_KEYS.keys()]);
    const stale = [...documented].filter((key) => !known.has(key));

    expect(
      stale,
      `these keys are in .env.example but neither in EnvSchema nor read by a script:\n  ${stale.join('\n  ')}`
    ).toEqual([]);
  });

  it('keeps the derived keys out of the example', () => {
    // Documents intent: these are computed, so setting them by hand is a
    // mistake worth surfacing rather than silently overriding.
    for (const key of DERIVED_KEYS) {
      expect(documented.has(key), `${key} is derived and must not be in .env.example`).toBe(false);
    }
  });

  it('keeps derived-but-settable keys documented', () => {
    // X402_ASSET_CONTRACT is computed when unset, but overriding it is
    // supported, so it belongs in the example.
    for (const key of DERIVED_BUT_SETTABLE) {
      expect(documented.has(key), `${key} is settable and must be documented`).toBe(true);
    }
  });
});
