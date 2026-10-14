# ADR: shared matching conformance — one spec both runtimes import

**Status:** proposed  
**Status note:** **Proposed (spec).** Implement of INTACORE stays **parked**.  
**Decision owner:** Nitro. **Written by:** Grok (agents).  
**Spec id:** D-S-06 done-bar 3 (shared rows).  
**Parent:** [`2026-08-04-matching-dual-target.md`](2026-08-04-matching-dual-target.md) · module map [`2026-09-18-intacore-module-map.md`](2026-09-18-intacore-module-map.md).  
**Does not start:** `services/svc-chain`, a third matching package, a TypeScript engine inside a validator, `chain.mainnet` Done.

**Ground truth on tip:** Fiat `svc-matching` runs. INTACORE does not exist. D-S-06 already required “order semantics expressed once, with conformance tests any runtime must pass.” This file **is** those rows. Fiat pins are the named tests below; they go red if Fiat drifts. INTACORE, when built, imports **this document**, not `book.ts`.

---

## Decision

> **A user must not learn two meanings of “limit”, “IOC”, or “self-trade”.** The matching **spec** is shared. The **runtime** is forked (service vs in-validator module). **Finality is not in this file** — Fiat final = ledger post; Protocol final = chain finality (D-S-06 Decision 1).
>
> A match is a **proposal** on both planes. This spec says who trades, at what price, in what order. It does not say when the fill is money.

Do not invent a third matching package. Do not copy the TypeScript engine into a validator. Do not silently pool Fiat and INTACORE books. Market ids stay **different by default**.

---

## 1 · Shared vocabulary (published contract)

Source of the bot-facing tokens: `packages/exchange-contract/src/schemas.ts`.

The engine **derives** these types (`services/svc-matching/src/engine/types.ts`). It does not redeclare a second enum.

| Token    | Values                                  | Rule                                                                                                                                                                                                                                                                       |
| -------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Side** | `buy`, `sell`                           | Opaque. No house/vip/plane field on the order.                                                                                                                                                                                                                             |
| **Type** | `market`, `limit`, `stop`, `stop_limit` | `take_profit` exists on the **public** contract and is a product mapping (svc-trade → `stop` / `stop_limit`) **before** the engine. The engine has one trigger rule. INTACORE must map or **refuse** `take_profit` at the module boundary — never invent a second trigger. |
| **TIF**  | `GTC`, `IOC`, `FOK`, `PO`, `GTD`, `GTT` | Missing / blank / unknown TIF is **`tif_missing`**. It is **not** GTC.                                                                                                                                                                                                     |

Pin: `KNOWN_TIF` in `services/svc-matching/src/engine/core-tif.ts` **is** `timeInForceSchema`. Drift = red (`shared-conformance.pin.test.ts`).

---

## 2 · Time-in-force (same words, both runtimes)

| TIF   | Meaning (both runtimes)                                                          | Refuse / cancel                                                                    | Fiat pin                                          |
| ----- | -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------- |
| `GTC` | Rest until filled or cancelled.                                                  | —                                                                                  | `core-tif.test.ts` “present tif GTC still rests”  |
| `IOC` | Take what is there. **Unfilled remainder cancels.** No leftover rest.            | Cancel reason `ioc_remainder` (limit) or `market_remainder` (market has no price). | `ioc.ts` `iocRests`; engine IOC tests             |
| `FOK` | Fill the **entire** qty or cancel the **whole**. No partial leftover.            | `fok_unfillable` when the book cannot fill all.                                    | `fok.ts` `wholeOrNothing`                         |
| `PO`  | Rest only if it **does not take**. Requires a limit price.                       | `post_only_would_cross` if it would take; `invalid_tif` if no limit price.         | `book.ts` post-only branch                        |
| `GTD` | Good-till-date. Caller `expireAt` required. Engine does not invent EOD.          | `missing_expire_at` / `already_expired`                                            | `core-tif.test.ts` GTD with expireAt              |
| `GTT` | Good-till-time. Same `expireAt` rule. Missing expire refuses — not a silent GTD. | `missing_expire_at`                                                                | `core-tif.test.ts` “GTT missing expireAt refuses” |

**Missing TIF is not GTC.** That sentence is load-bearing. Fiat already hitch-refuses it (`TIF_MISSING_MESSAGE`). INTACORE must refuse the same way.

---

## 3 · Tick and lot (not decimal places)

Published shape: `exchange-contract` market `precision.price` = **tick**, `precision.amount` = **lot**. They are decimal strings. They are **not** a count of decimal places (`EUR/USD` lot `1000` and `NATGAS/USD` lot `10` both collapse to “0 places”).

| Check              | Rule                                                                                   | Where Fiat enforces today                         |
| ------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Qty on lot grid    | `qty % lotSize === 0` and `qty > 0`. Below min / above max refuse.                     | `services/svc-trade/src/spot/risk.ts` `assertQty` |
| Price on tick grid | `price % tickSize === 0` and `price > 0`.                                              | `risk.ts` `assertPrice`                           |
| Off-grid           | **Refuse.** Do not round silently into the book.                                       | `trade.invalid_qty` / `trade.invalid_price`       |
| Engine input       | Fiat engine receives **already-validated** scaled bigints (`Amount`).                  | `types.ts` EngineOrder header                     |
| INTACORE           | Must enforce the **same grid** at the module boundary. Off-tick/off-lot does not rest. | (no chain module yet)                             |

The engine does not invent a tick. A market with unpublished tick/lot **cannot list**.

Owner hole: the actual tick/lot **values** per INTACORE market. Not this file.

---

## 4 · Self-trade prevention (v1)

Fiat v1, and therefore the shared v1:

> **Same live account. Expire the resting maker. Continue the taker. Never invent a self-fill.**

| Rule                 | Detail                                                                                           | Fiat pin                                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Identity             | STP identity = `accountId` (opaque string). Missing / blank identity **refuses** (`self_trade`). | `self-trade.ts` `stpIdentityRefuse`; `self-trade.test.ts` empty ids                    |
| Detection            | `takerAccountId === makerAccountId` and both present.                                            | `isSelfTrade`                                                                          |
| Action               | Cancel resting with reason `self_trade_prevention`. Taker walks the book.                        | `self-trade.test.ts` “crossing own rest expires the rest — no fill, taker continues”   |
| Behind the self rest | Taker may fill a **stranger** behind the expired own rest.                                       | `self-trade.test.ts` “expires own rest and fills the stranger behind it”               |
| Mode                 | v1 is **CANCEL_RESTING_CONTINUE**. No owner STP-mode switch in this spec.                        | `self-trade.ts` header                                                                 |
| Surveillance         | Fiat opens an evidence case (`self_trade`, status `open`). Evidence only — **not a fine**.       | Fiat-only add-on. INTACORE may omit the case object; it may **not** self-fill instead. |

Do not add “cancel both”, “cancel newest”, or “decrement” as a silent default. A later STP mode is an **owner ADR** with a named mode, not a git default.

---

## 5 · Price-time algebra

| Rule                      | Detail                                                                                                 | Fiat pin (`book.test.ts` “price-time priority”)                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Better price first        | Bids: higher price is better. Asks: lower price is better. Arrival order does not beat a better price. | “fills the better price first regardless of arrival order”; ask-side “lowest is best”      |
| Same price: earlier first | At one price, the earlier accepted order is maker first (sequence).                                    | “fills the earliest order first when prices are equal”                                     |
| Partial keeps place       | A rest that is partially filled **keeps** its queue sequence.                                          | “a resting order keeps its place in the queue after a partial fill”                        |
| Fill price                | Fill `price` is always the **resting (maker)** price. The taker pays the book.                         | `types.ts` `Fill` (“the taker pays the book”); better-price test fillPrices `['101','99']` |
| Account ids opaque        | No branch on house / tenant / vip / plane inside the matcher.                                          | `dual-target-one-book.test.ts` source scan                                                 |
| One book per market       | No parallel house book in the same runtime.                                                            | `dual-target-one-book.test.ts`                                                             |

INTACORE may use a different sequence integer, but the **observable order of makers at a price** must be acceptance order.

---

## 6 · Determinism (property, not implementation)

Replay of the same accepted commands, in the same order, with the same inputs, yields a **byte-identical book**.

Fiat mechanism (not required of INTACORE): event journal + `serializeBooks` / `OrderBook.serialize`.

Shared property (required of INTACORE):

1. No wall clock inside the matcher (`Date.now` / `new Date` as a matching input).
2. No randomness (`Math.random` / UUID mint) as a matching input. Ids come from the caller.
3. No JS `number` / IEEE float as a price or qty. Wire form is a **decimal string**; memory is a scaled bigint (`Amount`).
4. Unordered iteration that reaches the output is forbidden (Fiat: `book.ts` header).
5. Two restorations of the same snapshot continue matching identically.

Fiat pins:

- `book.test.ts` “serialised state”: round-trip byte for byte; restored book matches where the original left off; no floating-point in the snapshot.
- `journal-replay.ts` `serializeBooks` — canonical string, markets sorted by id.
- `book.ts` header: the four forbiddens.

INTACORE storage may be a Merkle store rather than a JSON snapshot. The **property** is identical replay, not JSON.

---

## 7 · What this spec does **not** share

| Layer                                      | Fiat                                                                  | Protocol                                                                  | Shared?            |
| ------------------------------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------ |
| Finality                                   | Ledger post (`packages/ledger-client`)                                | Chain finality depth                                                      | **No**             |
| Custody                                    | Platform holds                                                        | Platform never holds                                                      | **No**             |
| Journal / Postgres                         | Matching journal                                                      | Module store                                                              | **No**             |
| Market id                                  | Registry ids                                                          | Different ids by default                                                  | **No** (ids)       |
| Liquidity                                  | House book                                                            | INTACORE book                                                             | **No**             |
| COD / session-dead                         | Fiat session tags                                                     | —                                                                         | Fiat-only          |
| Dual-control halt / kill                   | Operator + confirm                                                    | Chain halt is a different control                                         | Fiat-only          |
| Unpublished collars / bands                | Owner magnitudes blank → refuse                                       | Owner magnitudes blank → refuse (same **honesty**, different params)      | Honesty only       |
| Iceberg / OCO / AON / peg / combo / collar | Fiat engine instructions; unsupported ones **refuse** rather than map | INTACORE may refuse the same names until a later ADR lists them as shared | Not v1 shared      |
| Predict outcome shares                     | Not a Fiat market type                                                | INTACORE market type; **matching** of shares still uses this spec         | Matching yes       |
| House ADL / insurance                      | `svc-trade` futures                                                   | Protocol liquidation module (S-D2)                                        | **No** — two paths |

Advanced Fiat instructions (`peg_unsupported`, `midpoint_unsupported`, `combo_unsupported`, …): INTACORE **must not** silently turn them into ordinary limits. Refuse or implement under the same name. Mapping is a lie.

---

## 8 · Amounts and the wire

- Wire: decimal **strings**. Memory: scaled **bigint** (`@intafaced/ledger-client/money` `Amount`).
- A snapshot that round-trips JSON must not lose a unit at the 18th decimal.
- `JSON.stringify(0.1 + 0.2)` is why floats are banned in this spec, not a style note.

INTACORE may use a chain integer denom. It must still **round-trip** without float.

---

## 9 · Cross-plane refuses (still D-S-06)

These are not matching algebra, but a chain engineer will hit them on day one:

| Situation                                    | Correct answer                                      |
| -------------------------------------------- | --------------------------------------------------- |
| Fiat market id used as INTACORE market id    | **Refuse.** Different id spaces until an owner ADR. |
| Engine matched, ledger not posted (Fiat)     | **Pending.** Not filled.                            |
| Chain match below finality depth             | **Pending.** Surface says which plane.              |
| Blotter mixes planes                         | **Label the plane per fill.**                       |
| Copy TypeScript `OrderBook` into a validator | **No.** This spec, not that file.                   |
| Third matching npm package “for both”        | **No.**                                             |

---

## 10 · How INTACORE imports this

1. Open **this file**.
2. For each shared row, write a test in the chain repo / module that would go red if the row is violated.
3. Do **not** import `@intafaced/svc-matching`. Do **not** vendor `book.ts`.
4. Fiat remains the living reference implementation. If Fiat and this file disagree, **this file plus the named pin tests** are the bug — fix Fiat or fix the file in the same PR, never leave them split.

When the second runtime exists, a CI job that both runtimes pass is the D-S-06 mirror. Until then, Fiat pins **are** the conformance suite.

---

## Refuse cases

| Situation                                                   | Correct answer                                            |
| ----------------------------------------------------------- | --------------------------------------------------------- |
| Missing TIF                                                 | `tif_missing` — not GTC                                   |
| Unknown TIF token (`DAY`, `GTX`, …)                         | `tif_missing` — not mapped                                |
| FOK that cannot fill all                                    | `fok_unfillable` — no partial                             |
| PO that would take                                          | `post_only_would_cross` — no rest, no take                |
| Off-tick price / off-lot qty                                | Refuse. No silent round                                   |
| Blank `accountId` on a crossing                             | Refuse the match. Not a self-fill of “everyone empty”     |
| Same account crosses                                        | Expire rest, continue taker. **No fill** between them     |
| `take_profit` submitted to the engine/module                | Map upstream or refuse. Do not grow a second trigger rule |
| Match reported as final                                     | Out of scope of this file — D-S-06 finality               |
| Agent adds `services/svc-chain` to “run the tests on chain” | **Stop.** Parked                                          |

---

## Done bar (this ADR)

**Spec is done when all of:**

1. This file names types, TIF, tick/lot, STP v1, price-time, determinism, and the not-shared list.
2. Fiat pin test `services/svc-matching/src/engine/shared-conformance.pin.test.ts` is red if:
   - `KNOWN_TIF` ≠ `timeInForceSchema`
   - public `orderTypeSchema` loses `take_profit` or the engine starts accepting it as a native type
   - `SELF_TRADE_PREVENTION` is renamed away from expire-resting
   - `book.ts` gains `Date.now` / `Math.random` / `crypto.randomUUID` as matching inputs
   - this ADR is deleted or loses the required row tokens
   - `dual-target-one-book.test.ts` or `self-trade.test.ts` or `book.test.ts` disappear
3. A chain engineer can fail an INTACORE test against a **named row** in §2–§6 without reading `engine.ts`.

**INTACORE code is not done** (and is not started) until Nitro GOs P1. Passing Fiat pins does not unpark the chain.

---

## What agents may do without asking again

- Keep the Fiat pins green.
- After P1 GO: write INTACORE tests that import **this file’s rows**.
- Refuse cross-plane market ids on any surface that sees both.

## What still needs the owner

- Whether INTACORE market ids ever equal Fiat ids (default: no).
- Whether the planes ever share liquidity (default: no).
- Whether INTACORE v1 includes iceberg / OCO / AON / peg (default: refuse those names until listed here).
- A later STP mode other than CANCEL_RESTING_CONTINUE.
- Tick/lot magnitudes per INTACORE market.
- Chain finality **depth** (not a matching row).
