# TRK-p2p.merchants — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `p2p.merchants`  
**Title:** P2P merchant programme — badges, limits, API  
**Module / phase:** `p2p` · phase 3 · plane F  
**Status on tip:** ready · **owner:** none  
**Depends on:** `p2p.reputation` (done)  
**Requires:** `services/svc-p2p` extension — table not built  
**Tip freeze:** `origin/main` @ `04f9b1f2` (re-derive before implement)  
**Pack type:** research only — no implement swarm; no money invention; **no** `features.mjs` edit from this pack.

---

## 1 · What “done” means (plain language)

1. Merchants get **badges, limits, and API access** as a programme distinct from ordinary P2P users.
2. Limits and badges derive from **reputation + explicit programme rules**, not a fresh account borrowing merchant trust (reputation code already warns this).
3. `p2p_merchants` table (§6.2 fifth table) arrives with its **own migration** — no half-written table left behind.
4. Merchant API keys/scopes are revocable; actions still go through escrow/ledger doctrine.
5. Open Denon P2P money PRs (e.g. payment instruments) are not dual-edited for badges.

---

## 2 · Current code state (tip)

### 2.1 Reputation done; merchants table not

| Fact       | Tip                                                                                   |
| ---------- | ------------------------------------------------------------------------------------- |
| svc-p2p    | Offers, escrow, disputes, reputation on main                                          |
| README     | Explicit: `p2p_merchants` is tracker `p2p.merchants` and **not built**; no half table |
| Reputation | Guards against rendering zero-history as flawless merchant trust                      |
| Open PRs   | e.g. #428 payment instruments — path intersect before edit                            |

Clean extension point.

---

## 3 · Doctrine constraints

| Law          | Implication                                              |
| ------------ | -------------------------------------------------------- |
| §6.2         | p2p_merchants fifth table                                |
| Escrow/money | Still ledger + p2p recipes; merchants not a side balance |
| Reputation   | No trust borrow for fresh accounts                       |
| PR shape     | One service PR: svc-p2p only (reviewability, §15.1)      |

---

## 4 · DoD sketch (checkable — staged)

### Stage 1 — schema + apply

- [ ] p2p_merchants migration + apply/approve state machine

### Stage 2 — badges + limits

- [ ] Enforce limits on offer create
- [ ] Badge read on public profile

### Stage 3 — merchant API

- [ ] Scoped tokens; rate limits; audit

**Tracker `done`:** badges + limits enforced + API or explicit cut of API to later row.

---

## 5 · Open questions

1. Badge tiers and numeric limits — product law?
2. API required for v1 or UI-only merchants?
3. Stake requirement?

---

## 6 · Estimated size

| Slice                     | Size    | Notes   |
| ------------------------- | ------- | ------- |
| Migration + apply/approve | **S–M** | svc-p2p |
| Limits enforcement        | **M**   |         |
| Merchant API              | **M**   |         |

**First implement PR:** **S–M** migration + apply/approve only.

**Human blockers:** Product law; Open P2P PRs; Not blocked.

---

## 7 · Related docs / code

- `services/svc-p2p/README.md` merchants note
- p2p.reputation
- open P2P PRs — re-derive

---

## 8 · Explicit non-goals for this pack

- No half-written merchants table without migration product.
- No dual-edit #428-style money paths for badges.
- No invent reputation scores.
- No features.mjs done.
