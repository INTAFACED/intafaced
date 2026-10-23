# TRK-ops.analytics — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `ops.analytics`  
**Title:** Warehouse — read replica + cube layer  
**Module / phase:** `core-ops` · phase **5**  
**Status on tip:** `wip` · **owner:** cursor-swarm-analytics  
**Depends on:** `ledger.double-entry`  
**Tip freeze:** re-derive from `origin/main` before next residual  
**Pack type:** Stage-1 shipped in contracts — no invent KPIs; warehouse is **read** path.

---

## 1 · What “done” means (plain language)

1. A **warehouse** (or equivalent OLAP path) is fed from production data without writers inventing rollups.
2. Read replica / ETL strategy is documented and runnable.
3. Cube (or semantic) layer exposes metrics operators trust — sourced from ledger/trade facts.
4. Apps do not query primary OLTP with unbounded analytics scans as a substitute.
5. Money figures remain decimal-honest; no float warehouse “close enough”.

---

## 2 · Current code state (tip)

### 2.1 What exists

| Area              | Reality                                                                 |
| ----------------- | ----------------------------------------------------------------------- |
| `apps/admin`      | Operator console — kill/freeze/launch/jurisdiction; **not** a warehouse |
| `apps/web`        | Customer surface — not BI                                               |
| Analytics service | **Absent**                                                              |
| Ledger            | Source of truth for money movements (`svc-ledger`)                      |
| Tracker dep       | `ledger.double-entry`                                                   |

### 2.2 Honest residual

There is **no** cube project, no dbt project, no dedicated replica wiring in monorepo tip for this title. Admin charts that might appear later must not invent series.

---

## 3 · Doctrine constraints

| Law                 | Implication                                      |
| ------------------- | ------------------------------------------------ |
| Dual-book           | Analytics never becomes a second money authority |
| Read-only warehouse | ETL must not post ledger                         |
| PII                 | Warehouse access ACL; no casual dump of identity |
| NO-FLEET            | Do not claim live dashboards without data path   |

---

## 4 · DoD sketch (checkable — staged)

### Slice A — replica + contract

- [x] Document which DBs replicate (ledger, trade, …) — ADR + `WAREHOUSE_REPLICA_PLAN_V0`
- [x] Lag SLO + fail-closed for “live” labels — `queryWarehouseSurface` + Slice A `lagFreshness`
- [x] Forbidden: analytics writer credentials on primary — `assertAnalyticsReplicaRole`
- [x] Honest empty warehouse (no invent volume) — `status=empty|unavailable`

### Slice B — cube metrics v1

- [x] Metric definitions mapped to SQL/views — `CUBE_VIEWS_V0` (prior)
- [x] Tests: fixture ledger → expected cube numbers — cube + warehouse surface tests
- [ ] Physical ETL / warehouse process (residual)

### Slice C — consumer

- [x] Consumer purity gate — `consumeCubePoints` (prior; no invent empty series)
- [ ] Admin or BI tool read path (residual)
- [x] No write credentials in BI layer — role law in Stage-1

---

## 5 · Open questions

1. In-house cube vs vendor BI (brand scan if named in product UI)?
2. Same Postgres logical replication vs warehouse product?
3. Who owns metric definitions (ops vs each service)?

---

## 6 · Estimated size

| Slice               | Size  |
| ------------------- | ----- |
| Replica + docs      | **M** |
| Cube v1 + consumers | **L** |

---

## 7 · Related docs / code

- `services/svc-ledger` as money fact source
- `apps/admin` for eventual consumer (not current warehouse)
- Long-form twin: [TRK-ops.analytics.md](./TRK-ops.analytics.md)

---

## 8 · Explicit non-goals

- No inventing dashboard KPIs offline.
- No analytics writer that posts balances.
- No claiming admin kill-switch UI as this feature.

---

## 9 · Metric examples that are safe only if sourced

| Metric         | Source of truth      | Invent risk                     |
| -------------- | -------------------- | ------------------------------- |
| 24h notional   | trade fills / ledger | UI random walk                  |
| Open interest  | matching/trade       | Fabricated OI                   |
| Deposit volume | ledger recipes       | Double count without recipe ids |

Each cube metric needs a written SQL/view definition and a fixture test.

## 10 · First PR shape

| PR  | Scope                           |
| --- | ------------------------------- |
| 1   | Warehouse ADR + replica runbook |
| 2   | Three metrics + fixture tests   |
| 3   | Admin read-only consumer        |

Never grant BI write credentials to production primary.
