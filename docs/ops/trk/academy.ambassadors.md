# TRK-academy.ambassadors — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `academy.ambassadors`  
**Title:** Residencies, IFC pay, revenue share  
**Module / phase:** `academy` · phase **5**  
**Status on tip:** `ready` · **owner:** none  
**Depends on:** `academy.lobbies` (**done**) · `token.staking` (**done**)  
**Tip freeze:** `origin/main` @ `083ef879` (re-derive before implement)  
**Pack type:** research only — no implement swarm; no money invention; no dual-edit Denon open money PRs; no `features.mjs` edit.

---

## 1 · What “done” means (plain language)

1. **Ambassador / residency** programme: named hosts with elevated rights and obligations.
2. **IFC pay** and/or **revenue share** settle via ledger recipes — not academy-held balances.
3. Host rights stay consistent with identity perks (`lobbyHostRights`) — programme layers, does not bypass rank law.
4. Operators can appoint/freeze ambassadors with audit.
5. No double-pay with `ops.affiliates` or tournament prizes without exclusion rules.

---

## 2 · Current code state (tip)

### 2.1 Host rights (related, not programme)

| Area             | Reality                                                       |
| ---------------- | ------------------------------------------------------------- |
| Host gate        | `host-rights.ts` / `mayHost` — identity `lobbyHostRights`     |
| Access           | Hosts bypass stake gate for their rooms (`room-access.ts`)    |
| Programme entity | **No** residency application / IFC payroll product            |
| Pay              | Explicitly **not built** (moves value → needs ledger recipes) |

### 2.2 Dependencies

| Dep               | Status                                        |
| ----------------- | --------------------------------------------- |
| `academy.lobbies` | done — rooms, seats, scene, host              |
| `token.staking`   | done — stake tiers for access gating patterns |

### 2.3 Naming

“Ambassador” in access comments is role narrative — not a paid programme implementation.

---

## 3 · Doctrine constraints

| Law            | Implication                                                 |
| -------------- | ----------------------------------------------------------- |
| §0.6           | Pay/revenue share via recipes only                          |
| Class M        | Payroll automation audited                                  |
| Rank/perks SoT | identity — don’t hardcode host bypass that contradicts rank |
| Brand          | Residency copy vendor-clean                                 |
| Double-pay     | Coordinate affiliates/tournaments                           |
| No dual-edit   | Open token/identity/academy PRs                             |

---

## 4 · DoD sketch (checkable — staged)

### Stage 1 — programme without pay

- [ ] Ambassador/residency status model + admin appoint/freeze.
- [ ] Public badge / host label (i18n).
- [ ] Rights matrix vs lobbyHostRights documented.

### Stage 2 — IFC pay Class M

- [ ] Pay schedule product law.
- [ ] Recipes + idempotent job; dry-run.
- [ ] Revenue share definition (of which fees?).

### Stage 3 — residencies product

- [ ] Season/residency windows; deliverables; KPIs.

### Tracker `done` bar

Flip only when residencies **and** pay/share (or product-cut pay) match title — host rights alone are lobbies.

---

## 5 · Open questions

1. Pay basis (per session, per seat, revenue %)?
2. Staking requirement for ambassadors?
3. Overlap with affiliates IB trees?
4. Tax/reporting?

---

## 6 · Gaps (named)

1. No programme entity.
2. No IFC payroll.
3. No revenue share accounting.
4. No admin appoint UI.
5. Double-pay matrix residual.

---

## 7 · Risks

| Risk                    | Why it hurts       |
| ----------------------- | ------------------ |
| Shadow academy balances | Dual book          |
| Pay without freeze      | Fraud              |
| Bypass rank host law    | Perk inconsistency |
| Double-pay              | Margin leak        |

---

## 8 · Estimated size

| Slice                  | Size          |
| ---------------------- | ------------- |
| Programme status only  | **M**         |
| IFC pay automation     | **L** Class M |
| Full residency seasons | **L**         |

**First implement PR (when free):** **M** — status + admin freeze; pay later Class M.

---

## 9 · Related docs / code

- `services/svc-academy/src/host-rights.ts`, `access/room-access.ts`
- `services/svc-token` staking
- `ops.affiliates` pack (collision)
- academy-service comments on ambassador pay

---

## 10 · Explicit non-goals for this pack

- No inventing IFC credits in academy tables.
- No weakening host rank gates.
- No `features.mjs` edit.
