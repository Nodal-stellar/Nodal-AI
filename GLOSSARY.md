# Glossary

This glossary keeps the Stellar- and PayFi-specific terms used in the repo in one place. The term links point to the canonical source for each definition, either Stellar docs/specs or this codebase.

| Term | Definition |
| --- | --- |
| [Arbiter](./contracts/escrow/src/lib.rs) | The trusted third party named when an escrow is created; only the arbiter can release escrowed funds to the recipient. |
| [Atomic units](./backend/utils/amount.ts) | The smallest indivisible unit of an asset. Amounts in this repo are kept as BigInt stroops, where 1 XLM equals 10,000,000 stroops, so money math never uses floats. |
| [CAIP-2](./backend/network.ts) | The Chain Agnostic standard for naming blockchains. This repo uses it for Stellar networks, for example `stellar:testnet`, in x402 v2 payment requirements. |
| [Claimable balance](https://developers.stellar.org/docs/build/guides/transactions/claimable-balances) | A ledger entry that reserves an asset until one of its claimants satisfies the predicate and claims it later. |
| [Circuit breaker](./backend/rpc_client.ts) | An opossum-backed guard around RPC calls that opens after repeated failures and short-circuits new calls until recovery. |
| [Escrow](./contracts/escrow/src/lib.rs) | The Soroban contract that locks a depositor's funds until the arbiter releases them to the recipient, or the depositor reclaims them after expiry. |
| [Facilitator](./backend/config.ts) | An x402 server that verifies and settles payments for the buyer and seller, so the agent does not have to talk to the chain directly. Set with `X402_FACILITATOR_URL`. |
| [Fee-bump](./backend/tools/FeeBumpTool.ts) | A transaction envelope that wraps an already-signed inner transaction so a different account (here, the agent) pays its fee, used for sponsored retries. |
| [Horizon](https://developers.stellar.org/docs/data/apis/horizon) | Stellar's HTTP API for account, transaction, and ledger data, plus transaction submission. |
| [Idempotency key](./backend/persistence.ts) | A unique key sent with a request so a retry of the same request is recognised and not run twice. The agent stores each key with its result in the database. |
| [M-of-N multisig](./backend/tools/MultiSigPaymentTool.ts) | A transaction that needs signatures from at least M of an account's N signers before it is valid, used for high-value payments. |
| [MPP charge](./backend/payments/mpp.ts) | A Machine Payments Protocol charge: one paid HTTP request settled by a single on-chain SEP-41 `transfer` through a Stellar Asset Contract, with no facilitator in the middle. |
| [MPP session](./backend/db/migrations/003_mpp_session.sql) | A streaming micropayment session: many small off-chain payments are promised inside a channel and settled on chain later, instead of one transaction per payment. |
| [nonce](./backend/tools/X402PaymentTool.ts) | A one-time x402 challenge value used to prevent replay and to correlate the settled payment back to the original request. |
| [PayFi](./README.md) | Payment-finance flows where value transfer is part of automated application logic, not just a manual user action. |
| [Policy account](./contracts/agent_policy/src/lib.rs) | A Soroban contract that holds the agent's funds and enforces its spending policy on chain, so limits apply even if the agent itself is tricked. |
| [SAC](https://developers.stellar.org/docs/tokens/stellar-asset-contract) | Stellar Asset Contract, the built-in contract interface for Stellar assets and trustline balances used by Soroban contracts. |
| [SEP-0001](https://developers.stellar.org/docs/platforms/anchor-platform/sep-guide/sep1) | Stellar Info File, the `stellar.toml` metadata file anchors and apps use to discover endpoints, assets, and signing info. |
| [SEP-0010](https://developers.stellar.org/docs/build/apps/wallet/sep10) | Stellar Authentication, the challenge-response web auth standard used to establish an authenticated session with an anchor. |
| [SEP-0031](https://developers.stellar.org/docs/platforms/anchor-platform/sep-guide/sep31) | Cross-Border Payments, the standard for anchor-to-anchor and wallet-mediated cross-border payment flows. |
| [SEP-0038](https://developers.stellar.org/docs/build/apps/wallet/sep38) | Quote, the standard for requesting indicative or firm exchange quotes between Stellar and off-chain assets. |
| [SEP-41](./backend/config.ts) | The Stellar standard interface for tokens on Soroban. It defines the `transfer`, `balance`, and other calls every token contract must offer, and the x402 asset here is a SEP-41 token. |
| [Settlement](./backend/payments/mpp.ts) | The on-chain transfer that completes a payment. In an MPP charge it is the SEP-41 `transfer` whose transaction hash comes back in the `Payment-Receipt` header. |
| [Soroban](https://developers.stellar.org/docs/learn/fundamentals/stellar-data-structures/contracts) | Stellar's smart-contract platform and runtime for on-chain logic compiled to Wasm. |
| [Spending limit](./backend/spending_tracker.ts) | The cumulative cap (`AGENT_SPENDING_LIMIT`) on how much the agent may spend within a rolling window (`SPENDING_WINDOW_MS`); payments that would exceed it are rejected. |
| [Trigger](./backend/db/migrations/005_approvals_triggers_idempotency.sql) | An event-driven rule stored in the database that starts an autonomous PayFi action when its condition is met, for example a scheduled payment or an approval that just landed. |
| [Webhook](./backend/webhook.ts) | An HTTP POST the agent sends to a URL you configure when something happens, signed with HMAC-SHA256 so the receiver can check it really came from this agent. |
| [x402](./backend/tools/X402PaymentTool.ts) | An open payment protocol for HTTP: a server answers `402 Payment Required`, the client pays and retries with proof of payment, and the server then returns the paid resource. |

