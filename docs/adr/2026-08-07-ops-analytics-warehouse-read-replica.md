# ADR: `ops.analytics` — warehouse is a read replica, never a second book

**Status:** **Accepted — 2026-08-07.** Stage-1 product law for tracker row `ops.analytics` ("Warehouse — read replica + cube layer").
**Decision owner:** Nitro agents under doctrine §8.8. **Class:** N (no money invent; read path only).
**Reason this exists:** Slice A contracts already name metrics and lag SLOs. What was still missing is the **replica connection law** and an **honest empty surface** so operators never see invented trading volume when the warehouse is dark.

---

## 0 · Plain English

Analytics must not become another place that "knows" balances. The warehouse (or OLAP path) is fed from production **read replicas**. If the replica is missing, lag is unknown, or there are no facts yet, the surface says **empty / unavailable** — it does not invent a dashboard walk.

---

## 1 · Decisions

### 1.1 Which databases may replicate (Stage-1)

| Source   | Role in warehouse                        | Writer remains SoT |
| -------- | ---------------------------------------- | ------------------ |
| ledger   | money movement facts                     | `svc-ledger`       |
| trade    | fills / order facts                      | `svc-trade`        |
| identity | non-money cohort dims only (no balances) | `svc-identity`     |

No other service DB is in the Stage-1 plan. Adding one is a new ADR, not a silent env var.

### 1.2 Analytics credentials are read-only

**Decided:** every analytics connection uses a **readonly** role. Usernames must carry a read-only marker (`_ro`, `readonly`, `analytics_ro`, `replica_ro`). Bare service writer names (`svc_ledger`, `intafaced_ops`, …) are **refused** in code (`assertAnalyticsReplicaRole`).

**Rejected:** pointing BI or cube jobs at the primary with the service writer role "just for now."

### 1.3 Lag fail-closed for "live"

Reuse `lagFreshness` / `mayLabelLive` from Slice A:

| Lag            | Freshness | May label "live"?     |
| -------------- | --------- | --------------------- |
| ≤ 30s          | live      | yes (only with facts) |
| ≤ 60s          | delayed   | no                    |
| > 60s          | stale     | no                    |
| null/undefined | unknown   | no                    |

Empty facts never get a live badge even when lag is live.

### 1.4 Honest empty warehouse

`queryWarehouseSurface`:

- replica unconfigured → `unavailable`
- lag unknown / stale → `unavailable`
- configured + acceptable lag + no facts → `empty`
- fixture / replica facts → `ok` only after `assertMetricPoint` (money = decimal string)

**Rejected:** fabricating 24h notional, open interest, or deposit volume when facts are missing.

### 1.5 Cube metrics stay definition + fixture until ETL exists

Slice B view SQL remains documentation + fixture-tested. Stage-1 does **not** claim a running ClickHouse/dbt job. Vendor warehouse products stay Phase B late (Internet leverage full-horizon).

---

## 2 · Code homes

| Concern                          | Path                                                   |
| -------------------------------- | ------------------------------------------------------ |
| Replica role + empty surface     | `packages/contracts/src/ops-analytics-warehouse.ts`    |
| Lag / metric catalogue (Slice A) | `packages/contracts/src/ops-analytics.ts`              |
| Cube views + fixtures (Slice B)  | `packages/contracts/src/ops-analytics-cube.ts`         |
| Consumer purity (Slice C light)  | `packages/contracts/src/ops-analytics-consume.ts`      |
| Operator runbook                 | `docs/runbooks/ANALYTICS-WAREHOUSE-REPLICA-RUNBOOK.md` |

---

## 3 · Non-goals (this ADR)

- No admin BI product UI.
- No analytics writer that posts ledger.
- No inventing live trading KPIs offline.
- No claiming `ops.analytics` tracker **done** until replica wiring + ≥1 honest cube + access control ship (trk DoD).

---

## 4 · Consequences

Operators get a checkable Stage-1 contract: replica plan, role refusal, empty surface. Later ETL / cube jobs must call into this law rather than invent a second money path.
