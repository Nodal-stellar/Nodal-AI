---
name: Bug Report
about: Report a bug or unexpected behavior in Nodal AI
title: "[BUG] "
labels: bug
assignees: ''

---

## Summary

A clear and concise description of what the bug is.

## Affected Module / File

Which component or file(s) are affected?
- [ ] Backend Agent Core (`backend/agent.ts`, `backend/config.ts`)
- [ ] PayFi / x402 Tools (`backend/tools/X402PaymentTool.ts`, `backend/tools/`)
- [ ] Smart Contracts (`contracts/escrow/`, `contracts/`)
- [ ] Telemetry & Circuit Breakers (`backend/telemetry.ts`, `backend/rpc_breaker.ts`)
- [ ] Integration / E2E Tests (`tests/`)
- [ ] Other (please specify file paths)

## Environment Details

- **Node.js Version**: (e.g., `v20.12.0`)
- **Stellar Network**: [ ] Testnet / [ ] Mainnet / [ ] Standalone Local Quickstart
- **Horizon / Soroban RPC URL**: (e.g., `https://soroban-testnet.stellar.org`)
- **Rust & Cargo Version**: (if smart contract related, e.g., `cargo 1.80.0`)
- **Operating System**: (e.g., Ubuntu 22.04, macOS Sonoma, Windows 11)
- **Branch / Commit**: (e.g., `main`, commit hash)

## Steps to Reproduce

1. Execute command / tool: `...`
2. Provide input parameters: `...`
3. Observe error output

## Relevant Code / Reproduction Script

```typescript
// Minimal snippet reproducing the failure
```

## Expected Behavior

A clear description of what should have occurred.

## Actual Behavior

What actually happened instead (including unexpected exits, rejected transactions, or unhandled exceptions).

## Logs & Stack Traces

```text
// Paste relevant log lines, terminal output, or Soroban simulation error codes here
```

## Additional Context

Any other context, related issues, or screenshots.

