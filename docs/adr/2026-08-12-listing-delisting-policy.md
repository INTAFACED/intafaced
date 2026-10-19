# ADR: listing / delisting policy — what may list, and the refuse path

**Status:** **Accepted — 2026-08-12 (structural gates).** Blank-policy fail-closed is **Accepted 2026-08-15** in [`2026-08-15-listing-policy-refuse-blank.md`](2026-08-15-listing-policy-refuse-blank.md) (`trade.listing_policy_unset`; blank ≠ default allow).  
**Decision owner:** repo owner (Denon). **Written by:** Denon.  
**Board:** D26-P0-06 — Listing / delisting policy (DIRECTION §8 item 5; board label “§8.5”).  
**Builds on:** `DIRECTION-2026-07-31.md` (removed) §2 (instrument listing rule) and §8 item 5 (agents must not decide which assets list); [`2026-08-04-market-id-authority.md`](2026-08-04-market-id-authority.md); [`2026-08-04-instrument-enum-authority.md`](2026-08-04-instrument-enum-authority.md).  
**Does not invent:** the catalogue of symbols, tick/lot tables, fee bps, leverage caps, insurance target size, or settlement fixing content — those stay owner law (DIRECTION §8 and adjacent P0 rows).

---

## The decision

> **`trade.markets` is the only listing registry. A market may become production-tradable (`status=active` and `paper=false`) only when every structural listing gate for its kind and asset class passes. Agents never invent which symbols list. Delisting and halt are status transitions that stop new risk; they do not confiscate open holds.**
>
> **Refuse is the answer when a gate fails — never a silent list, never a throw that becomes a 500, never a default that softens into permission.**

This is settled. Agents and engineers implement against it; they do not re-litigate the catalogue.

---

## Why this ADR exists

DIRECTION §8 reserves “which assets list, and delisting” to the owner. Tip already enforces structural refuse gates inside `svc-trade` (`listMarket`, `setMarketStatus`, `assertTradable`, options terms, insurance fund). What was missing was a single written policy that:

1. states **what may list** (conditions), without inventing **which** markets list;
2. names the **refuse path** (codes + call sites) so agents stop “just listing” around the gates;
3. seals **delist / halt** behaviour so operator freeze is not mistaken for confiscation.

Done bar for D26-P0-06: this document. Code hooks on tip already implement the refuse path; this ADR does not dual-edit open trade PRs to restate them.

---

## Authority split

| Question                                        | Authority                                                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Is market id / symbol listed at all?            | `trade.markets` only — market-id ADR                                                              |
| **Which symbols / assets enter the catalogue?** | **Owner** (DIRECTION §8 item 5). Agents do not mint production listings as product judgment.      |
| Structural eligibility of a proposed listing    | This ADR + existing `listMarket` / `setMarketStatus` gates                                        |
| Schedule / asset_class / settlement honesty     | Instrument-enum ADR + DIRECTION §2                                                                |
| Insurance capitalisation size / schedule        | Owner (D26-P0-17); tip gate only requires **positive** fund balance for real-money futures active |
| Options settlement fixing content               | Owner (D7 / D26-P0-05 adjacency); tip requires non-empty config string before options list        |
| Fee bps / revenue recipes on a listing          | Owner (DIRECTION §8 items 6 / rates) — not invented in listing code                               |

**Modelling ≠ listing.** An instrument may exist in the model, appear as `paper=true`, or sit at `pending` / `halted`, and still be absent from every production user-facing trade path. That is honest. **Production-active without settlement, insurance, or terms is the lie.**

---

## What may list (structural policy)

A row may be inserted or enabled toward production trading only when **all** applicable rows pass. Passing these gates is necessary, not sufficient — the owner still chooses the catalogue.

### Universal

1. **Registry home** — listing writes go through `svc-trade` into `trade.markets`. No other service invents a listed market.
2. **Tick × lot ≥ 1 wei** — a legal fill cannot have zero quote amount (DB + list path).
3. **Known schedule** — schedule name must exist in `TRADING_SCHEDULES` (instrument-enum ADR). Unknown schedule refuses orders; do not list a venue whose hours cannot be evaluated.
4. **Status vocabulary** — `pending` \| `active` \| `halted` \| `delisted` only.

### By asset class / kind (tip refuse)

| Situation                                            | May production-list (`active` + not paper)? | Honest alternatives                         | Refuse code (tip)                       |
| ---------------------------------------------------- | ------------------------------------------- | ------------------------------------------- | --------------------------------------- |
| Crypto spot with settleable rails already in product | Yes, when owner catalogues it               | —                                           | —                                       |
| Forex / commodity                                    | **No** until fiat settlement rails exist    | `paper=true`, or `pending` / `halted` model | `trade.unsettled_asset_class_listing`   |
| Futures (`kind=futures`) real-money                  | **No** while insurance fund balance ≤ 0     | paper / non-active model rows               | `trade.insurance_fund_empty`            |
| Options (`kind=options`)                             | **No** while settlement fixing unset        | —                                           | `trade.options_fixing_unconfigured`     |
| Options with incomplete / misattached contract terms | **No**                                      | —                                           | `trade.options_terms_incomplete`        |
| Any kind with `status` ≠ `active`                    | Not tradable (may exist as model)           | pending / halted / delisted                 | order path: `trade.market_not_tradable` |
| Futures when `TRADE_FUTURES_ENABLED` is off          | Row may exist; orders refuse                | —                                           | `trade.futures_disabled`                |
| Non-spot on spot-only surfaces (convert / TWAP)      | N/A — surface refuse                        | —                                           | `trade.market_kind_unsupported`         |

**Agents do not add symbols to close a tracker mountain.** If a mountain needs a market that is not owner-catalogued, the work stops at model/paper/pending or a written owner request — it does not invent a production list.

---

## Refuse path (call sites on tip)

Ordered the way a listing attempt fails closed:

1. **`TradeService.listMarket`** (`services/svc-trade/src/spot/trade-service.ts`)
   - Forex/commodity + `active` + not paper → `trade.unsettled_asset_class_listing`
   - Futures + `active` + not paper + empty insurance → `trade.insurance_fund_empty` via `checkInsuranceFundedForListing`
   - Options → `resolveOptionsListing` (`options-listing.ts`) → fixing / terms codes above
2. **`TradeService.setMarketStatus`**
   - Enable-to-`active` re-runs the insurance gate (same DIRECTION:33 rule as list). Halt / delist / pending do not require a funded pot.
3. **Order / convert / TWAP path**
   - `assertTradable` — non-`active` → `trade.market_not_tradable`; kind / futures flag as above
   - `assertSettlementRails` — seeded FX majors that slipped past list as active non-paper still refuse holds with `trade.unsettled_asset_class_listing`
   - `assertMarketOpen` — closed venue hours refuse (separate from listing status)
4. **Wire** — CCXT / REST map these codes to honest client errors (`ccxt-errors.ts`); never coerce unknown market to a fabricated book.

**Failure direction:** refuse and name the precondition. Do not throw a bare Error that surfaces as 500. Do not default `status` or `paper` to make an illegal list succeed.

---

## Delisting and halt

| Transition                      | Meaning                                                                                                     | Open orders / holds                                                |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `active` → `halted`             | Operator freeze: **no new risk**                                                                            | Leave open; holds stay; cancels remain available so users can exit |
| `*` → `delisted`                | Removed from the production catalogue; not accepting orders                                                 | Same non-confiscation rule as halt — delist is not a ledger wipe   |
| `*` → `pending`                 | Model / not launched                                                                                        | Not tradable                                                       |
| `halted` / `pending` → `active` | Re-enable — **must pass the same structural gates as a fresh list** (insurance, settlement class, options…) | —                                                                  |

Delisting does **not** invent a second registry. Other services keep reading `trade.markets` (market-id ADR). A delisted id is still a known id that refuses trades; it is not silently rewritten into “never existed” for owners/admins who are entitled to see it. Strangers asking by guess follow the authority/refusal-shape ADR (`NOT_FOUND` where entitlement is absent).

---

## What agents may do without asking

- Wire new call sites through the existing gates (`listMarket` / `setMarketStatus` / `assertTradable` / settlement / options / insurance).
- Add tests that prove refuse codes stay fail-closed.
- Model instruments and paper markets for academy / drills.
- Document residuals when a mountain is blocked on owner catalogue choice.

## What remains owner-only (do not invent)

- The set of symbols that appear in production.
- Fiat settlement rail go-live that would unlock forex/commodity production list (ties D26-P0-05).
- Insurance fund **target size / schedule** (ties D26-P0-17) — tip only requires positive balance.
- Options settlement fixing **content** (source/window/payor).
- Fee bps, leverage above §1 defaults, sanctions list content, “audited/insured/guaranteed” copy.

---

## Explicit non-goals

- This ADR does **not** choose BTC/USDT vs any other pair.
- This ADR does **not** close D26-P0-05, D26-P0-10 (market.commerce commission), or D26-P0-17 by itself — it points at their refuse edges.
- This ADR does **not** require a code PR while open trade PRs (#1700 / #1710 / #1716 / #1717) already touch listing-adjacent files; tip hooks are sufficient for the seal.

---

## Housekeeping

When settlement rails, fixing law, or insurance capitalisation are later sealed, update the refuse table rows in this ADR (or supersede by a dated successor) — do not leave tip gates and this table disagreeing.
