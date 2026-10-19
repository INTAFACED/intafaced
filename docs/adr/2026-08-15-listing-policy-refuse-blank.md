# ADR: listing policy blank is refuse — not default allow (D26-P0-06)

**Status:** **Accepted — 2026-08-15 (D26-P0-06 sealed).**  
**Amends:** [`2026-08-12-listing-delisting-policy.md`](2026-08-12-listing-delisting-policy.md) (structural gates + halt/delist non-confiscation stay).  
**Decision owner:** repo owner (Denon). **Written by:** Denon.  
**Board:** D26-P0-06 — Listing / delisting policy (DIRECTION §8 item 5; board label “§8.5”).  
**Packet:** `OWNER-DECISION-PACKET-PART-TWO-2026-08-09.md` (removed) P0-06.  
**Does not invent:** the live instrument set, settlement asset, or refuse matrix for options/forex (**D26-P0-05**). Does not list coins, tick/lot, fee bps, or insurance target size.

---

## The decision

> **Who may list is the owner, not an agent.** DIRECTION §8 item 5 reserves which assets list, and delisting, to the owner. An operator `listMarket` form is not a licence to catalogue.
>
> **Blank listing policy = no list.** Absence of an owner-published listing policy is **refuse**, never default-allow. Structural eligibility on tip (insurance, unsettled asset class, options law/fixing/terms) is necessary and not sufficient.
>
> **Named refuse code:** `trade.listing_policy_unset`.

This closes the packet question. Agents implement the refuse; they do not publish the catalogue.

---

## Why #1731 was not enough

[#1731](https://github.com/Phantom-X-007/intafaced/pull/1731) wrote structural what-may-list gates and mapped existing `listMarket` refuse codes. The packet’s remaining sentence was explicit: blank policy must not read as permission. The 2026-08-12 table left crypto spot production-listable when those structural gates pass and someone calls the form. That is default-allow. P0-06’s recommendation forbids it.

---

## What may list (policy, not catalogue)

A market may become production-tradable (`status=active` and `paper=false`) only when **all** of the following are true:

1. **Owner listing policy is published and non-blank.** Until then, every new production list refuses `trade.listing_policy_unset`. Paper / pending / halted model rows are not a production catalogue.
2. **The owner chose the symbol.** Agents do not mint production listings to close a tracker mountain.
3. **Structural gates on tip still pass** (cite only — do not re-implement in this ADR):
   - Forex / commodity production: `trade.unsettled_asset_class_listing` (`listMarket` / `assertSettlementRails`)
   - Real-money futures while insurance fund empty: `trade.insurance_fund_empty` (`checkInsuranceFundedForListing`)
   - Options while P0-05 law stamp empty: `trade.options_settlement_law_unset`
   - Options while fixing unset: `trade.options_fixing_unconfigured`
   - Options incomplete terms: `trade.options_terms_incomplete`

**What may list** is therefore: only owner-catalogued instruments that also clear those gates. This ADR names the rule. It does **not** name BTC, USDT, EUR, or any other asset. That set is owner publish (spot/crypto catalogue) or **D26-P0-05** (options/forex live set + settlement asset + refuse matrix).

---

## Who may list

| Actor                           | May production-list?                                                                                             |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Owner (Denon / DIRECTION §8.5)  | Yes, by publishing listing policy and choosing the catalogue.                                                    |
| Operator executing owner policy | Yes, through `TradeService.listMarket` **after** the policy stamp is non-blank and structural gates pass.        |
| Agent / engineer                | **No.** May wire refuse, tests, paper/pending models. Must not invent symbols or treat an empty policy as allow. |

`listMarket` remains operator-only (no user-facing path). Operator-only is not owner-published policy.

---

## What delists

Delist criteria are owner law, same reservation as listing. Until the owner publishes delist rules:

- **Halt** (`active` → `halted`) remains the operator emergency: stop new risk; open orders and holds stay; cancels remain so users can exit (2026-08-12 ADR).
- **Delist** (`*` → `delisted`) is a catalogue removal, not a ledger wipe. Agents do not invent delist schedules, auto-delist on volume, or silent registry deletes.
- Re-enable to `active` must pass **this** blank-policy refuse **and** the structural gates.

---

## Refuse path when policy is blank

| Precondition                      | Code                             | Call site (wire later; this PR is law only)     |
| --------------------------------- | -------------------------------- | ----------------------------------------------- |
| Owner listing policy stamp empty  | **`trade.listing_policy_unset`** | First gate on `listMarket` and enable-to-active |
| Existing structural refuses (tip) | cited above                      | already in `svc-trade` `listMarket`             |

Same honesty as empty options law and empty insurance: empty is a refusal, not a crash, not a 500, not permission. Engineering may later bind an opaque env stamp (presence-only, never parsed for a coin list in this ADR). This document does not add that env or edit `svc-trade`.

---

## Explicit non-goals

- Do not invent the live instrument set (D26-P0-05).
- Do not edit the P0-05 settlement ADR, P0-03 dex venue ADR, `svc-trade`, Vue, or Shehzad chain.
- Do not close D26-P0-10 (commerce commission) or D26-P0-17 (insurance target size) by this seal.
- Existing seed rows on tip are not re-catalogued here; this seal governs **new** production lists and enable-to-active while policy is blank.

---

## What agents may do after this seal

- Wire `trade.listing_policy_unset` on `listMarket` / enable-to-active when the owner stamp is empty (separate code PR; one service).
- Keep citing the existing refuse codes; do not bypass them because a form exists.
- Stop. Do not list coins.
