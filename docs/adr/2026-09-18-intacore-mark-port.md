# ADR: INTACORE mark port — interface + refuse when unset

**Status:** proposed  
**Status note:** **Proposed (spec).** No vendor. No INTACORE. No `svc-chain`.  
**Decision owner:** Nitro. **Written by:** Grok (agents).  
**Spec id:** INTACORE margin marks + Predict **trading** marks (not resolution).  
**Parents:** [`2026-08-08-price-oracle-fail-closed.md`](2026-08-08-price-oracle-fail-closed.md) (S-A12 lending policy) · [`2026-09-18-intacore-module-map.md`](2026-09-18-intacore-module-map.md) (margin reads marks “once a source exists”) · [`2026-09-18-predict-resolution-stack.md`](2026-09-18-predict-resolution-stack.md) (resolution ≠ mark).  
**Does not start:** Chainlink / Pyth / UMA / house reporter networks. Does not stamp `socket.price-oracle` done.

**Ground truth on tip:** `FailClosedOracle` / `markFromPair` in `services/svc-protocol/src/oracle/fail-closed.ts` is the **Base lending** mark (S-A12 / S-A4). It is two independent push reporters, staleness bound, max disagreement bps, **minimum** of the two fresh agreeing prices. Stale or disagreeing **reverts**. No average, no last-good, **no AMM**. That policy hitch is the honesty. The Solidity contract on Base is **not** the INTACORE port.

---

## Decision

> **INTACORE margin, liquidation, and Predict _trading_ marks come from a typed port. Unset source → refuse the mark. Refuse the liquidation. Refuse the margin check. Do not invent a vendor, a last-good, or a book mid.**
>
> **Resolution of a Predict market is a different port** (designated reporter / oracle adapter / dispute — already specified). The outcome-share **book** is not the oracle. A “likely” from the clob is not a mark and not a resolution.

This file is the missing “once a source exists” contract S-D2 left hanging.

---

## 1 · Two jobs, two ports

| Job            | Used for                                                             | Source class                                    | Already specified?     |
| -------------- | -------------------------------------------------------------------- | ----------------------------------------------- | ---------------------- |
| **Mark**       | Protocol IM/MM, liquidation candidates, display of a mark (labelled) | Continuous price of an INTACORE market          | **This file**          |
| **Resolution** | Predict final outcome / scalar                                       | Frozen adapter or designated reporter + dispute | Predict resolution ADR |

Do not collapse them. A sports adapter that will resolve “Team A wins” on Sunday is not the mark for Friday’s margin. A BTC mark is not a Predict resolution.

Fiat house marks (`svc-trade` `accepted-mark` / liquidation tick) stay on the **house** book. They do not feed INTACORE. INTACORE marks do not post to the ledger.

---

## 2 · Mark port (interface)

Logical shape (not a TypeScript package INTACORE must import):

```
getMark(marketId) ->
  { price: decimal-string, asOf: caller-time, sourceId: string }
  | refuse(code)
```

| Field      | Rule                                                                  |
| ---------- | --------------------------------------------------------------------- |
| `marketId` | **INTACORE** id. Fiat registry id is a refuse (D-S-06).               |
| `price`    | Decimal string. Never a JS `number`. Strictly positive.               |
| `asOf`     | Time the **reporters** attested, not `Date.now()` inside the matcher. |
| `sourceId` | Named configured source. Missing name → unset.                        |

**Refuse codes (minimum set):**

| Code                | When                                                                                          |
| ------------------- | --------------------------------------------------------------------------------------------- |
| `mark.unset`        | No source bound for this market.                                                              |
| `mark.missing`      | Bound source, fewer than **two** independent fresh reports (hitch S-A12).                     |
| `mark.stale`        | Either report older than owner-published staleness bound. Bound blank → refuse (cannot mark). |
| `mark.disagreement` | Reports differ by more than owner-published max disagreement bps. Bound blank → refuse.       |
| `mark.bad_price`    | Non-positive / non-decimal.                                                                   |
| `mark.wrong_plane`  | Fiat id or Base pool id passed as INTACORE `marketId`.                                        |

Returned mark, when both reports agree and are fresh: **minimum** of the two prices (S-A12). Not the average. Not the max. Not the house mid.

---

## 3 · What the port must not do

| Ban                                          | Why                                                                                                                            |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Last-good                                    | A stale mark that still liquidates is the lending bug S-A12 killed.                                                            |
| Average through disagreement                 | Hides the split.                                                                                                               |
| Read our AMM / INTACORE mid / Fiat book      | Circular: the book is not the oracle. Predict: “likely” from shares is not resolution and not a margin mark for other markets. |
| Single reporter                              | S-A12: two independent push reporters. One is `mark.missing`.                                                                  |
| Invent Chainlink / Pyth / UMA / “the house”  | Vendor is an owner socket. House as a reporter must be **named** as `sourceId`, not hidden.                                    |
| Wire Base `FailClosedOracle.sol` as INTACORE | Wrong plane. Hitch the **policy**, not the address.                                                                            |
| Use mark as Predict resolution               | Wrong port.                                                                                                                    |

---

## 4 · Unset is the honest default

Until a source is bound per market:

- Margin module: **cannot** compute IM/MM → cannot open / cannot keep a levered position that needs a mark.
- Liquidation module: **cannot** liquidate (a liquidation without a mark is a seizure).
- Surfaces: show **absent mark**, never `0`, never last-good.

Listing an INTACORE perp/levered market with no bound mark source is **illegal**, same shape as Predict listing without a resolution source.

Spot-style INTACORE markets that **do not** use protocol margin may exist without a mark. If they later enable margin, bind a source first.

Owner holes (blank → refuse, never git-default):

- Staleness bound (seconds).
- Max disagreement bps.
- Which two reporters (vendor / keys).
- Whether the house is ever one of the two (if yes, name it).

---

## 5 · Tests that would go red (when the module exists)

A chain engineer opens **this file**, then:

1. Unset source → `getMark` refuses `mark.unset`. Liquidation path does not fire.
2. One reporter only → `mark.missing`.
3. Two reporters, one stale → `mark.stale`.
4. Two reporters, disagreement above unset/owner bps → `mark.disagreement` (blank bps: refuse, not “0 bps means perfect”).
5. Two fresh agreeing reports → mark is the **min**, decimal string.
6. Fiat market id → `mark.wrong_plane`.
7. AMM / mid injected as a reporter → refuse (not an independent push reporter).
8. Predict market: resolution adapter must not be callable as `getMark` unless a **separate** mark source was bound; book mid is not a mark.

Fiat pin today (policy hitch, not INTACORE): `services/svc-protocol/src/oracle/fail-closed.ts` `markFromPair` already refuses missing / stale / disagreement / bad price and returns the min. Do not weaken it. Do not import it into a validator.

---

## Refuse cases

| Situation                                        | Correct answer          |
| ------------------------------------------------ | ----------------------- |
| Liquidate with no mark                           | **No.**                 |
| “Use the book until the oracle is up”            | **No.**                 |
| Agent writes `PYTH_URL` default                  | **Stop.**               |
| Base FailClosedOracle address as INTACORE source | **Wrong plane.**        |
| Predict resolves from clob prices                | **No.** Resolution ADR. |
| Magnitudes filled in “for tests that look live”  | **Unset-refuse tests.** |

---

## Done bar (this ADR)

1. Mark port vs resolution port are split.
2. Unset / missing / stale / disagreement refuse is the law; min-of-two is the only success path.
3. Vendor and numeric bounds are owner holes.
4. §5 is the test list a later module must fail against.

## What agents may do without asking again

- Keep S-A12 fail-closed on Base lending.
- After P1 GO: implement the port with unset-refuse before any vendor.

## What still needs the owner

- Vendor / reporter identities (Class X / commercial).
- Staleness bound and max disagreement bps.
- Whether the house is a named reporter.
- P1 GO.
