# MPP Payments

[MPP](https://paymentauth.org/draft-stellar-charge-00) (Machine Payments Protocol)
pays for HTTP requests without a facilitator. Nodal implements two modes.

| | MPP Charge | MPP Session |
| --- | --- | --- |
| Status | Implemented, client side | **Experimental prototype; moves no funds** |
| Settlement | One on-chain token transfer per request | None; local bookkeeping only |
| Mainnet | Yes | Refused |
| Class | `MppChargeClient` | `MppSessionClient` |

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `AGENT_SPENDING_LIMIT` | `100` | Applies to each charge and to the rolling window |
| `SPENDING_LIMITS` | unset | Per-asset limits; used instead when set |
| `SPENDING_WINDOW_MS` | `86400000` | Length of the rolling window, in milliseconds |
| `MPP_SESSION_SWEEP_INTERVAL_MS` | `60000` | How often timed-out channels are expired, in milliseconds |

## Charge

`MppChargeClient.fetch()` behaves like `fetch`. If the server answers `402` with a
Stellar charge challenge, it pays and retries; other responses are returned
untouched.

```typescript
import { MppChargeClient } from './backend/payments/mpp';

const { response, payment } = await new MppChargeClient().fetch('https://api.example.com/data');
if (payment) console.log(`Paid ${payment.amount} to ${payment.recipient}`, payment.reference);
console.log(response.status);
```

Before signing, it checks the kill switch, the spending limit, the network, the
expiry, and that the simulated transaction authorizes exactly the requested
transfer. It is a direct client call rather than an agent task, so call it only
for servers you trust.

A charge counts against the window as soon as the signed transfer is sent, even if
the server then returns an error, because the server can still broadcast it.
Server-sponsored (`feePayer`) challenges are refused.

## Session

::: danger Prototype
No escrow contract is deployed, no funds are locked, and nothing settles on-chain.
Do not treat a closed channel as paid.
:::

The intended usage:

```typescript
import { SimulatedChannelError } from './backend/errors';
import { MppSessionClient } from './backend/payments/mpp_session';

const client = new MppSessionClient();

// Amounts are in base units: 10000000 is 1 token.
const channel = await client.openChannel('G...', 'C...', '100000000', 3600);
const commitment = await client.commitPayment(channel.id, '1000000');
console.log(commitment.nonce, commitment.participantBalance);

try {
  await client.closeChannel(channel.id);
} catch (err) {
  // Always thrown: the channel is closed locally and nothing is settled.
  if (!(err instanceof SimulatedChannelError)) throw err;
}
```

| Call | What it is designed to do in the prototype |
| --- | --- |
| `openChannel` | Reserve the total against the spending limit and store the channel; throws on mainnet |
| `commitPayment` | Update balances and sign a commitment locally |
| `closeChannel` | Mark the channel `Closed` locally, then throw |
| `disputeChannel` | After the timeout, mark it `Disputed` locally, then throw |

The [session design](../design/mpp-session.md) describes the full protocol.

## Next steps

- [AI payment safety](./ai-safety.md): controls on MPP paths
- [PayFi and x402](./payfi.md): the other HTTP payment protocol
