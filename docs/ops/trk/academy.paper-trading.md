# TRK-academy.paper-trading — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `academy.paper-trading`  
**Title:** Paper-trading market flag for workbooks  
**Module / phase:** `academy` · phase **5**  
**Status on tip:** `ready` · **owner:** none  
**Depends on:** `trade.spot` (**done**)  
**Tip freeze:** `origin/main` @ `083ef879` (re-derive before implement)  
**Pack type:** research only — no implement swarm; no money invention; no dual-edit Denon open money PRs; no `features.mjs` edit.
**Flag owner:** trade service (not academy) — academy is consumer.

---

## 1 · What “done” means (plain language)

1. Workbooks run drills against a **paper** market flag — simulated fills, not real custody.
2. Paper path **cannot** post real ledger holds/settlements for drill books.
3. Users and support can tell paper vs live at a glance.
4. Catalog workbook outline (`foundations-paper-workbook`) becomes completable with simulated results.
5. Ops can enable/disable paper without opening live risk.

---

## 2 · Current code state (tip)

### 2.1 Academy side

| Area                       | Reality                                                     |
| -------------------------- | ----------------------------------------------------------- |
| Workbook shell             | `foundations-paper-workbook` outline in `catalog.ts`        |
| Explicit deferral          | Body states flag owned by **trade**; not wired from academy |
| Simulated fills in academy | **None**                                                    |
| XP on paper complete       | Needs certs path — not here                                 |

### 2.2 Trade side

| Area                      | Reality                                         |
| ------------------------- | ----------------------------------------------- |
| `trade.spot`              | **done** — real markets/orders                  |
| Paper market flag product | **Residual** under this tracker id              |
| Risk                      | Real `placeOrder` must never be the paper drill |

### 2.3 Catalog honesty

“No simulated fills here. No balances. No XP” until paper market + certs land.

---

## 3 · Doctrine constraints

| Law                   | Implication                                          |
| --------------------- | ---------------------------------------------------- |
| No real money paper   | Separate book/flag; prefer zero ledger for pure sim  |
| Honesty               | UI labels paper; never paint sim as withdrawable PnL |
| Fail closed           | Missing flag → refuse paper drill, not silent live   |
| Brand                 | No vendor demo-exchange names                        |
| Class M if any ledger | Audit required                                       |
| No dual-edit          | Open trade spot PRs                                  |

---

## 4 · DoD sketch (checkable — staged)

### Stage 1 — flag + isolation

- [x] Product law: paper venue id / market flag shape on trade.
- [x] placeOrder on paper cannot debit real available balances.
- [x] Tests: live unchanged; paper refuses real asset spend.

### Stage 2 — workbook loop

- [x] Academy workbook calls paper APIs.
- [x] Simulated fill history for outline drills (trade-supplied opaque fill refs only).
- [ ] Optional progress hook to certs.

### Stage 3 — ops

- [x] Enable/kill paper without killing live (`ACADEMY_PAPER_TRADING_ENABLED` + `paperOpsStatus`).

### Tracker `done` bar

Flip only when workbooks complete paper drills without real money risk.

---

## 5 · Open questions

1. In-memory sim vs ledger “paper” accounts?
2. Shared matching with paper book vs separate?
3. Who resets paper state?
4. Rank/XP from paper (farm risk)?

---

## 6 · Gaps (named)

1. No trade paper flag implementation.
2. Workbook outline only.
3. No sim fill API.
4. No UI paper badge standard.
5. XP policy undecided.

---

## 7 · Risks

| Risk                      | Why it hurts                  |
| ------------------------- | ----------------------------- |
| Paper hits real ledger    | Fund loss incident            |
| UI confuses paper/live    | Wrong withdrawal expectations |
| XP farm from paper        | Rank inflation                |
| Dual-edit spot money path | Live trading regress          |

---

## 8 · Estimated size

| Slice                  | Size    |
| ---------------------- | ------- |
| Flag + isolation tests | **M**   |
| Workbook wire          | **S–M** |
| Ops controls           | **S**   |

**First implement PR (when free):** **M** — trade paper isolation + tests; academy consumer second PR.

---

## 9 · Related docs / code

- `services/svc-academy/src/curriculum/catalog.ts`
- `services/svc-trade` spot engine
- `academy.certs` for completion XP later

---

## 10 · Explicit non-goals for this pack

- No real-money paper trading confusion.
- No inventing live fee discounts for paper wins.
- No `features.mjs` edit.
