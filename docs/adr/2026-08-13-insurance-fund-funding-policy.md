# ADR: insurance fund funding policy — empty fund, no live perps

**Status:** **Accepted — 2026-08-13 (D26-P0-17 sealed).** Addendum **2026-08-15**: list gate is an existing-recipe path only.  
**Decision owner:** repo owner (Denon). **Written by:** Denon.  
**Board:** D26-P0-17 — Insurance fund funding policy (futures list gate).  
**Packet:** `OWNER-DECISION-PACKET-PART-TWO-2026-08-09.md` (removed) §P0-17.  
**Builds on:** `DIRECTION-2026-07-31.md` (removed) §1 (“If it is empty, futures do not list”); [`2026-08-12-listing-delisting-policy.md`](2026-08-12-listing-delisting-policy.md) (D26-P0-06); [`2026-08-05-futures-risk-and-mark-law.md`](2026-08-05-futures-risk-and-mark-law.md) (house fees are not insurance). T1d facts: `insurance-shortfall-balance.test.ts` (#1684).  
**Does not invent:** target fund size, fee-share into the pot, capitalisation schedule, insurance bps, ADL thresholds, or a second money book. This ADR does **not** edit `svc-trade`.

---

## The decision

> **A real-money perpetual does not list, and does not become `active`, while the insurance pot for its quote asset is empty or unset. The list gate requires a funded insurance path via existing ledger recipes only. House trade fees are not a substitute pot.**
>
> **The pot is the ledger insurance account named by those recipes. Top-up is `futuresInsuranceTopup`. Shortfall draw is `futuresRealizeLoss({ fromInsurance })`. `svc-trade` does not hold the balance.**
>
> **Refuse is `trade.insurance_fund_empty`. Paper and non-active rows may exist. Modelling is not listing. Target size is owner law and is not this ADR.**

This is settled. Agents do not invent a capitalisation number to “finish” futures.

---

## Why this ADR exists

DIRECTION §1 already said empty fund → no list. Tip already enforces it (`checkInsuranceFundedForListing`). What was missing was the **owner seal** so a craft PR cannot close D26-P0-17 by writing `$10_000_000` into source, or by treating `houseFees` as cover (the risk ADR already forbids that substitute).

P0-17’s done bar is **this document**: fund exists, is funded via a named recipe, empty means no list. It is **not** an owner table of target size. That remains open (D4 / DIRECTION §8).

---

## What is sealed

1. **Existence.** The insurance fund is a ledger account (`insuranceFund` / `house:insurance-fund:available` for the quote asset), not a comment, not a `svc-trade` table, not a Java wallet.

2. **Funded, for listing.** Production `kind=futures` + `status=active` + `paper=false` requires `available > 0` on that account. The listing gate and the shortfall bound **must name the same pot** (`recipeInsuranceAccount`). Any positive amount satisfies the _list_ gate. It does **not** satisfy a target-size policy that does not exist yet.

3. **Recipe.** Capital enters the pot via `futuresInsuranceTopup` (from house trade fees). Shortfalls leave via `futuresRealizeLoss` with `fromInsurance` bounded by live balance (`insurance-bound.ts`). Do not invent a second top-up recipe or an inline post.

4. **Empty → no list.** Refuse code `trade.insurance_fund_empty`. Same honesty as lending reserve: a market that cannot absorb a named loss does not open for real money.

5. **House fees ≠ insurance.** Paying PnL from `houseFees` with no ceiling is not this pot. The futures risk ADR stands.

6. **Paper / pending stay honest.** Non-futures, paper, and non-active statuses skip the balance read. You may model a perp without capital. You may not take real-money risk against an empty pot.

---

## What remains owner-open (not inventable here)

- Target size, fee-share into the fund, and capitalisation _schedule_.
- Whether “positive” is enough for _launch_, or a later owner table raises the floor.
- ADL magnitudes (D5) — last-resort disclosure already has a product path; numbers stay §8.
- `TRADE_FUTURES_PROFIT_SOURCE` / N1 profit-source capitalisation (adjacent, not this row).

A later owner table may raise the list floor above zero. Until then, **do not** put a second constant in `insurance-listing-gate.ts` and call it policy.

---

## Refuse matrix (names on tip — do not rename)

| Situation                                           | Code                                                                                         |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Real-money futures list / enable-to-active, pot ≤ 0 | `trade.insurance_fund_empty`                                                                 |
| Real-money futures list, insurance path unset       | `trade.insurance_fund_empty` (same code — do not invent a second refuse or a house-fee read) |
| Shortfall larger than live pot                      | existing shortfall bound refuse (not a new list code)                                        |

---

## What agents may do without asking again

- Keep and deepen the listing gate and shortfall bound tests.
- Cite this ADR on any new futures list / enable path.
- After an operator funds the pot via `futuresInsuranceTopup`, allow production-active futures listing that already passes every other P0-06 gate — still no invent target size.

## What agents must not do

- Commit a target size, APR, or “1% of OI” into source or env defaults.
- Treat `houseFees` as the insurance fund.
- Hold insurance balance outside `ledger-client`.
- Mark `trade.futures` Done because this ADR landed.

---

## Addendum 2026-08-15 — existing recipes only; empty/unset named refuse

The 2026-08-13 seal stands. This addendum names three sentences that were implied and are now explicit, so a later craft PR cannot “finish” P0-17 by inventing a second top-up door or by reading `houseFees` at list time.

### List-gate sentence

**Real-money futures list (and enable-to-active) requires a funded insurance path posted through existing `ledger-client` recipes only; empty or unset insurance → named refuse `trade.insurance_fund_empty`; `houseFees` is not a substitute.**

### Existing recipes (facts on tip — not new magnitudes)

Capital into the pot is already `futuresInsuranceTopup` (`packages/ledger-client/src/recipes/index.ts`: seed/top-up from house trade fees; shortfalls draw via `futuresRealizeLoss({ fromInsurance })`). List-gate tests seed that path (`insurance-listing-gate.test.ts`: `deposit` → `futuresMarginLock` → `futuresRealizeLoss` with `fromInsurance: 0n` → `futuresInsuranceTopup`) and refuse active real-money futures when the MemoryLedger pot is empty (`trade.insurance_fund_empty`). T1d (`insurance-shortfall-balance.test.ts`, #1684) proves a funded shortfall moves the named insurance balance by exactly the shortfall using the same recipes (`deposit` → `futuresMarginLock` · `feeCharge` → `futuresInsuranceTopup`, then `futuresRealizeLoss({ fromInsurance })`). Test seeds are fixtures, not product law.

The writer now exists: the trade operator desk door `admin.insurance.topup` in `svc-trade` (`admin/insurance-topup.ts`; futures ADR 2026-10-20, slice 4) posts `futuresInsuranceTopup` with a second person's approval, and the live-path inventory lists it as live. Before that, the inventory recorded `futuresInsuranceTopup` as a **§13 socket for an ops/admin writer**, not as a missing recipe. Agents do **not** invent a second top-up recipe, an inline post, or insurance bps to close that socket.

### Empty vs unset vs owner-unset size

| State                                                               | List / enable-to-active (real-money futures)                                                                                                                 |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Pot never posted, or `available ≤ 0`                                | **Refuse** `trade.insurance_fund_empty`                                                                                                                      |
| Quote/pot identity missing so the insurance account cannot be named | **Refuse** the same code — do not invent an account, and do not read `houseFees('trade')` as cover                                                           |
| `presentInsuranceListingPolicy().targetSize === 'owner_unset'`      | **Not** a list refuse. Target size/schedule stay owner (D4 / DIRECTION §8). The list gate stays “any positive balance” until an owner table raises the floor |

### No house-fee substitute

The futures risk ADR already: a house account is not an insurance fund and a fee balance is not a risk budget. `futuresInsuranceTopup` may _move_ value from `houseFees('trade')` into `insuranceFund` — that is the existing recipe. Listing against the fee pot itself, or treating fee-pot depth as “funded insurance,” is the substitute this row forbids.

This addendum does not edit `svc-trade` (including #1946 / futures lanes). Proof remains the files already on tip.

## Proof on tip (already; this ADR does not dual-edit trade)

- List gate: `services/svc-trade/src/futures/insurance-listing-gate.ts` + `insurance-listing-gate.test.ts`
- Shortfall bound: `services/svc-trade/src/futures/insurance-bound.ts`
- T1d balance fact: `services/svc-trade/src/futures/insurance-shortfall-balance.test.ts`
- Recipe: `packages/ledger-client` `futuresInsuranceTopup` / `futuresRealizeLoss`
- Listing policy adjacency: D26-P0-06 ADR
