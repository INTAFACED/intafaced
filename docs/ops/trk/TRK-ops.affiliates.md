# TRK-ops.affiliates — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `ops.affiliates`  
**Title:** Multi-tier affiliate / IB trees, payout automation  
**Module / phase:** `core-ops` · phase 5 · plane F  
**Status on tip:** ready · **owner:** none  
**Depends on:** `ledger.double-entry` (done)  
**Requires:** future core-ops / affiliates module — **no monorepo service**  
**Tip freeze:** `origin/main` @ `04f9b1f2` (re-derive before implement)  
**Pack type:** research only — no implement swarm; no money invention; **no** `features.mjs` edit from this pack.

---

## 1 · What “done” means (plain language)

1. Multi-tier **affiliate / IB trees** are configurable; referral attribution is durable and not rewritable by the referred user alone.
2. Commission **payouts automate via ledger recipes** — never balances stored in an affiliates table as money.
3. Trees and rates are operator-visible; self-dealing and cycle edges refused.
4. Payout windows are idempotent; partial failure does not double-pay.
5. User copy never promises rates that config does not hold.

---

## 2 · Current code state (tip)

### 2.1 Greenfield + vendor shape-found

| Fact                        | Tip                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------- |
| Monorepo affiliates service | **None**                                                                              |
| Ledger                      | double-entry **done** — recipes can be added                                          |
| Vendored                    | Promotion/invite controllers exist in vendor admin — **not** SoT; port only with plan |
| Money class                 | **Class M** when payouts ship                                                         |

Research must not invent commission economics.

---

## 3 · Doctrine constraints

| Law      | Implication                                       |
| -------- | ------------------------------------------------- |
| §8.8 ops | Affiliate/IB trees + payout automation via ledger |
| §0.6     | No module-held balances                           |
| Class M  | Money self-audit + adversarial pass               |
| Brand    | No partner IB platform names                      |

---

## 4 · DoD sketch (checkable — staged)

### Stage 1 — attribution graph

- [ ] Referral codes + tree edges + cycle refuse
- [ ] No money

### Stage 2 — commission config

- [ ] Tier rates in config; operator UI read path

### Stage 3 — payout automation

- [ ] ledger-client recipe + job + idempotency
- [ ] Class M tests

**Tracker `done`:** Stage 3 with real payout path — not graph alone.

---

## 5 · Open questions

1. Max tier depth and rates — product law?
2. What events earn commission (trade fees, deposits)?
3. KYC gate on payout?

---

## 6 · Estimated size

| Slice               | Size            | Notes |
| ------------------- | --------------- | ----- |
| Attribution graph   | **M**           |       |
| Payout recipe + job | **M–L** Class M | Money |
| Full IB product     | **XL**          |       |

**First implement PR:** **M** attribution only — **no** payout money in first PR.

**Human blockers:** Product law; Class M; Service.

---

## 7 · Related docs / code

- Doctrine §8.8
- packages/ledger-client recipes pattern
- VENDORED-OVERLAP promotions

---

## 8 · Explicit non-goals for this pack

- No invent payout amounts.
- No balances in affiliates tables.
- No silent vendor port of promotion SQL.
- No features.mjs done.
