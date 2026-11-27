# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-11-22

### Breaking Changes

- **Spending Tracker API & Storage**: Transitioned to per-asset BigInt stroop tracking (`reserveSpending({ assetKey, amountStroops, limitStroops, sinceMs })`). The `Storage` abstraction unifies PostgreSQL and SQLite backends (#957, #959).
- **Webhook Signatures**: Outgoing webhook payloads signed with HMAC-SHA256 include timestamps in headers (`X-Nodal-Signature`). Legacy signature format is disabled by default (`WEBHOOK_LEGACY_SIGNATURE=false`).
- **Removed Inflation**: Removed `inflation` task type and `InflationTool`. Inflation has had no economic effect on Stellar since Protocol 12 (#874).
- **x402 v2 Protocol Default**: Enabled x402 v2 by default (`X402_USE_LEGACY=0`), using SEP-41 token transfers and header-based protocol.

### Added

- **PostgreSQL & Dual Storage Backend**: Added full `Storage` contract implementation (`PostgresStorage`) for horizontally scalable multi-instance deployments (#822, #957).
- **Per-Asset Atomic Reservations**: Added atomic per-asset spending limit reservations in SQLite and Postgres (`reserveSpending` with `ReserveSpendingOptions`) (#959).
- **x402 v2 Interoperability**: Added full support for official `@x402/*` packages (@x402/stellar, @x402/fetch, @x402/express, @x402/core), SEP-41 token transfers, and optional facilitator support (#948).
- **MPP (Micropayment Protocol) Sessions**: Added streaming payment channels and session state persistence in SQLite and Postgres.
- **Model Context Protocol (MCP) Server**: Added stdio and HTTP transport for exposing PayFi tools to LLMs (Claude Desktop, etc.) with authentication and payment guards.
- **AI Planning Layer**: Natural language task planning with OpenAI, Anthropic, and Mock providers, prompt injection defenses, and tool iteration caps.
- **Real-Time Dashboard & SSE Stream**: Added `/stream` Server-Sent Events endpoint and `/dashboard` web interface for live monitoring.
- **Environment Schema Parity**: Documented all missing configuration keys in `.env.example` and added automated parity testing (#1000).
- **Doctor CLI Check**: `npm run doctor` checks toolchain prerequisites and identifies missing optional environment keys (#1000).

### Changed

- Upgraded runtime target to Node.js 22 LTS.
- Upgraded Stellar SDK to `@stellar/stellar-sdk` v15.
- Centralized database connection management exclusively in `backend/db/` (#957).

### Deprecated

- Legacy JSON x402 challenge format with SHA-256(nonce) memo (use `X402_USE_LEGACY=1` for temporary backwards compatibility).
- `WEBHOOK_LEGACY_SIGNATURE` body-only signature format without timestamp.

### Removed

- `inflation` task type and `InflationTool` (#874).

## [0.2.0] - 2026-02-15

### Added

- X402PaymentTool now validates challenge schema before submission (#45).
- SorobanInvokeTool supports `simulateOnly` mode for dry-run operations (#38).

### Fixed

- Fixed race condition in polling timeout logic for transaction confirmation (#52).
- Corrected memo truncation in X402 nonce derivation (#49).

### Changed

- Increased Soroban RPC polling timeout from 10s to 15s to accommodate slower networks (#51).

### Security

- Updated @stellar/stellar-sdk to v11.4.0 to address XDR parsing vulnerability (#48).

[Unreleased]: https://github.com/Nodal-stellar/Nodal-AI/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Nodal-stellar/Nodal-AI/compare/v0.2.0...v1.0.0
[0.2.0]: https://github.com/Nodal-stellar/Nodal-AI/releases/tag/v0.2.0
