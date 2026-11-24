# Design Documentation

This section contains in-depth design documents for Nodal AI's architecture and security features.

## On-Chain Agent Spending Policy

Detailed design for enforcing spending limits at the protocol level using Soroban custom accounts.

[Read the full design document →](../design/onchain-policy.md)

### Overview

Today the agent's spending cap is enforced only inside the Node process. If the server is compromised or the key leaks, an attacker can sign transactions directly and the limit no longer exists.

**Goal:** The agent's funds cannot leave faster than _X tokens per window_ even when the attacker holds the agent key.

### Key Points

- Funds must live in a contract account (Soroban custom account)
- All agent spends become Soroban `transfer` calls
- A prototype custom policy contract is available in `contracts/agent_policy/`
- Production implementation will use OpenZeppelin Stellar smart accounts

### Status

**Spike / prototype** (issue #813)

See the [full design document](../design/onchain-policy.md) for implementation details, options evaluated, and follow-up work.
