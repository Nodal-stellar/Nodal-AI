# Nodal AI Project Roadmap

This document outlines the strategic milestones, planned capabilities, in-progress sprint themes, and community contribution opportunities for **Nodal AI** — the autonomous PayFi agent kit for Stellar and Soroban.

---

## Roadmap Overview

```text
2026 Q3 (Current)          2026 Q4 (Next Up)            2027 Q1+ (Future)
┌──────────────────────┐   ┌──────────────────────┐    ┌──────────────────────┐
│  Core PayFi Tools,   │──▶│ Cross-Anchor PayFi,  │───▶│ Multi-Agent Swarms,  │
│  x402 & DX Hardening │   │ Liquidity Routing    │    │ DeFi Yield Yielding  │
└──────────────────────┘   └──────────────────────┘    └──────────────────────┘
```

---

## Current Sprint (2026 Q3 — Stellar Wave Sprint)

Focus: Stabilizing the core agent runtime, expanding developer experience (DX), robust test coverage, and x402 payment reliability.

### Core Themes & Planned Work:

1. **PayFi & x402 Autonomous Payments**
   - Autonomous HTTP 402 challenge negotiation and header parsing ([#452](https://github.com/Nodal-stellar/Nodal-AI/issues/452)).
   - End-to-end payment simulation gates before Soroban submission.
   - Example scripts for autonomous resource unlocking ([#484](https://github.com/Nodal-stellar/Nodal-AI/issues/484)).

2. **Soroban Smart Contract Escrows**
   - Multi-party escrow deployment, milestone releases, and time-lock triggers ([#477](https://github.com/Nodal-stellar/Nodal-AI/issues/477)).
   - Contract event listeners for real-time settlement tracking ([#457](https://github.com/Nodal-stellar/Nodal-AI/issues/457)).
   - Enhanced Soroban auth tree verification and simulation.

3. **Developer Experience (DX) & CI/CD**
   - Comprehensive domain documentation and [GLOSSARY.md](./GLOSSARY.md) ([#480](https://github.com/Nodal-stellar/Nodal-AI/issues/480)).
   - Dependabot ecosystem grouping for `@stellar` and `soroban-sdk` ([#469](https://github.com/Nodal-stellar/Nodal-AI/issues/469)).
   - Automated PR triage, issue templates, and pre-commit checks ([#466](https://github.com/Nodal-stellar/Nodal-AI/issues/466), [#475](https://github.com/Nodal-stellar/Nodal-AI/issues/475)).
   - VS Code Dev Containers for zero-setup environment onboarding ([#476](https://github.com/Nodal-stellar/Nodal-AI/issues/476)).

4. **Testing, Reliability & Mutation Harnesses**
   - Vitest global test harness and mock timer orchestration ([#460](https://github.com/Nodal-stellar/Nodal-AI/issues/460)).
   - Horizon SSE stream reconnection and error boundary coverage ([#455](https://github.com/Nodal-stellar/Nodal-AI/issues/455)).
   - Parameterized error handling for all `StructuredError` variants ([#458](https://github.com/Nodal-stellar/Nodal-AI/issues/458)).

5. **Network Resilience & Circuit Breakers**
   - Telemetry event assertions and metrics for RPC circuit breakers ([#453](https://github.com/Nodal-stellar/Nodal-AI/issues/453)).
   - Rolling window spend tracking and limit exhaustion safety guards ([#447](https://github.com/Nodal-stellar/Nodal-AI/issues/447)).

---

## Next Up (2026 Q4 — Cross-Anchor & Settlement Automation)

Focus: Expanding anchor interoperability, SEP-0031 cross-border corridors, and automated liquidity routing.

- **SEP-0031 / SEP-0038 Settlement Corridors**: Native agent tools to negotiate anchor RFQ quotes and trigger instant settlement flows.
- **Batch Payment Streaming**: High-throughput multi-address disbursements with CSV batch ingest and rate limiting.
- **Plugin Architecture**: Modular plugin marketplace allowing third-party developers to register custom agent tools without modifying core signing logic.
- **Web Dashboard**: Interactive visual monitoring UI for agent execution state, active escrows, and spending limits.

---

## Future (2027 Q1+ — Autonomous Multi-Agent Swarms)

Focus: Multi-agent coordination, algorithmic DeFi liquidity provision, and AI-negotiated smart contracts.

- **Multi-Agent Coordination Protocol**: Agent-to-agent payment channels and distributed task negotiation on Stellar.
- **DeFi Yield & Automated Treasury**: Autonomous cash management routing idle agent balances into yield-bearing Soroban liquidity pools.
- **Hardware Security Module (HSM) Integrations**: Non-custodial enterprise key management via AWS KMS and Ledger hardware devices.

---

## Completed Milestones

- ✅ **Initial Agent Brain Core**: Modular TypeScript runtime with task dispatching engine (`backend/agent.ts`).
- ✅ **Soroban Escrow Contracts**: Rust-based WebAssembly escrow contract suite (`contracts/escrow/`).
- ✅ **Dockerized Quickstart Stack**: Standalone local Stellar node + Soroban RPC docker-compose integration.
- ✅ **Domain Glossary & Templates**: 17+ domain terms defined in `GLOSSARY.md` and structured GitHub templates.

---

## Contributing to the Roadmap

Interested in tackling an upcoming feature or proposing a new milestone?
- Check out our **[Issues backlog](https://github.com/Nodal-stellar/Nodal-AI/issues)** filtered by `good first issue` or `developer-experience`.
- Read our **[Contribution Guide](./CONTRIBUTING.md)** for details on the Stellar Wave sprint workflow and earning Drips points.
