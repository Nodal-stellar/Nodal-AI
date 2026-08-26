# Nodal AI — PayFi, Stellar & Soroban Glossary

This glossary provides definitions, architectural context, and canonical reference links for key terms across **PayFi (Payment-Finance)**, **Stellar**, **Soroban**, and the **Nodal AI** autonomous agent runtime.

---

## Table of Contents

- [Circuit Breaker](#circuit-breaker)
- [Claimable Balance](#claimable-balance)
- [Horizon](#horizon)
- [Nonce](#nonce)
- [PayFi (Payment Finance)](#payfi-payment-finance)
- [SAC (Stellar Asset Contract)](#sac-stellar-asset-contract)
- [SEP (Stellar Ecosystem Proposal)](#sep-stellar-ecosystem-proposal)
- [SEP-0001 (stellar.toml)](#sep-0001-stellartoml)
- [SEP-0010 (Stellar Web Authentication)](#sep-0010-stellar-web-authentication)
- [SEP-0031 (Cross-Border Payments API)](#sep-0031-cross-border-payments-api)
- [SEP-0038 (Anchor RFQ / Quotes API)](#sep-0038-anchor-rfq--quotes-api)
- [Soroban](#soroban)
- [Soroban Auth Framework](#soroban-auth-framework)
- [Trustline](#trustline)
- [WASM (WebAssembly)](#wasm-webassembly)
- [x402 (HTTP 402 Autonomous Payment Protocol)](#x402-http-402-autonomous-payment-protocol)
- [XDR (External Data Representation)](#xdr-external-data-representation)

---

### Circuit Breaker
A resilience pattern implemented in Nodal AI's RPC client (`backend/rpc_breaker.ts`) that tracks consecutive failures against Horizon or Soroban RPC endpoints. When error thresholds are exceeded, the circuit opens to fail fast, preventing cascading resource exhaustion and protecting downstream agent transactions until the remote service recovers.
- **Canonical Reference**: [Martin Fowler: Circuit Breaker Pattern](https://martinfowler.com/bliki/CircuitBreaker.html)
- **Codebase Reference**: [`backend/rpc_breaker.ts`](./backend/rpc_breaker.ts)

---

### Claimable Balance
A Stellar ledger entry representing an amount of an asset that is held in escrow until a designated claimant claims it under specified time-based or cryptographic conditions. This allows senders to transfer funds to accounts that may not yet exist or have not established the required trustline.
- **Canonical Reference**: [Stellar Developers: Claimable Balances](https://developers.stellar.org/docs/learn/fundamentals/stellar-data-structures/operations-and-transactions/claimable-balances)
- **SEP Reference**: [CAP-0023: Two-Phase Claimable Balance](https://github.com/stellar/stellar-protocol/blob/master/core/cap-0023.md)

---

### Horizon
The client-facing HTTP REST API server for the Stellar network. It provides endpoints for querying account state, transaction history, ledger metrics, submitting transactions, and subscribing to live Server-Sent Events (SSE) streams for real-time payment notifications.
- **Canonical Reference**: [Stellar Horizon API Reference](https://developers.stellar.org/docs/data/horizon)
- **Repository**: [stellar/go/services/horizon](https://github.com/stellar/go/tree/master/services/horizon)

---

### Nonce
A unique, single-use number or cryptographic timestamp included in authentication challenges (such as SEP-0010 web auth or agent task execution) to guarantee uniqueness and prevent replay attacks.
- **Canonical Reference**: [Stellar Web Authentication Nonce Specification](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0010.md)

---

### PayFi (Payment Finance)
The emerging paradigm of programmable, autonomous financial workflows where intelligent software agents continuously negotiate, route, escrow, stream, and settle micro-transactions and cross-border value flows on high-speed settlement networks like Stellar.
- **Canonical Reference**: [Stellar PayFi Innovations](https://developers.stellar.org/docs)

---

### SAC (Stellar Asset Contract)
A built-in Soroban smart contract interface that provides uniform ERC-20-style access to classic Stellar issued assets (e.g., native XLM, USDC, EURC). The SAC enables smart contracts and autonomous agents to transfer, burn, mint, and hold classic Stellar assets alongside custom Soroban token contracts seamlessly.
- **Canonical Reference**: [Soroban Stellar Asset Contract Docs](https://developers.stellar.org/docs/learn/smart-contract-internals/stellar-asset-contract)
- **Rust SDK Reference**: [`soroban_sdk::token::Client`](https://docs.rs/soroban-sdk/latest/soroban_sdk/token/struct.Client.html)

---

### SEP (Stellar Ecosystem Proposal)
Public standards documents created by the Stellar Development Foundation and ecosystem participants that define protocols, API schemas, and metadata formats for interoperable decentralized applications, anchors, wallets, and on/off-ramps.
- **Canonical Reference**: [Stellar Ecosystem Proposals (SEP Directory)](https://github.com/stellar/stellar-protocol/tree/master/ecosystem)

---

### SEP-0001 (stellar.toml)
A standard configuration file hosted at `/.well-known/stellar.toml` by Stellar ecosystem anchors, institutions, and services. It publishes discoverable metadata such as public signing keys, supported assets, validator nodes, and API endpoint URLs.
- **Canonical Reference**: [SEP-0001: stellar.toml Specification](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0001.md)

---

### SEP-0010 (Stellar Web Authentication)
The cryptographic authentication standard on Stellar. A server creates an unsigned challenge transaction containing a sequence of operations and a cryptographic nonce; the client wallet or agent signs this transaction with its secret key to prove account ownership, receiving a signed JWT session token in return.
- **Canonical Reference**: [SEP-0010: Stellar Web Authentication Standard](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0010.md)

---

### SEP-0031 (Cross-Border Payments API)
A standardized REST protocol enabling decentralized money transfers and business-to-business settlements between registered financial anchors and fintech providers.
- **Canonical Reference**: [SEP-0031: Cross-Border Payments API](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0031.md)

---

### SEP-0038 (Anchor RFQ / Quotes API)
The Request for Quote (RFQ) standard enabling liquidity consumers and autonomous agents to request firm, binding price quotes for converting between fiat and crypto assets with anchors before executing a transfer.
- **Canonical Reference**: [SEP-0038: Anchor RFQ / Quotes API](https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0038.md)

---

### Soroban
The modern smart contract platform designed for scalability, predictable gas fees, and Rust-based WebAssembly (WASM) execution on the Stellar network.
- **Canonical Reference**: [Soroban Documentation](https://soroban.stellar.org/docs)
- **Developer Hub**: [Stellar Smart Contracts](https://developers.stellar.org/docs/learn/smart-contract-internals)

---

### Soroban Auth Framework
The non-custodial authorization mechanism in Soroban where contract invocations require cryptographic authorization tree signatures (`Address::require_auth` or `Address::require_auth_for_args`). This architecture enables account abstraction and multi-signature authorization without requiring private keys to be exposed to intermediary relays or agent brains.
- **Canonical Reference**: [Soroban Authorization Framework](https://developers.stellar.org/docs/learn/smart-contract-internals/authorization)

---

### Trustline
An explicit record on the Stellar ledger declaring an account's willingness to hold an asset issued by a specific anchor, specifying the maximum limit. Trustlines prevent spam assets from cluttering user balances and protect recipients from unapproved token distributions.
- **Canonical Reference**: [Stellar Trustlines & Asset Concepts](https://developers.stellar.org/docs/learn/fundamentals/stellar-data-structures/accounts#trustlines)

---

### WASM (WebAssembly)
The binary instruction format that Soroban smart contracts are compiled into from Rust (`wasm32-unknown-unknown`). WASM binaries are optimized, verified, and stored on the Stellar ledger for sandboxed, high-performance contract execution.
- **Canonical Reference**: [WebAssembly Specification](https://webassembly.org/)
- **Soroban WASM Guide**: [Soroban Smart Contract Compilation](https://soroban.stellar.org/docs/getting-started/setup)

---

### x402 (HTTP 402 Autonomous Payment Protocol)
A PayFi protocol standard implemented in Nodal AI where web servers and API endpoints signal payment requirements via HTTP 402 status codes. Intelligent agents parse the pricing, asset, and recipient metadata in the response headers, autonomously simulate and submit the on-chain micro-payment on Stellar, and attach the transaction proof to unlock the requested resource.
- **Canonical Reference**: [RFC 9110: HTTP 402 Payment Required](https://httpwg.org/specs/rfc9110.html#status.402)
- **Nodal AI Implementation**: [`backend/tools/x402_payment.ts`](./backend/tools/)

---

### XDR (External Data Representation)
The canonical binary serialization standard (RFC 4506) used throughout the Stellar and Soroban protocols to encode ledgers, transaction envelopes, operation arguments, and contract states deterministically across different programming languages and hardware architectures.
- **Canonical Reference**: [Stellar XDR Reference Guide](https://developers.stellar.org/docs/learn/fundamentals/stellar-data-structures/xdr)
- **IETF Specification**: [RFC 4506: XDR Standard](https://datatracker.ietf.org/doc/html/rfc4506)
