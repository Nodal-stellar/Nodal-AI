# Agent Configuration

## Configuration Options

The agent accepts a configuration object with the following options:

```typescript
interface AgentConfig {
  // Stellar network configuration
  network: 'mainnet' | 'testnet' | 'futurenet';
  
  // Secret management
  secrets: {
    type: 'aws-secrets' | 'env' | 'file';
    // ... additional options
  };
  
  // Security settings
  security: {
    simulateTransactions: boolean;
    spendingLimit?: number;
  };
  
  // Tools configuration
  tools?: ToolConfig[];
}
```

## Environment Variables

Required environment variables:

- `STELLAR_SECRET_KEY` - Your Stellar secret key (use external secret management in production)
- `NETWORK` - Stellar network to use (mainnet/testnet/futurenet)

## Next Steps

- [Tools System](./tools.md) - Learn about the tools framework
