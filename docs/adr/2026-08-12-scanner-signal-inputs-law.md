# ADR: scanner signal inputs — what may rank; refuse when inputs are missing

**Status:** **Accepted — 2026-08-15 (D26-P0-11 sealed; #1733 production recipe withdrawn).**
**Decision owner:** repo owner (Denon). **Written by:** Denon.
**Board:** D26-P0-11 · tracker `agents.scanner` · D26-P1-A3 honour this seal; do not invent a second ranker.
**Binds:** D-S-18 ([`2026-08-04-predict-quant-connect-law.md`](2026-08-04-predict-quant-connect-law.md)) honesty — absent is named, never empty-as-quiet; **no returns-ranked board** in any room (§8 + D-S-18). Packet: `OWNER-DECISION-PACKET-PART-TWO-2026-08-09.md` (removed) §P0-11.
**Law:** market honesty (no fabricated last/volume/change) · brand §0.7 · agents never invent alpha or signal sources.

---

## Correction (why this seal is empty)

The 2026-08-12 text that landed as #1733 named a production ranking recipe (`abs_change_x_log_volume`) and a non-empty allow-list (`last`, `volume24h`, `change24hBps`). That **is product invention**: which fields rank, and the score formula, were not owner-named inputs — they were copied from a Stage-1 fixture.

D26-P0-11’s done bar is: **allow-list of input kinds, or empty allow-list = refuse all ranks**; missing/untrusted → **named refuse**; **no returns-ranked board**. This revision seals that bar. It does **not** invent live venue feeds, kinds, formulas, tier matrices, or UI.

The Stage-1 fixture recipe in `services/svc-agents` remains a **test-only** ranker. It is **not** production law. This ADR does not edit that service (A3 / scanner wip).

---

## The decision

> **A ranked scanner signal may only be produced from a published input allow-list. The published production allow-list is empty. Empty allow-list → refuse every rank. Missing or untrusted inputs → named refuse. Never invent kinds, never invent a ranking recipe, never returns-rank, never zero-fill.**

This is settled. Agents and engineers implement it; they do not re-litigate it or populate the allow-list without a later owner seal that names kinds.

---

## Production allow-list (sealed)

| Field                               | Production value                                                                                                                                                  |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Published allow-list of input kinds | **empty**                                                                                                                                                         |
| Published ranking recipe            | **none**                                                                                                                                                          |
| Effect                              | **Refuse all ranks** (`inputs_empty` when the sealed object is published with an empty list; `signal_inputs_law_blank` while the law object is still unpublished) |

Kinds not on the published allow-list **must not** enter a rank. There are **no** kinds on the published list.

Agents **must not** add kinds (`last`, `volume24h`, `change24hBps`, `spread`, `funding`, `sentiment`, `social`, `ai_score`, partner-model scores, or any other name) under this seal. A later owner ruling may add kinds **by name**. Until then, TypeScript unions and fixture recipes in A3 are **vocabulary for refuse tests**, not permission to score.

---

## Refuse matrix (fail closed)

| Situation                                                                                                     | Named refuse / answer                                                        |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Law unpublished / blank / not `p0_11: sealed`                                                                 | **`signal_inputs_law_blank`** — no invent rankings                           |
| Sealed allow-list empty (this production seal)                                                                | **`inputs_empty`** — refuse all ranks                                        |
| Unknown `rankingRecipeId`                                                                                     | **`ranking_recipe_unknown`** — do not guess a formula                        |
| Sealed recipe missing a required input on the allow-list                                                      | **`required_inputs_missing`**                                                |
| Input present but **untrusted** (stale, synthetic, caller-supplied, partner-named, dark plane, unproven feed) | **`inputs_untrusted`** — named refuse; never rank on it                      |
| Per-row required field null / unparseable                                                                     | **Omit that row**; if none remain → typed empty / unavailable — never invent |
| Request for a returns-ranked / PnL-ranked / “hot alpha” board                                                 | **Refuse** — D-S-18 / §8; scanner is not a returns leaderboard               |

Wire copy key for law-level refuse: `agents.scanner.signal_inputs_closed` (brand-safe; no vendor names). Residual string stays greppable as `D26-P0-11_refuse_closed`.

A3’s existing gate already covers the first four reasons. **`inputs_untrusted` is law**; implementers map it on the next scanner PR — this docs seal does not patch `services/svc-agents`.

---

## What agents may implement without asking again

- Honour this seal: production ranked paths stay refuse-closed while the allow-list is empty.
- Typed refuse / omit for incomplete, stale, or untrusted rows.
- Tests that pin empty allow-list → no ranks.
- Do **not** flip production law to a non-empty allow-list or to `abs_change_x_log_volume` without a later owner ADR.

## What remains open (not this seal)

- Which input kinds (if any) the owner later names onto the allow-list.
- Which ranking recipe (if any) is later named.
- Live allowlisted spot tickers / Class X venue data.
- External venue quotes vs internal book (tracker pack Q3).
- Tier depth matrix (how many rows free vs staked).
- Shell / UI scanner surface.

Those stay **open**. This seal answers “what may rank today”: **nothing**.

---

## Done bar (D26-P0-11)

1. This ADR is **Accepted** with a published **empty** allow-list (refuse all ranks).
2. Missing / untrusted inputs have **named** refuses (table above).
3. **No returns-ranked board** — D-S-18 / §8 bind the scanner the same as copy and quant.
4. No invented signal sources or ranking formulas as production law.
5. Tracker `agents.scanner` stays not-Done until a later owner names kinds **and** a live data path is honest — law seal ≠ product-complete.

---

## Explicit non-goals

- No second money book, no SPA rebuild, no invented mids/depth.
- No auto-trade from scanner.
- No Shehzad chain work under this id.
- No `features.mjs` Done flip from this ADR alone.
- No edit of `services/svc-agents` in the P0-11 docs PR.
