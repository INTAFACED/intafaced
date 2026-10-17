# Engine ↔ ledger reconcile — what svc-matching shipped, and what svc-trade owes

**Date:** 2026-08-03 · **Branch:** `fix/engine-ledger-reconcile`
**Shipped here:** `services/svc-matching/**` only.
**Owed by:** whoever owns `services/svc-trade/**` — M3/M4 human mountain
(`docs/SHEHZAD-HARD-OWNERSHIP-2026-08-01.md`, `.github/CODEOWNERS`). **No agent implemented in svc-trade.**

---

## 1 · The bug, stated once

**Engine state and ledger state have independent lifecycles and nothing reconciled them at boot.**

The matching journal (`engine_journal.ndjson`, fsync'd per append) is durable and survives a database reset.
`trade.orders`, `trade.markets` and the ledger's `order:<id>` hold accounts live in Postgres. Reset one and the
other keeps its version of events.

Observed on the dev fleet on 2026-08-03, everything green: the engine held **8 resting orders across 10 market
ids, and not one of those markets still existed in `trade.markets`**. `trade.orders` was empty, so nothing was
stranded. That was luck.

**In production the inverse strands user money.** The ledger believes funds are reserved for an order the engine
has forgotten. No cancel path fires, because no cancel path knows the order exists. The funds are unreachable —
not lost on a balance sheet, just permanently unavailable to the user who owns them.

---

## 2 · The failure modes, both directions

Full table and reasoning: `services/svc-matching/README.md` § "Reconciliation", implemented in
`services/svc-matching/src/reconcile.ts`, proved in `src/reconcile.test.ts` (21 tests, real `MatchingEngine`).

| Case                                  | Engine      | svc-trade / ledger | Verdict                    |
| ------------------------------------- | ----------- | ------------------ | -------------------------- |
| `agreed`                              | live, qty N | open, qty N        | clean                      |
| `counterpart_unfunded_engine_missing` | absent      | pending, unfunded  | **auto**                   |
| `counterpart_open_engine_missing`     | absent      | open, **funded**   | **REFUSE** ← strands money |
| `engine_only`                         | live        | unknown            | **REFUSE**                 |
| `quantity_disagreement`               | live, qty N | open, qty M        | **REFUSE**                 |
| `counterpart_terminal_engine_live`    | live        | terminal           | **REFUSE**                 |
| `market_disagreement`                 | live in A   | open in B          | **REFUSE**                 |
| `unreadable_amount`                   | —           | malformed decimal  | **REFUSE**                 |
| `duplicate_counterpart_id`            | any         | same id twice      | **REFUSE**                 |

**One auto-resolves; eight refuse.** The one that auto-resolves is the only one whose repair provably moves no
value: an intent row the ledger never funded and the engine never accepted.

---

## 3 · What svc-matching now exposes (done, on this branch)

| Surface                         | What it gives you                                                                                                                                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /markets/:marketId/orders` | **Non-destructive** liveness read. Order id, account id, kind, side, price, remaining, sequence. Includes untriggered stops. Service-credentials only. `404` for an unknown market, `200` + `[]` for an empty book. |
| `POST /reconcile`               | Send `{ orders: CounterpartOrder[] }`, get the table above back as findings naming the order and **both** states. Read-only. `200` even on refusal.                                                                 |
| `GET /health` → `restingOrders` | The count an operator needs before letting anything trade.                                                                                                                                                          |
| Boot log                        | `warn` when the engine replayed live orders, naming both routes.                                                                                                                                                    |

`CounterpartOrder` is `{ orderId, marketId, state: 'pending'|'open'|'terminal', remaining: string, funded: boolean, detail?: string }`.

Two deliberate shapes:

- **`state` is three values, not svc-trade's six.** Mapping `filled | cancelled | rejected | expired` → `terminal`
  is svc-trade's job. Teaching the engine another service's enum would mean editing the engine every time that
  enum grows.
- **`funded` is a boolean the caller asserts.** The engine never computes it and never learns what it is
  denominated in. It is the one bit separating "an intent row nobody funded" — safely deletable — from "money is
  sitting against this", which is never safely anything without a human.

---

## 4 · What is owed on the svc-trade side

### 4.1 `reconcileOrder` has no caller. Anywhere.

`services/svc-trade/src/spot/trade-service.ts:1379`. Well-written, tested against real Postgres in
`order-route-reconcile.test.ts` — and **not reachable from any router, route, job or CLI**. Its only callers are
its own tests. A safety net nobody can pull is not a safety net.

This is the single highest-value item on this list.

### 4.2 `reconcileOrder` probes with `matching.cancel()` — a destructive probe

```
const eng = await this.matching.cancel(order.marketId, orderId);
const engineLive = eng.cancelled;
```

Asking "does the engine still have this order?" **removes the order**. That was the only probe available when it
was written; it is not any more. `GET /markets/:marketId/orders` answers the same question without touching the
book, so a sweep can now inspect a book instead of emptying it to find out what was in it.

Adding the read to `MatchingClient` (`services/svc-trade/src/spot/matching-client.ts`) is the enabling change.
That port is yours — svc-matching did not touch it.

### 4.3 `open_hold_no_engine` auto-releases, which is picking a winner on money

```
case: engineLive ? 'open_hold_engine_cleared' : 'open_hold_no_engine',
action: 'released',
```

When the engine misses, `reconcileOrder` releases the remainder and calls it `'never live / already gone'`. Those
two are not the same thing, and neither is the third possibility: **an engine fill whose `order.filled` event was
lost leaves exactly this shape.** In that world the funds are owed to the taker, not back to the user, and
releasing pays the user money the exchange owes someone else.

The three are indistinguishable from the order row and the hold balance alone. The difference lives in
`trade.fills`. `reconcileOrder` does not consult them.

**Flagging, not fixing.** Changing what this releases is a §0.6 ledger recipe question and recipes are an owner
carve-out (DIRECTION §3). No agent should touch it. Two options an owner might weigh:

1. Consult `trade.fills` for the order before releasing, and refuse when fills exist that the order row does not
   account for.
2. Split the case: release only where the engine confirms it never had the order, refuse otherwise.

Both are your call. Neither belongs in an agent PR.

### 4.4 `POST /reconcile` scheduled caller — **landed (A10)**

**Files:** `services/svc-trade/src/spot/engine-ledger-reconcile.ts` (+ `engine-ledger-reconcile-jobs.ts` + tests),
`MatchingClient.reconcile`, env `TRADE_RECONCILE_JOBS_ENABLED` / `TRADE_RECONCILE_JOBS_INTERVAL_MS` (**default OFF**).

What the job does:

- `SELECT` open/pending orders + live `order:<id>` hold balances → `CounterpartOrder[]` → POST matching `/reconcile`
- **Refuse → write nothing** (warn log with both states / metrics only)
- **Auto-delete only** unfunded **pending** (`counterpart_unfunded_engine_missing`); open+unfunded auto findings stay alert-only
- **Never** silent-releases funded missing; does **not** call `reconcileOrder` (still the per-order operator tool)
- **Market-id drift alarm (4.5) — landed:** each tick compares `SELECT id FROM trade.markets` to engine `GET /markets` (`MatchingClient.listMarkets`); symmetric diff is warn-log only — never invents or deletes markets, never moves value

`funded` comes from the ledger balance, never the order row snapshot.

Residual (still open): non-destructive probe on `reconcileOrder` itself is **probe-half sealed** (list-before-cancel #1524); **release-on-miss policy** remains owner carve-out (§4.3).

### 4.5 `trade.markets` and the engine's markets can drift with nothing noticing — **landed**

The 10-vs-16 market-id divergence had no alarm. `GET /markets` on the engine versus `SELECT id FROM trade.markets`
is compared on every A10 tick (`diffMarketIds` / `marketIdDrift` on the tick result). Alarm only — no heal.

---

## 5 · Constraints anything in this area inherits

- **§0.6** — value moves only through `packages/ledger-client` recipes. Reconciliation that moves value is a
  recipe, and recipes are an owner carve-out.
- **Money is never a `number`.** Decimal strings on the wire, scaled bigint in memory. `EngineLiveOrder` and
  `CounterpartOrder` are decimal strings end to end, and `reconcile.test.ts` asserts the 18th decimal place
  survives.
- **Do not weaken journal durability.** `FileJournal` fsyncs every append and that is load-bearing — it is the
  reason the engine's side of a disagreement is trustworthy at all.
- **Never delete or truncate a journal or a table to make a check pass.** The 8 stranded orders on the dev fleet
  are evidence; deleting them destroys the evidence and fixes nothing.
- **Refuse rather than guess.** A loud, specific refusal naming the order and both states beats an automatic fix
  that picks a winner.
