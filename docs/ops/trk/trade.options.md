# TRK-trade.options — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `trade.options`  
**Title:** European options, cash-settled, full collateral in v1  
**Module / phase:** `trade`  
**Status on tip:** free / not started product — instrument enum only  
**Tip freeze:** re-derive `origin/main` (pack prose re-verified 2026-08-09 against harvest)  
**Pack type:** research only — **babysit implement**; no invent greeks or marks.

---

## 1 · What “done” means (plain language)

1. European, cash-settled options with **full collateral v1** as titled.
2. Listing uses existing `market_kind` enum support without half-wired risk.
3. Risk/margin law exists and is enforced — not spot engine with an options label.
4. Settlement marks honest or refuse — no invent IV surface for PnL.

---

## 2 · Current code state (tip)

### 2.1 Enum vs product

| Piece                            | Reality                                             |
| -------------------------------- | --------------------------------------------------- |
| `market_kind` includes `options` | Listing later is data + risk, not only enum         |
| svc-trade README                 | Options listed as separate feature from spot        |
| Full options engine              | **Not** shipped as titled product                   |
| Collateral model                 | Title requires full collateral v1 — design residual |

### 2.2 Hard blockers (honest — 2026-08-09)

| Blocker                         | Why                                                                                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Settlement fixing (D7)**      | Owner decision: which price source, window, expiry time, which funded account pays ITM holders — **the real gate**                       |
| Mark integrity                  | Same no-invent law as venue marks                                                                                                        |
| ~~Shehzad M3~~                  | **Dead as a block** — M3 reclaimed 2026-08-04; agents implement futures residual under tip product law, not "wait for Shehzad risk path" |
| ~~Denon multi-asset law blank~~ | **Delivered as D-S-05** / instrument-enum ADR — model exists; does **not** free options settlement                                       |

### 2.3 Partner path caution

Options craft still path-checks matching/trade heavily — re-derive open PRs before dual-edit. #433 matching is **merged** (not a live hold).

---

## 3 · Doctrine constraints

| Law                | Implication                          |
| ------------------ | ------------------------------------ |
| Full collateral v1 | No naked invent margin               |
| Ledger             | Premium/settlement via recipes       |
| Human M3           | No agent freestyle risk engine       |
| No invent greeks   | UI shows absence rather than fake IV |

---

## 4 · DoD sketch (when unblocked)

- [ ] Product law ADR from Denon
- [ ] Risk engine accepts options positions under full collateral
- [ ] Cash settlement path + tests
- [ ] Market hours / expiry schedule refuse cases

---

## 5 · Open questions

1. Underlyings: only crypto index first?
2. Who owns options risk code path vs futures M3?
3. Oracle/mark source for settlement?

---

## 6 · Estimated size

| Spec/ADR only | **S** |
| Full product after law | **XL** |

---

## 7 · Related docs / code

- `services/svc-trade/README.md` feature table
- Shehzad hard board / Denon hard task board
- Long-form twin: [TRK-trade.options.md](./TRK-trade.options.md)

---

## 8 · Explicit non-goals

- No invent settlement fixing or greeks while D7 is open.
- No invent options chain UI.
- No features.mjs done flip from research.

---

## 9 · Why agents do not freestyle options product

| Gate            | Role                                             |
| --------------- | ------------------------------------------------ |
| D7 settlement   | Owner-only price source / window / payer account |
| Full collateral | Title requires it — no naked invent margin       |
| Nitro Class X   | Any production go-live of risk                   |

Research packs must not become shadow ADRs that force product law. Shehzad M3 is **not** the blocker anymore.

## 10 · Pre-implement gate

- [ ] Owner settlement fixing (D7) written
- [ ] Path intersect clean vs open money/matching PRs (re-derive; #433 is merged)
- [ ] Full collateral model written with ledger recipes
- [ ] Mark/oracle law for settlement

## 11 · Explicit wait state

Until gates pass: **no** options UI, **no** invent IV boards, **no** features.mjs status flip.

## 12 · One-line residual

Blocked on **options settlement fixing (D7)** — not on Shehzad M3 (reclaimed) or blank multi-asset law (D-S-05 delivered); no invent greeks.
