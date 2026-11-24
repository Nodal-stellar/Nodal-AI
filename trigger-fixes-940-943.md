# Trigger Security & Reliability Fixes

Closes #940
Closes #941
Closes #942
Closes #943

---

## Overview

Four related issues in `backend/triggers.ts` were identified and fixed:

| Issue | Problem |
|-------|---------|
| #940 | Asset-code spoofing: `matchesFilter` compared only `assetCode`, ignoring issuer |
| #941 | Non-native trigger creation allowed without `assetIssuer`; `minAmount` used `parseFloat` instead of BigInt stroops |
| #942 | `setupContractListener()` was an empty stub — contract-event triggers were silently accepted but never fired |
| #943 | `setupStorageListener()` was an empty stub — storage-change triggers were silently accepted but never fired |

---

## Changes

### `backend/triggers.ts`

#### #940 — Asset issuer check in `matchesFilter`

**Before:** the filter compared only the asset code, so a trigger intended for the
real USDC would also fire on any token with the same ticker but a different
(attacker-controlled) issuer.

```ts
// OLD
const eventAsset = (e.assetCode as string) ?? (e.asset as string);
if (eventAsset !== filter.assetCode) return false;
```

**After:** for every non-XLM asset that carries an `assetIssuer` in the filter,
both code **and** issuer must match exactly.

```ts
// NEW
if (filter.assetCode !== 'XLM' && filter.assetIssuer) {
  const eventAssetIssuer = (e.assetIssuer as string) ?? '';
  if (eventAssetCode !== filter.assetCode || eventAssetIssuer !== filter.assetIssuer) {
    return false;
  }
}
```

`assetIssuer` was added to the `TriggerFilter` interface and the payment object
built inside `setupPaymentListener` now forwards `challenge.assetIssuer`.

#### #941 — Reject non-native trigger without `assetIssuer` at creation time

**Before:** `createTrigger` persisted any filter verbatim.

**After:** `createTrigger` validates the filter and throws before persisting:

```ts
if (filter.assetCode && filter.assetCode !== 'XLM' && !filter.assetIssuer) {
  throw new Error(
    `assetIssuer is required for non-XLM asset trigger (assetCode: ${filter.assetCode})`
  );
}
```

#### #941 — `minAmount` switched from `parseFloat` to BigInt stroops

```ts
// OLD
const eventAmount = parseFloat(String(e.amount ?? e.value ?? '0'));
const minAmount   = parseFloat(filter.minAmount);
if (eventAmount < minAmount) return false;

// NEW — uses toStroops() from backend/utils/amount.ts
const eventStroops = toStroops(String(eventAmount));
const minStroops   = toStroops(minAmount);
if (eventStroops < minStroops) return false;
```

An unparseable amount now hard-fails to `false` instead of silently evaluating
`NaN < threshold` (which is always `false`, causing the trigger to fire).

#### #942 — Wire up `setupContractListener`

**Before:**

```ts
private setupContractListener(): void {
  // Contract events are set up per-contract
}
```

**After:** triggers are grouped by `contractId`. One `ContractEventListener` is
started per unique contract, with its `eventTopics` union-deduplicated across all
triggers for that contract. Each incoming Soroban event is dispatched to
`handleContractEvent`, which:

1. Shapes the raw `rpc.Api.EventResponse` into the form `matchesFilter` expects
   (`contractId`, `topics[]`, `value`, `ledger`).
2. Runs `matchesFilter` against every enabled `contract_event` trigger for that contract.
3. Deduplicates by `event.id` via `recordTriggerFired` — the same SQLite
   `INSERT OR IGNORE` guard used by payment triggers, so deduplication survives
   process restarts.
4. Calls `agent.run(trigger.task)` and updates `lastFiredAt`.

Listeners are stored in `contractWatchers` (`Map<contractId, { stop, triggers }>`)
and are torn down in `stop()`.

#### #943 — Wire up `setupStorageListener`

**Before:**

```ts
private setupStorageListener(): void {
  // Storage changes are set up per-contract
}
```

**After:** triggers are grouped by `contractId`. One `ContractStorageWatcherTool`
handle is started per contract, watching the union of all `storageKey` values
declared across its triggers. Each `change` event is dispatched to
`handleStorageChange`, which:

1. Checks `contractId` and (if present) `storageKey` against the filter — a
   trigger with no `storageKey` fires on any key change for that contract.
2. Deduplicates by `${ledger}:${keyXdr}` via `recordTriggerFired`.
3. Calls `agent.run(trigger.task)` and updates `lastFiredAt`.

`storageKey` values are normalised via `xdr.LedgerKey.fromXDR` /
`xdr.ScVal.fromXDR` with a plain-string symbol fallback, matching
`ContractStorageWatcherTool`'s own `normalizeLedgerKey` behaviour.

Watchers are stored in `storageWatchers` and torn down in `stop()`.

---

### New file: `tests/triggers.test.ts`

| Test suite | What it covers |
|------------|----------------|
| `matchesFilter — asset issuer discrimination` | Same code + different issuer → `false`; same code + same issuer → `true`; XLM always matches on code alone |
| `matchesFilter — amount comparison with BigInt` | 1-stroop boundary: exact threshold passes, one stroop under fails |
| `createTrigger — non-native asset validation` | Missing issuer throws; valid issuer accepted; XLM with no issuer accepted |
| `matchesFilter — edge cases` | X402 payment shape; legacy (no-issuer) triggers still match by code only |
| `ContractEvent trigger` | `listenContractEvents` is called with correct `contractId` and `eventTopics` on `start()` |
| `StorageChange trigger` | `watchContractStorage` is called with correct `contractId` on `start()` |
| `Deduplication` | `recordTriggerFired` returns `true` first call, `false` on repeat for same trigger+event pair |

---

## Files changed

| File | Status |
|------|--------|
| `backend/triggers.ts` | Modified |
| `tests/triggers.test.ts` | Added |
| `.gitignore` | Modified |
| `trigger-fixes-940-943.md` | Added (this file) |
