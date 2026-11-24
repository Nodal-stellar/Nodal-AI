/**
 * backend/signer.ts
 *
 * Signing abstraction handed to tools in place of the raw agent secret.
 *
 * Tools only ever see a `Signer`: they can ask for the public key and have
 * transactions / Soroban auth entries signed, but never read the secret key.
 * This keeps the secret out of every tool instance and lets KMS/HSM or SEP-43
 * wallet signers be plugged in by implementing the same interface.
 */

import {
  Address,
  authorizeEntry,
  FeeBumpTransaction,
  Keypair,
  Networks,
  Transaction,
  xdr,
} from '@stellar/stellar-sdk';
import { config } from './config';

const PASSPHRASES = {
  testnet: Networks.TESTNET,
  mainnet: Networks.PUBLIC,
  futurenet: Networks.FUTURENET,
} as const;

export interface Signer {
  /** G-address of the signing account. */
  publicKey(): string;
  /** Adds this signer's signature to the transaction in place. */
  signTransaction(tx: Transaction | FeeBumpTransaction): void;
  /** Returns a copy of the Soroban authorization entry signed by this signer. */
  signAuthEntry(
    entry: xdr.SorobanAuthorizationEntry,
    validUntilLedgerSeq: number,
    networkPassphrase?: string
  ): Promise<xdr.SorobanAuthorizationEntry>;
  /** Ed25519 signature over arbitrary bytes, e.g. an off-chain MPP channel commitment. */
  sign(data: Buffer): Buffer;
  /** Contract account whose authorization entries this signer may authorize. */
  readonly policyAccount?: string;
}

/**
 * Signer backed by a Stellar `Keypair`. Accepts either a Keypair or a getter so
 * the agent signer can resolve `config.agentKeypair()` on demand instead of
 * holding its own copy.
 */
export class KeypairSigner implements Signer {
  readonly policyAccount?: string;
  private readonly getKeypair: () => Keypair;

  constructor(keypair: Keypair | (() => Keypair)) {
    this.getKeypair = typeof keypair === 'function' ? keypair : () => keypair;
  }

  publicKey(): string {
    return this.getKeypair().publicKey();
  }

  signTransaction(tx: Transaction | FeeBumpTransaction): void {
    tx.sign(this.getKeypair());
  }

  signAuthEntry(
    entry: xdr.SorobanAuthorizationEntry,
    validUntilLedgerSeq: number,
    networkPassphrase?: string
  ): Promise<xdr.SorobanAuthorizationEntry> {
    return authorizeEntry(
      entry,
      this.getKeypair(),
      validUntilLedgerSeq,
      networkPassphrase ?? PASSPHRASES[config.STELLAR_NETWORK]
    );
  }

  sign(data: Buffer): Buffer {
    return this.getKeypair().sign(data);
  }
}

/** Sign every Soroban auth entry assembled by simulation. */
export async function signSorobanAuthEntries(
  tx: Transaction,
  signer: Signer,
  validUntilLedgerSeq: number
): Promise<void> {
  for (const operation of tx.operations) {
    const value = operation.body().value();
    const auth = value.auth();
    if (!auth || auth.length === 0) continue;
    const signed = await Promise.all(
      auth.map((entry) => {
        if (!signer.policyAccount) return entry;
        try {
          const address = Address.fromScAddress(entry.credentials().address()).toString();
          return address === signer.policyAccount
            ? signer.signAuthEntry(entry, validUntilLedgerSeq)
            : entry;
        } catch {
          return entry;
        }
      })
    );
    value.auth(signed);
  }
}

/** Fee-payer signer that authorizes entries for the configured custom policy account. */
export class PolicyAccountSigner implements Signer {
  readonly policyAccount: string;
  private readonly delegate: KeypairSigner;
  constructor(policyAccount: string, keypair: () => Keypair) {
    this.policyAccount = policyAccount;
    this.delegate = new KeypairSigner(keypair);
  }
  publicKey(): string { return this.delegate.publicKey(); }
  signTransaction(tx: Transaction | FeeBumpTransaction): void { this.delegate.signTransaction(tx); }
  signAuthEntry(entry: xdr.SorobanAuthorizationEntry, validUntilLedgerSeq: number, networkPassphrase?: string) {
    return this.delegate.signAuthEntry(entry, validUntilLedgerSeq, networkPassphrase);
  }
  sign(data: Buffer): Buffer { return this.delegate.sign(data); }
}

/** Signer for the configured agent account. Resolves the keypair from config on each use. */
export function createAgentSigner(): Signer {
  return config.AGENT_POLICY_ACCOUNT
    ? new PolicyAccountSigner(config.AGENT_POLICY_ACCOUNT, () => config.agentKeypair())
    : new KeypairSigner(() => config.agentKeypair());
}
