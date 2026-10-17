# D26-P2-03 — Unreachable money-guard inventory (trade / matching)

**Tracker:** D26-P2-03. **Lane:** `denon-d26-p2-03-unreachable-guards`.  
**Tip:** `1723273b` (`origin/main`). **Date:** 2026-08-15.  
**This PR:** docs only. It does **not** edit `services/svc-trade` (#1946) or `services/svc-matching` (P2-01d sibling).  
**Leverage (Phase A IN):** existing public-door suites as the map — do not rebuild trade or matching.

Done-bar for **this** slice: name which money guards exist only in unit tests / uncalled helpers, vs coverage already in promise-falsify (and the matching `#1730` door suite). Named residual files. **No silent “fixed”.** A guard is not eradicated until a mounted Fastify/tRPC door test fails if it is removed.

Prior matching deepen: `#1730` (`unreachable-guard-public-doors.test.ts`) is **LANDED**. It is coverage, not the whole mountain. Trade eradication is still residual.

---

## 0 · How to read a row

| Class               | Meaning                                                                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **PF door**         | Named in `promise-falsify-public-doors.test.ts` (D26-P2-01a trade / D26-P2-01d matching).                                              |
| **#1730 door**      | Named in matching `unreachable-guard-public-doors.test.ts` (money guards #1730 already took).                                          |
| **Sibling door**    | Other Fastify `inject` suites (private/public REST, TWAP/ADL/margin-call/funding doors). Public, but **not** the promise-falsify file. |
| **Unit-only**       | Production throws the code; only service/book/engine tests hit it. **Not eradicated.**                                                 |
| **Uncalled helper** | Function exists and unit tests pass; production never calls it. **Not eradicated.**                                                    |

Stubbed PF cases (router maps a thrown `TradeError`) prove **door mapping**, not that production emits the code. Those rows say **mapping**. Real `CopyService` / real `MatchingEngine` rows say **live**.

---

## 1 · Already on a public door (do not re-prove as “fixed”)

### 1.1 svc-trade — `promise-falsify-public-doors.test.ts` (D26-P2-01a)

| Guard                              | Door                                                      | Kind                            |
| ---------------------------------- | --------------------------------------------------------- | ------------------------------- |
| `trade.funding_rate_unavailable`   | `GET /api/v1/funding-rate/:symbol` (futures, unpublished) | live REST                       |
| `trade.funding_rate_spot_market`   | same path, spot symbol                                    | live REST                       |
| `trade.futures_disabled`           | `POST /api/v1/orders`                                     | **mapping** (stub `placeOrder`) |
| `trade.convert_insufficient_depth` | tRPC `convert.quote`                                      | **mapping**                     |
| `trade.convert_disabled`           | tRPC `convert.execute`                                    | **mapping**                     |
| anonymous convert                  | `convert.quote` without principal → 401                   | live (never reaches service)    |
| `trade.copy_jurisdiction_blank`    | tRPC `copy.follow`                                        | **live** `CopyService`          |
| `trade.copy_fee_share_blank`       | tRPC `copy.settleFeeShare`                                | **live** `CopyService`          |
| unpublished copy desk              | tRPC `copy.deskStatus`                                    | **live**                        |
| `trade.algo_mark_missing`          | tRPC `algo.createTwap`                                    | **mapping**                     |
| `trade.algo_disabled`              | tRPC `algo.createTwap`                                    | **mapping**                     |

File: `services/svc-trade/src/promise-falsify-public-doors.test.ts`.

### 1.2 svc-matching — `promise-falsify-public-doors.test.ts` (D26-P2-01d)

| Guard                                                                       | Door                                  |
| --------------------------------------------------------------------------- | ------------------------------------- |
| named cancel + `remainingQty` + sequence                                    | `DELETE /markets/:id/orders/:orderId` |
| double-cancel / wrong-market → `OrderNotFound`                              | same                                  |
| unauthenticated cancel → 401                                                | same                                  |
| phantom `GET /depth`, cancel, `GET /orders` → `MarketNotFound`, no allocate | those three                           |
| `fok_unfillable` does not list a never-traded market                        | `POST /markets/:id/orders`            |
| two door-fed engines byte-identical `serialize()`                           | submit+cancel stream                  |
| journal recorded through HTTP reconstructs `serialize()`                    | recover + `GET /depth`                |

File: `services/svc-matching/src/promise-falsify-public-doors.test.ts`.

### 1.3 svc-matching — `#1730` money-door suite (not PF, still a public door)

| Guard                                                                           | Door                             |
| ------------------------------------------------------------------------------- | -------------------------------- |
| `self_trade_prevention` cancel-oldest; fill at **maker** price; decimal strings | submit                           |
| `ioc_remainder`                                                                 | submit IOC                       |
| `post_only_would_cross`, book unchanged                                         | submit PO                        |
| `duplicate_order_id`                                                            | second submit same live id       |
| `engine_disabled`, journals nothing                                             | submit after `setEnabled(false)` |
| `quantity_disagreement` names both remainings                                   | `POST /reconcile`                |
| `GET /depth` decimal-string tuples                                              | depth                            |

File: `services/svc-matching/src/unreachable-guard-public-doors.test.ts`.

### 1.4 Sibling trade doors (not PF — do not treat as unit-only)

Named so a later agent does not “discover” them again:

- `services/svc-trade/src/private-rest.test.ts` — `price_not_accepted`, cross-margin, client open id, margin-call 404, …
- `services/svc-trade/src/public-rest.test.ts` — market closed / unknown schedule / timeframe
- `services/svc-trade/src/algo/twap-public-doors.test.ts` — TWAP progress / hydrate doors
- `services/svc-trade/src/futures/adl-public-doors.test.ts`
- `services/svc-trade/src/futures/margin-call-public-doors.test.ts`
- `services/svc-trade/src/futures/funding-net-zero-public-doors.test.ts`
- `services/svc-trade/src/copy/router-mount.test.ts`
- `services/svc-trade/src/otc/otc-mount.reachable.test.ts`
- `services/svc-matching/src/router.test.ts` — service-auth on writes; `engine_only` on reconcile

---

## 2 · Remaining uncalled helpers (production never calls)

These unit tests can stay green while the guard is dead in the process.

| Helper                            | File                                        | Who calls it                                                                     | Money why                                                                                                                                                                     |
| --------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `filterFindingsByCase`            | `services/svc-matching/src/reconcile.ts`    | `filter-findings.test.ts` only                                                   | Operator filter of stranded-fund findings. Router `POST /reconcile` returns the **full** `reconcile()` report; this helper is unwired.                                        |
| `summarizeReconcile`              | same                                        | `reconcile.test.ts` only                                                         | Counts refusals by case. Door sends the raw report, not the summary.                                                                                                          |
| `assertParentHasNoMoneyFields`    | `services/svc-trade/src/algo/present.ts`    | `twap-engine.test.ts`, `parent-store.test.ts`, `twap-ledger-nofill.test.ts` only | Forbids parent TWAP holding value. `presentAlgoProgress` calls a sibling assert; **this** function is never invoked from `twap-engine.ts` / `trade-service.ts` / `router.ts`. |
| `seedVolumeCountsTowardUserStats` | `services/svc-trade/src/mm/seed-honesty.ts` | `seed-honesty.test.ts` only                                                      | Constant `false`. Real exclusion is SQL `seeded = false` in candles — the helper is theater unless a door asserts the SQL path.                                               |
| `isHonestSeedSubmit`              | same                                        | `seed-honesty.test.ts` only                                                      | Production seeder uses `seedSubmitShape`, not this predicate.                                                                                                                 |

Not in this list (wired): `mayLiquidateFromExpiredMarginCallGrace` (liquidation tick), `mmSeedJobsArmed` (seed jobs), `copyLawStatusLine` (`CopyService.deskStatus`), `estimateConvert` (`TradeService`).

---

## 3 · Remaining unit-only money guards (matching)

`REJECT_CODES` / cancel reasons / reconcile cases **not** in PF or `#1730` doors. Engine/book tests only unless noted.

| Guard                      | Prod             | Unit file                        | Note                                                                                                                                    |
| -------------------------- | ---------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `invalid_qty`              | `engine/book.ts` | `book.test.ts`, `engine.test.ts` | Structural; trade should not send it. Still no HTTP pin.                                                                                |
| `invalid_price`            | `engine/book.ts` | `book.test.ts`                   | same                                                                                                                                    |
| `missing_price`            | `engine/book.ts` | `book.test.ts`                   | same                                                                                                                                    |
| `unexpected_price`         | `engine/book.ts` | `book.test.ts`                   | same                                                                                                                                    |
| `missing_stop_price`       | `engine/book.ts` | `book.test.ts`                   | stop path                                                                                                                               |
| `unexpected_stop_price`    | `engine/book.ts` | `book.test.ts`                   | stop path                                                                                                                               |
| `invalid_tif`              | `engine/book.ts` | `book.test.ts`                   | PO without price                                                                                                                        |
| `market_remainder`         | `engine/book.ts` | `book.test.ts`                   | **money** — leftover of a market order                                                                                                  |
| `trigger_rejected`         | `engine/book.ts` | `book.test.ts`                   | **money** — stop that cannot rest                                                                                                       |
| `duplicate_counterpart_id` | `reconcile.ts`   | `reconcile.test.ts`              | **money** — refuse duplicate claim; `#1730` covered `quantity_disagreement` + `engine_only` (router.test), not this case                |
| Reconcile residual cases   | `reconcile.ts`   | `reconcile.test.ts`              | `counterpart_open_engine_missing`, `counterpart_terminal_engine_live`, `market_disagreement`, `unreadable_amount` — not in `#1730` door |

`Unauthenticated` is returned by the router; PF + `router.test.ts` assert **401**, not always the code string. Treat as sibling-door, not unit-only.

---

## 4 · Remaining unit-only money guards (trade)

Not in the PF file. Many have sibling REST doors (see §1.4) — those are **not** listed again. Below: production emits the code; **no** PF door; typical proof is `*.test.ts` calling the service/helper.

### 4.1 Spot / hold / settle (high)

| Guard                                                                         | Residual test file(s)                                           |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `trade.client_order_id_required`                                              | `spot/trade-service.test.ts`                                    |
| `trade.hold_uncovered`                                                        | `spot/trade-service.test.ts`                                    |
| `trade.fee_exceeds_fill`                                                      | `spot/trade-service.test.ts`                                    |
| `trade.dust_fill`                                                             | (prod `trade-service.ts`; no dedicated door in PF)              |
| `trade.fill_sequence_conflict`                                                | `spot/trade-service.test.ts`                                    |
| `trade.no_reference_price`                                                    | `spot/risk.test.ts`, `trade-service.test.ts`                    |
| `trade.spot_disabled`                                                         | unit + chaos; **sibling** private REST exists — not PF          |
| `trade.seed_disabled` / `trade.seed_must_make`                                | `spot/order-route-seed.test.ts`                                 |
| `trade.order_not_open`                                                        | `trade-service.test.ts`                                         |
| `trade.insurance_fund_empty`                                                  | `trade-service.test.ts` + `insurance-listing-gate.test.ts`      |
| `trade.options_*` (law unset / fixing / terms)                                | `options-listing.test.ts`, `trade-service.test.ts`              |
| `trade.unsettled_asset_class_listing`                                         | `risk.test.ts`                                                  |
| `trade.sub_account_{denied,revoked,unavailable}`                              | `trade-service.test.ts`, `sub-account-ownership.test.ts`        |
| `trade.convert_no_liquidity` / `trade.convert_price_moved`                    | `convert/quote.test.ts`, `trade-service.test.ts` (execute path) |
| `trade.convert_{bad_depth,bad_spread,invalid_qty,spread_too_high,missing_id}` | quote helper / trade-service; **no door**                       |

### 4.2 Futures (high — this is where unreachable guards historically hid)

| Guard                                                                                   | Residual test file(s)                                                                                                                     |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `trade.mark_missing` / `trade.mark_unusable`                                            | `position-service.test.ts` — **sibling** doors exist for some observe paths; **open/close refuse is not in PF**                           |
| `trade.profit_source_underfunded`                                                       | `position-service.test.ts`                                                                                                                |
| `trade.insurance_underfunded`                                                           | `position-service.test.ts`                                                                                                                |
| `trade.funding_rate_exceeds_max` / `trade.funding_rate_bound_unconfigured`              | `funding-rate-bound.test.ts`, `funding-tick.test.ts`, `funding-settlement.test.ts`                                                        |
| `trade.leverage_too_high` / `trade.size_invalid`                                        | `orderable-path.test.ts` (service path, not PF)                                                                                           |
| `trade.position_not_open`                                                               | `position-close-concurrency.test.ts`                                                                                                      |
| `trade.adl_disclosure_*` / `trade.adl_unconfigured` / `trade.adl_no_eligible_candidate` | ADL modules; sibling `adl-public-doors.test.ts` for disclosure observe — last-resort **action** codes still unit/prod-untested through PF |
| `trade.closing_basis_missing` / `trade.close_in_progress` / `trade.close_refused`       | `position-service.ts` — **prod untested or unit-thin**                                                                                    |

### 4.3 Copy / OTC / algo (high)

| Guard                                                                                                                                                                                               | Residual test file(s)                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `trade.copy_cap_exceeded` / `copy_envelope_invalid` / `copy_key_expired` / `copy_market_not_permitted`                                                                                              | `copy/copy-service.test.ts`                                          |
| `trade.copy_fee_share_killed` / `copy_pnl_fee_forbidden`                                                                                                                                            | `copy/fee-share.test.ts`                                             |
| `trade.copy_jurisdiction_blocked`                                                                                                                                                                   | `copy-service.test.ts` (PF covers **blank** law, not blocked region) |
| `trade.copy_already_following` / `copy_not_following` / `copy_self_follow` / `copy_settle_refused`                                                                                                  | copy service / router cases; not PF                                  |
| `trade.otc_desk_law_blank` / `otc_stake_gate` / `otc_no_reference_price` / settle/quote codes                                                                                                       | `otc/*` tests; sibling mount test is reachability, not each refuse   |
| `trade.algo_principal_unavailable` / `algo_insufficient_balance` / `algo_mark_unusable` / `algo_price_band` / `algo_cancel_incomplete` / `algo_child_cancel_failed` / `algo_resume_extends_too_far` | `algo/twap-engine.test.ts`                                           |
| `trade.algo_invalid_qty` / `algo_invalid_schedule` / `algo_duplicate_id` / `algo_bad_state`                                                                                                         | schedule / twap-engine — **prod untested through PF**                |

---

## 5 · Named residual files (next door tests — do not edit in this PR)

Matching (stay off P2-01d production; a later **test-only** PR may add cases to a new file or deepen PF):

1. `services/svc-matching/src/engine/book.ts` — `market_remainder`, `trigger_rejected`, structural `REJECT_CODES` not in `#1730`.
2. `services/svc-matching/src/reconcile.ts` — `duplicate_counterpart_id` + residual refuse cases; wire or delete `filterFindingsByCase` / `summarizeReconcile`.
3. `services/svc-matching/src/unreachable-guard-public-doors.test.ts` — extend **or** add a sibling test file (do not dual-edit an open P2-01d PR).

Trade (stay off #1946 production):

1. `services/svc-trade/src/spot/trade-service.ts` — hold/fee/dust/clientOrderId/convert execute refuses through **private REST or tRPC**, not `createCaller` alone.
2. `services/svc-trade/src/futures/position-service.ts` — open/close `mark_*` / profit-source / insurance through **private REST**.
3. `services/svc-trade/src/futures/funding-rate-bound.ts` — bound refuse through the funding-rate **public** door (PF today only covers unpublished → no `0`).
4. `services/svc-trade/src/copy/copy-service.ts` — cap / envelope / killed fee-share through tRPC (PF only blank §8).
5. `services/svc-trade/src/algo/twap-engine.ts` + `present.ts` — tick/cancel/resume refuses through tRPC; call `assertParentHasNoMoneyFields` from production or drop the helper.
6. `services/svc-trade/src/otc/*` — desk-law / stake / stale-mid refuses through mounted OTC router.
7. `services/svc-trade/src/mm/seed-honesty.ts` — either call `isHonestSeedSubmit` / volume helper from the seeder path a door can see, or stop treating the unit file as the guard.

---

## 6 · What this inventory does **not** claim

- Matching `#1730` did **not** finish D26-P2-03. Trade public-door eradication is open. Matching still has unit-only remainder/stop/reconcile cases and two uncalled helpers.
- PF mapping tests are not production-emit proofs.
- No code was “fixed” here. Next CODE PR must add a door test that goes red if the guard is removed.
- Do not edit `services/svc-trade` while #1946 is the trade writer. Do not edit `services/svc-matching` while P2-01d is the matching writer.

---

## 7 · Leverage

Phase A **IN**: `services/svc-trade/src/promise-falsify-public-doors.test.ts`, `services/svc-matching/src/promise-falsify-public-doors.test.ts`, `services/svc-matching/src/unreachable-guard-public-doors.test.ts`. No second suite framework. No Vue. No svc-edge.
