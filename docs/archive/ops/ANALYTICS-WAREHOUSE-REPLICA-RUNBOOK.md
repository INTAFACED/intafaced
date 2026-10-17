# Runbook — analytics warehouse read replica (TRK-ops.analytics Stage-1)

**Audience:** operators / agents wiring analytics.  
**Law:** [`docs/adr/2026-08-07-ops-analytics-warehouse-read-replica.md`](../adr/2026-08-07-ops-analytics-warehouse-read-replica.md)  
**Code:** `@intafaced/contracts` → `ops-analytics-warehouse.ts`

---

## 1 · What replicates (Stage-1)

| Source DB  | OLTP SoT       | Replica purpose                                      |
| ---------- | -------------- | ---------------------------------------------------- |
| `ledger`   | `svc-ledger`   | Journal / posting facts for count + notional metrics |
| `trade`    | `svc-trade`    | Settled fill counts                                  |
| `identity` | `svc-identity` | Non-money cohort dims only — **no balances**         |

Postgres logical replication (or a later warehouse product) may feed these. Until a replica URL is configured, the surface is **unavailable**, not invent.

---

## 2 · Credentials (fail-closed)

1. Create a **read-only** Postgres role per source (example names):
   - `analytics_ro` / `svc_ledger_ro` / `replica_ro`
2. `GRANT SELECT` on the analytics-visible schemas only. **No INSERT/UPDATE/DELETE.**
3. Put URLs in env (see `.env.example` `ANALYTICS_REPLICA_*`).
4. Never reuse `svc_ledger`, `svc_trade`, `intafaced_ops`, or migrator credentials for BI.

Code gate: `assertAnalyticsReplicaRole(url, 'readonly')` refuses writer-looking usernames.

---

## 3 · Lag SLO

| Observed lag | Label   | Operator "live" badge                                             |
| ------------ | ------- | ----------------------------------------------------------------- |
| ≤ 30s        | live    | allowed only with **probed** lag + fresh measurement + real facts |
| ≤ 60s        | delayed | forbidden                                                         |
| > 60s        | stale   | forbidden → surface `unavailable`                                 |
| unknown      | unknown | forbidden → surface `unavailable`                                 |

**Measurement law (wave-3):**

- `lagSource=probed` + `lagMeasuredAt` within 60s → may claim live when lag ≤ 30s.
- `ANALYTICS_REPLICA_LAG_SECONDS` alone is `lagSource=configured` — **never** `mayLabelLive` (a typed env number is not a measurement).
- Stale measurement age (>60s) → lag **unknown**, even if the number said 5s.
- SQL helper: `ANALYTICS_REPLICA_LAG_SQL` / `pg_last_xact_replay_timestamp` via injected probe (no DB socket inside contracts).

If you cannot measure lag, treat as unknown.

---

## 4 · Honest empty warehouse

```
replicaConfigured=false  → unavailable (replica_unconfigured)
lag unknown/stale        → unavailable
configured + fresh + ∅   → empty (no_facts)  ← never invent volume
configured + facts       → ok points (decimal strings for money)
```

Use `queryWarehouseSurface` from contracts. Do not paint fake 24h notional in admin.

---

## 5 · Local check

```bash
pnpm --filter @intafaced/contracts test -- ops-analytics-warehouse
```

Expect: writer URLs refuse; empty facts → `empty`; money-as-number → `refuse`.

---

## 6 · Residual (not this Stage)

- Physical logical-replication slots in compose
- Cube ETL job / ClickHouse (Phase B late)
- Admin read-only consumer UI
- Tracker `done` for `ops.analytics`
