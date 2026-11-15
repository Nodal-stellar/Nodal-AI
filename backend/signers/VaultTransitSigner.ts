/**
 * backend/signers/VaultTransitSigner.ts
 *
 * Signer backed by a HashiCorp Vault transit `ed25519` key.
 *
 * The private key is generated inside Vault and never exported — the agent only
 * sends the 32-byte transaction hash to `POST /v1/<mount>/sign/<key>` and gets
 * the signature back. The public key is read once from
 * `GET /v1/<mount>/keys/<key>` and cached.
 */

import axios from 'axios';
import { StrKey } from '@stellar/stellar-sdk';
import { createLogger } from '../utils/logger';
import type { Signer } from './Signer';

const log = createLogger('vault-transit-signer');

export interface VaultTransitSignerOptions {
  /** Vault server address, e.g. `https://vault.example.com:8200`. */
  address: string;
  /** Vault token with `update` on sign/<key> and `read` on keys/<key>. */
  token: string;
  /** Name of the transit key (must be type `ed25519`). */
  keyName: string;
  /** Mount path of the transit secrets engine. Defaults to `transit`. */
  mount?: string;
  /** Per-request timeout in milliseconds. Defaults to 10 000. */
  timeoutMs?: number;
  /** TTL for cached health check results in milliseconds. Defaults to 30 000. */
  healthCacheTtlMs?: number;
  /** Whether to prefetch and cache the public key at construction time. */
  prefetchPublicKey?: boolean;
}

interface VaultKeyResponse {
  data: {
    type: string;
    latest_version: number;
    keys: Record<string, { public_key?: string }>;
  };
}

interface VaultSignResponse {
  data: { signature: string };
}

const DEFAULT_HEALTH_CACHE_TTL_MS = 30_000;

export class VaultTransitSigner implements Signer {
  readonly backend = 'vault' as const;
  private readonly rootUrl: string;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly keyName: string;
  private readonly timeoutMs: number;
  private readonly healthCacheTtlMs: number;
  private cachedPublicKey: string | null = null;
  private cachedHealth: { ok: boolean; expiresAt: number } | null = null;

  constructor(options: VaultTransitSignerOptions) {
    const mount = (options.mount ?? 'transit').replace(/^\/+|\/+$/g, '');
    this.rootUrl = options.address.replace(/\/+$/, '');
    this.baseUrl = `${this.rootUrl}/v1/${mount}`;
    this.token = options.token;
    this.keyName = options.keyName;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.healthCacheTtlMs = options.healthCacheTtlMs ?? DEFAULT_HEALTH_CACHE_TTL_MS;

    if (options.prefetchPublicKey) {
      void this.publicKey().catch((err) => {
        log.warn({ keyName: this.keyName, err: String(err) }, 'Vault public key prefetch failed');
      });
    }
  }

  private get headers(): Record<string, string> {
    return { 'X-Vault-Token': this.token };
  }

  private async fetchAndDecodePublicKey(): Promise<string> {
    const res = await axios.get<VaultKeyResponse>(
      `${this.baseUrl}/keys/${encodeURIComponent(this.keyName)}`,
      { headers: this.headers, timeout: this.timeoutMs }
    );

    const { type, latest_version: latestVersion, keys } = res.data.data;
    if (type !== 'ed25519') {
      throw new Error(
        `Vault transit key "${this.keyName}" is type "${type}"; Stellar requires "ed25519"`
      );
    }

    const encoded = keys[String(latestVersion)]?.public_key;
    if (!encoded) {
      throw new Error(
        `Vault transit key "${this.keyName}" has no public key for its latest version`
      );
    }

    const raw = Buffer.from(encoded, 'base64');
    if (raw.length !== 32) {
      throw new Error(`Vault transit key "${this.keyName}" returned a malformed public key`);
    }

    return StrKey.encodeEd25519PublicKey(raw);
  }

  async publicKey(): Promise<string> {
    if (this.cachedPublicKey) return this.cachedPublicKey;

    this.cachedPublicKey = await this.fetchAndDecodePublicKey();
    log.info({ keyName: this.keyName, publicKey: this.cachedPublicKey }, 'Vault signer key loaded');
    return this.cachedPublicKey;
  }

  /**
   * Probe Vault reachability (`GET /v1/sys/health`) and verify the transit key
   * is readable (`GET /v1/<mount>/keys/<key>`). Results are cached for
   * `healthCacheTtlMs` (default 30 s) so frequent `/health` polls do not
   * hammer Vault. Also populates `cachedPublicKey` when not yet cached.
   */
  async healthCheck(): Promise<boolean> {
    const now = Date.now();
    if (this.cachedHealth && now < this.cachedHealth.expiresAt) {
      return this.cachedHealth.ok;
    }

    try {
      await axios.get(`${this.rootUrl}/v1/sys/health`, {
        headers: this.headers,
        timeout: this.timeoutMs,
      });
      const pubKey = await this.fetchAndDecodePublicKey();
      if (!this.cachedPublicKey) {
        this.cachedPublicKey = pubKey;
      }
      this.cachedHealth = { ok: true, expiresAt: now + this.healthCacheTtlMs };
      return true;
    } catch (err) {
      log.warn({ keyName: this.keyName, err: String(err) }, 'Vault signer health check failed');
      this.cachedHealth = { ok: false, expiresAt: now + this.healthCacheTtlMs };
      return false;
    }
  }

  /** Clear the cached health result (for testing). */
  _resetHealthCache(): void {
    this.cachedHealth = null;
  }

  async sign(data: Buffer): Promise<Buffer> {
    const res = await axios.post<VaultSignResponse>(
      `${this.baseUrl}/sign/${encodeURIComponent(this.keyName)}`,
      { input: data.toString('base64') },
      { headers: this.headers, timeout: this.timeoutMs }
    );

    // Vault returns `vault:v<version>:<base64 signature>`.
    const signature = res.data.data.signature;
    const encoded = signature.slice(signature.lastIndexOf(':') + 1);
    const raw = Buffer.from(encoded, 'base64');
    if (raw.length !== 64) {
      throw new Error(`Vault transit key "${this.keyName}" returned a malformed signature`);
    }
    return raw;
  }
}
