# Triggers

::: warning Experimental
Triggers are a library API and are not started by the agent process. The built-in
payment listener delivers payments that carry an `x402:` memo; to act on other
payments, see the [escrow walkthrough](../tutorials/trigger-escrow-release.md).
:::

A trigger runs one task when a matching event occurs: "when 25 USDC arrives from
this buyer, release the escrow". Triggers are stored in the agent database, and
each event fires a trigger at most once.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `TRIGGER_ALLOW_PAYMENTS` | `false` | Allow triggers whose task is value-moving; creating one otherwise throws |
| `TRIGGER_EVENTS_RETENTION_MS` | `604800000` | Intended retention of the deduplication records, in milliseconds |
| `RETENTION_DAYS_TRIGGER_EVENTS` | `30` | Days the retention job keeps deduplication records |
| `CONTRACT_EVENT_POLL_MS` | unset | Contract event polling interval, in milliseconds |

## Create a trigger

```typescript
import { PayFiAgent } from './backend/agent';
import { TriggerManager } from './backend/triggers';

const agent = new PayFiAgent();
const manager = new TriggerManager(agent);

const trigger = await manager.createTrigger({
  source: 'payment',
  filter: {
    assetCode: 'USDC',
    assetIssuer: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
    from: 'G...',
    minAmount: '25',
  },
  task: {
    type: 'stellar_payment',
    payload: { destination: 'G...', amount: '1' },
    requireApproval: true,
  },
});

await manager.setTriggerEnabled(trigger.id, false);
await manager.deleteTrigger(trigger.id);
```

## Filters

| Field | Applies to | Matches when |
| --- | --- | --- |
| `assetCode` | payment | The asset code is equal (`XLM` for native) |
| `assetIssuer` | payment | The issuer is equal; checked together with a non-XLM `assetCode` |
| `from` | payment | The sender is equal |
| `minAmount` | payment | The amount is at least this, compared in stroops |
| `contractId` | contract event | The contract is equal |
| `eventTopics` | contract event | Any listed topic is present |
| `storageKey` | storage change | The key XDR is equal |

**Always set `assetIssuer` with a non-XLM `assetCode`.** Anyone can issue an asset
called `USDC`. Without an issuer, the filter matches all of them.

## Supported task types

Creating a trigger for a value-moving task type (`VALUE_MOVING_TASK_TYPES` in
`backend/agent.ts`) needs `TRIGGER_ALLOW_PAYMENTS=true`.

| Task type | What it does |
| --- | --- |
| `stellar_payment` | Send a payment |
| `soroban_invoke` | Invoke a contract |
| `x402_respond` | Answer an x402 challenge |
| `change_trust` | Add or remove a trustline |
| `multisig_payment` | Multisig payment |
| `batch_payment` | Batch of payments |
| `path_payment` | Cross-asset payment |
| `fee_bump` | Fee-bump a transaction |
| `dex_offer` | Place, change or delete an offer |
| `liquidity_pool` | Deposit to or withdraw from a pool |
| `data_entry` | Account data entry |
| `sequence_number` | Read or bump the sequence number |
| `sponsored_account` | Create a sponsored account |
| `soroban_deploy` | Deploy a contract |
| `swap` | Swap assets |
| `set_options` | Account options |
| `account_info` | Read the agent account |
| `balance_check` | Read a balance |
| `stellar_toml` | Read a `stellar.toml` |
| `soroban_query` | Read-only contract call |
| `soroban_event_query` | Query contract events |
| `stellar_identity_auth` | SEP-10 or SEP-45 authentication |
| `friendbot` | Fund a test account |
| `nano_payment` | Nano payment |
| `ledger_info` | Latest ledger |
| `network_status` | Endpoint health |
| `offer_book` | Order book |
| `soroban_storage` | Read contract storage |

## Next steps

- [Escrow release walkthrough](../tutorials/trigger-escrow-release.md): a complete testnet example
- [Approvals](./approvals.md): hold a trigger's task for a person
- [AI payment safety](./ai-safety.md): which controls apply to triggers
