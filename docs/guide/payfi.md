# PayFi & x402

## What is PayFi?

PayFi (Programmable Finance) enables autonomous, programmable financial operations on blockchain networks.

## x402 Payment Standard

Nodal AI implements the x402 payment standard for machine-to-machine value exchange.

### Key Features

- Standardized payment protocol
- Secure transaction flows
- Multi-chain support

### Using x402

```typescript
import { x402Payment } from './backend/payfi';

const payment = await x402Payment({
  to: 'recipient_address',
  amount: '100',
  token: 'USDC'
});
```

## Next Steps

- [Security Model](./security.md) - Understand security considerations
