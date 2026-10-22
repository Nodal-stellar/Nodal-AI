# Architecture

Nodal AI follows a modular architecture designed for security and extensibility.

## Core Components

### Agent
The main agent orchestrator that manages tool execution and transaction handling.

### Tools System
A pluggable framework for adding new capabilities to the agent.

### Security Layer
- Transaction simulation via Soroban RPC
- Externalized secret management
- Spending tracking and limits

### PayFi Integration
Native support for the x402 payment standard for machine-to-machine payments.

## Data Flow

1. Agent receives a request
2. Validates against security policies
3. Simulates transactions (if applicable)
4. Executes via appropriate tools
5. Returns results

## Next Steps

- [Agent Configuration](./agent-config.md) - Configure your agent
- [Tools System](./tools.md) - Learn about the tools framework
