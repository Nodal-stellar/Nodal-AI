# Security Model

Nodal AI is designed with security as a primary concern.

## Transaction Simulation

All transactions are simulated via Soroban RPC before broadcast to prevent errors and detect issues early.

## Secret Management

Secrets are never stored in the codebase. Use one of the following:

- AWS Secrets Manager
- Environment variables (development only)
- External secret storage

## Spending Limits

Configure spending limits to prevent unauthorized transactions:

```typescript
const agent = new Agent({
  security: {
    spendingLimit: 1000 // in XLM
  }
});
```

## Best Practices

1. Never commit secrets to version control
2. Use transaction simulation in production
3. Set appropriate spending limits
4. Audit tool permissions regularly
5. Use secure secret management solutions

## Next Steps

- [API Reference](/api/) - Explore the API documentation
