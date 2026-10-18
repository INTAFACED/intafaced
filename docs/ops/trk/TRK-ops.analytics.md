# TRK-ops.analytics — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `ops.analytics`  
**Title:** Warehouse — read replica + cube layer  
**Module / phase:** `core-ops` · phase 5 · plane F  
**Status on tip:** ready · **owner:** none  
**Depends on:** `ledger.double-entry` (done)  
**Requires:** warehouse infra — **none on tip**  
**Tip freeze:** `origin/main` @ `04f9b1f2` (re-derive before implement)  
**Pack type:** research only — no implement swarm; no money invention; **no** `features.mjs` edit from this pack.

---

## 1 · What “done” means (plain language)

1. Analytics runs on a **read replica / warehouse**, not the primary money writer under load.
2. Cubes/metrics are **derived**; dashboards never become a second ledger or “fix” balances.
3. Money figures stay decimal-string honest; lagging feeds show **stale/unavailable**, not invented KPIs.
4. Access is operator-scoped; no customer PII export without policy.

---

## 2 · Current code state (tip)

### 2.1 No warehouse service

| Fact                        | Tip                                                                           |
| --------------------------- | ----------------------------------------------------------------------------- |
| Dedicated analytics service | **None**                                                                      |
| SoT                         | Ledger + events remain system of record                                       |
| Admin                       | apps/admin is control plane, not warehouse                                    |
| Vendor                      | statistics controllers in vendor admin — read-shaped legacy, not monorepo SoT |

Infra + product scope open.

---

## 3 · Doctrine constraints

| Law            | Implication                       |
| -------------- | --------------------------------- |
| §8.8 warehouse | Read replica + cube layer         |
| Dual-book      | Analytics must not write balances |
| Money display  | No IEEE floats for money KPIs     |
| PII            | Export policy / §10               |

---

## 4 · DoD sketch (checkable — staged)

### Stage 1 — infra

- [x] Read replica connection package + runbook — `ops-analytics-warehouse` + ADR + `docs/ops/ANALYTICS-WAREHOUSE-REPLICA-RUNBOOK.md`
- [x] Forbidden: analytics writer credentials on primary — `assertAnalyticsReplicaRole`
- [x] Honest empty warehouse surface — never invent trading volume

### Stage 2 — first cube

- [x] Metric views + fixture evaluation (contracts Slice B) — not a live ETL yet
- [ ] One volume/users cube from events batch job (residual)
- [x] Staleness field required — surface returns freshness / unavailable on stale lag

### Stage 3 — operator UI

- [ ] apps/admin or ops surface read-only

**Tracker `done`:** replica + ≥1 honest cube + access control — not a Notion dashboard. Stage-1 does **not** flip tracker done.

---

## 5 · Open questions

1. Which cubes first (volume, fees, signups)?
2. Cube tech (in-house SQL vs external) — cost?
3. PII retention in warehouse?

---

## 6 · Estimated size

| Slice          | Size        | Notes |
| -------------- | ----------- | ----- |
| Replica wiring | **M** infra |       |
| First cube job | **M**       |       |
| Full BI        | **XL**      |       |

**First implement PR:** **L/M infra** replica package + runbook; cube second.

**Human blockers:** Infra; Product; Doctrine.

---

## 7 · Related docs / code

- Doctrine §8.8
- ledger as SoT
- VENDORED statistics controllers

---

## 8 · Explicit non-goals for this pack

- No second ledger.
- No invent daily volume.
- No features.mjs done.
