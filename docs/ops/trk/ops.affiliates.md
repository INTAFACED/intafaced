# TRK-ops.affiliates — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `ops.affiliates`  
**Title:** Multi-tier affiliate / IB trees, payout automation  
**Module / phase:** `core-ops` · phase **5**  
**Status on tip:** `ready` · **owner:** none  
**Tip freeze:** `origin/main` @ `56696496` (re-derive before implement)  
**Pack type:** research only — no invent commission rates; payouts via ledger only.

---

## 1 · What “done” means (plain language)

1. Multi-tier **affiliate / IB** tree can be stored and queried (who introduced whom).
2. Commission rules are **published** and computed from real trade/fee events — not a dashboard invent.
3. Payout automation posts through **ledger recipes** (or refuses with clear residual).
4. Operator can freeze a tree node without silent money creation.
5. Vendor shell invite/referral UI does not show fabricated leaderboard as live (honesty already on shell).

---

## 2 · Current code state (tip)

### 2.1 Service inventory

| Area                       | Reality                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Dedicated `svc-affiliates` | **Absent**                                                                                                    |
| Services present           | identity, trade, ledger, notify, p2p, edge, … — no affiliate module                                           |
| Vendor shell               | Invite pages historically had fabricated leaderboard rows — honesty comments only; do not re-introduce invent |
| Tracker                    | `ops.affiliates` ready, multi-tier + payout automation title                                                  |

### 2.2 What “almost related” is not this row

- P2P reputation badges ≠ IB tree.
- Academy ambassadors ≠ fee-share IB.
- Notify can deliver payout notices later — not the accounting.

### 2.3 Money path residual

Any commission is **fee share of real volume**. Without fee events + ledger recipe, automation is theatre.

---

## 3 · Doctrine constraints

| Law                | Implication                                    |
| ------------------ | ---------------------------------------------- |
| Ledger only        | Commission payouts via `ledger-client` recipes |
| No invented volume | Attribute only to verified fills/fees          |
| Brand              | No partner names in user copy                  |
| Class X            | Marketing jurisdiction claims if any           |

---

## 4 · DoD sketch (checkable — staged)

### Slice A — tree + attribution

- [x] Referral edge write on signup (identity) with audit
- [x] Multi-tier depth limit law
- [x] Cycle / self-referral rejection tests
- [x] Admin tree board + node status read (`admin:read`) — Stage spine 2026-08-07
- [x] Admin member listing + freeze/unfreeze honestyLine — Stage-2 2026-08-07
- [x] Payout path refuse-closed until DIRECTION §8 rates + ledger recipe (Class M)

### Slice B — accrual

- [ ] Fee event → commission accrual rows (decimal strings)
- [ ] Tests: zero volume → zero commission (no invent)

### Slice C — payout automation

- [ ] Recipe + operator freeze
- [ ] Notify optional
- [ ] **Blocked:** owner-published fee-share rates (DIRECTION §8) — agents must not invent

### Tracker `done` bar

Title multi-tier + automated payout true with ledger honesty.

---

## 5 · Open questions

1. Own service vs package inside identity/trade?
2. IB vs retail affiliate same tree?
3. Retroactive attribution policy?

---

## 6 · Estimated size

| Slice                    | Size    |
| ------------------------ | ------- |
| Tree + attribution       | **M**   |
| Accrual + payout recipes | **M–L** |

---

## 7 · Related docs / code

- Tracker row `ops.affiliates`
- Shell invite honesty: `vendor/.../Invite.vue` comments (no re-invent)
- Long-form twin: [TRK-ops.affiliates.md](./TRK-ops.affiliates.md)

---

## 8 · Explicit non-goals

- No fabricated referral leaderboards.
- No commission `%` hardcoded into UI without fee events.
- No features.mjs flip from this pack.

---

## 9 · Event sources (when wired)

| Event            | Likely producer        | Use             |
| ---------------- | ---------------------- | --------------- |
| User referred    | `svc-identity` signup  | Tree edge       |
| Fee accrued      | trade/ledger fee posts | Commission base |
| Payout completed | ledger recipe          | Clear unpaid    |

Do not invent a parallel “affiliate ledger.” Accrual tables may exist but settlement posts through `ledger-client`.

## 10 · First PR shape

| PR  | Scope                                       |
| --- | ------------------------------------------- |
| 1   | Referral edge + cycle detection tests       |
| 2   | Accrual from fee fixtures (decimal strings) |
| 3   | Payout recipe + freeze                      |

Shell invite UI must keep fabricated leaderboard **removed** (honesty comments only).
