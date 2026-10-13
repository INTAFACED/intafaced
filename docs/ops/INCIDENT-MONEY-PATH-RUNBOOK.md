# Incident runbook — money path (ledger / trade red)

**Tracker:** D26-P3-10 · LIVE-LANES `denon-d26-p3-10-incident`  
**Class:** N (ops procedure). Does **not** close Class X go-live.  
**Law:** Doctrine §4.2 (unverifiable book → freeze posting) · §14.6 (operator kill, never trap funds) · [`../INTERNET-LEVERAGE-LAW.md`](../INTERNET-LEVERAGE-LAW.md) Phase A IN (name existing doors; do not rebuild them).  
**How to pull a switch (curl / console):** [`../OPS-KILL-SWITCH-RUNBOOK.md`](../OPS-KILL-SWITCH-RUNBOOK.md) — this file is **who does what when**, not a second copy of those commands.  
**Restore is not authorized here.** The bounded **D26-P3-09** drill is recorded in [`../MONEY-BACKUP-RESTORE-DRILL.md`](../MONEY-BACKUP-RESTORE-DRILL.md); it is not production or incident-cutover authority. See §4.

This page exists so agents and humans can act when **ledger posting** or **trade/match** is red **without inventing a new money control**. If a door is not named below, it is not in this playbook.

---

## 0 · Decision tree (one screen)

| What you see                                                         | First contain (existing door only)                                                                                                                                         | Who                                                                              |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Book unverifiable (recon fail, chain break, freeze already on)       | **Ledger posting freeze** — `POST /admin/ledger/freeze` on svc-edge (`admin:treasury` + MFA). Do **not** use a module kill as a substitute.                                | Denon (or treasury-token holder). Agents page; they do not invent freeze policy. |
| New trade risk is the problem; book still posts                      | **Edge module kill `trade`** — `POST /admin/kill-switches` (`admin:write` + MFA). Cancels and reads must still pass.                                                       | Denon / operator with `admin:write`.                                             |
| Spot plane only                                                      | Process flag `TRADE_SPOT_ENABLED=false` (svc-trade) — already in `services/svc-trade/README.md`. Takes the instance out of LB via `/ready` 503. Does **not** halt futures. | Denon. Agents do not invent a combined boolean.                                  |
| Futures plane only                                                   | `TRADE_FUTURES_ENABLED=false` — refuses new futures orders; not an outage of spot.                                                                                         | Denon.                                                                           |
| Engine must stop taking new rest                                     | `MATCHING_ENGINE_ENABLED=false` / `matching.engine` — submissions refuse **before journal**; cancels + depth still work. Edge kill of `matching` is **audit-only**.        | Denon.                                                                           |
| Incident is on Protocol / INTACHAIN / dex self-custody               | **Stop.** Shehzad owns implement. Agents babysit only.                                                                                                                     | Shehzad (`@shehzad002`).                                                         |
| Need a host backup, secret rotate, prod RPC, sanctions list, licence | **Class X.** This runbook does not authorize it.                                                                                                                           | Nitro human (+ counsel).                                                         |
| Want to restore Postgres / matching journal                          | A local ledger-schema drill exists, but production/cross-store restore is unproven and not authorized here. Contain with freeze/kill above.                                | See §4.                                                                          |

**Never:** invent freeze magnitudes, a new kill flag, a second book, or a “halt everything including cancels” switch. A control that traps open risk is not a safety control ([`../OPS-KILL-SWITCH-RUNBOOK.md`](../OPS-KILL-SWITCH-RUNBOOK.md)).

---

## 1 · Detect — probes, metrics, logs (files that already exist)

Unauthenticated `/ready` is for load balancers. It is **not** the operator halt oracle on the edge.

| Signal                           | File / route                                                                      | What red looks like                                                                                                                                                                                                                                                                                                                           |
| -------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ledger posting down              | `services/svc-ledger/src/index.ts` `GET /ready` (compose `svc-ledger:4001`)       | **503** `{ ready: false, reason }` when `postingEnabled` is false. Frozen ledger **leaves LB rotation** instead of refusing posts one-by-one (`services/svc-ledger/README.md`).                                                                                                                                                               |
| Ledger liveness vs freeze        | same file `GET /health`                                                           | Still 200 with status payload including freeze fields — liveness ≠ posting.                                                                                                                                                                                                                                                                   |
| Durable freeze row               | `services/svc-ledger/src/ledger/freeze.ts` · `services/svc-ledger/src/service.ts` | Freeze is a **database fact** (`posting_freeze`), not process memory.                                                                                                                                                                                                                                                                         |
| Recon self-freeze                | `services/svc-ledger/src/service.ts` `reconcile()` · cron in `index.ts`           | On mismatch: freeze attributed to `reconciliation`, log **FATAL** `LEDGER RECONCILIATION FAILED`, events below.                                                                                                                                                                                                                               |
| Ledger events                    | `services/svc-ledger/README.md`                                                   | `intafaced.ledger.reconciliation.failed` · `intafaced.ledger.freeze.updated` (both freeze and thaw).                                                                                                                                                                                                                                          |
| Trade placement unfit            | `services/svc-trade/src/index.ts` `GET /ready` (`svc-trade:4004`)                 | **503** if `TRADE_SPOT_ENABLED` off (`reason: trade.spot flag is off`), on engine sequence **regressions** vs `trade.fills` (lost-journal advice), **or** when a traded market's engine counter cannot be read (outage or malformed reply; no lost-journal advice, cause only in the log) (`services/svc-trade/src/spot/sequence-guard.ts`).  |
| Trade liveness extras            | same `GET /health`                                                                | MM seed / futures jobs / venue latency **health presentation** — not a freeze switch.                                                                                                                                                                                                                                                         |
| Matching unfit                   | `services/svc-matching/src/index.ts` `GET /ready` (`svc-matching:4005`)           | **503** `{ reason: 'matching.engine flag is off' }`.                                                                                                                                                                                                                                                                                          |
| Matching journal vs book         | `services/svc-matching/README.md` · boot warn in `index.ts`                       | Resting orders replayed with **no** local proof of ledger holds. Compare via `POST /reconcile` (service credentials). Caller job: `TRADE_RECONCILE_JOBS_ENABLED` default **OFF** — [`../ENGINE-LEDGER-RECONCILE-HANDOFF.md`](../ENGINE-LEDGER-RECONCILE-HANDOFF.md). Alarm only until an operator resolves; do not auto-delete funded orders. |
| Edge process up                  | `services/svc-edge/src/index.ts` `GET /ready` (`svc-edge:4000`)                   | Route prefixes, wiring, screening/CORS **counts**, rate-limit posture, body budget. **`disabledModules` is absent** — unauthenticated `/ready` is not a kill-switch oracle (`services/svc-edge/README.md`).                                                                                                                                   |
| Operator halt list               | `GET /admin/status` · `GET /admin/kill-switches`                                  | `admin:write` + MFA. Implemented in `services/svc-edge/src/control-plane.ts` + `admin-api.ts`.                                                                                                                                                                                                                                                |
| User-facing SLO scrape           | `GET /metrics` on svc-edge · `services/svc-edge/src/metrics.ts`                   | Prometheus job `svc-edge` in `tooling/infra/prometheus.yaml` (`svc-edge:4000/metrics`, 10s). Grafana panel: `tooling/infra/grafana/dashboards/edge-slo.json`. **svc-trade does not expose `/metrics` on tip** — do not invent a per-service scrape.                                                                                           |
| Structural proof the kill exists | `tooling/ci/killswitch-reachability.mjs`                                          | Part of `pnpm verify` / gates. Behavioural: `services/svc-edge/src/control-plane.e2e.test.ts`.                                                                                                                                                                                                                                                |
| WS still live under an edge kill | `services/svc-edge/README.md` · `docs/ops/P-WS-INTEGRITY-REPORT-2026-08-03.md`    | `svc-ws:4014` is **outside the door**. Edge kill cannot halt market-data sockets. Honest residual — do not treat a green halt on `/admin/status` as “tape is dead.”                                                                                                                                                                           |

Compose ports: `docker-compose.apps.yml` (`intafaced-svc-ledger` 4001, `svc-edge` 4000, `svc-trade` 4004, `svc-matching` 4005).

---

## 2 · Contain — existing freeze / kill doors only

**Do not add a new flag, env, or magnitude in an incident.** Use these, in this order of blast radius.

### 2.1 Ledger posting freeze (all value movement)

| Piece                | Where                                                                                                                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Edge proxy           | `GET/POST /admin/ledger/freeze` · `POST /admin/ledger/unfreeze` — `services/svc-edge/src/control-plane.ts` (`admin:treasury` + MFA). Needs `LEDGER_URL` on the edge; unset → **503** `edge.ledger_unreachable`, never a fake success. |
| Ledger operator HTTP | `GET/POST /operator/freeze` · `POST /operator/unfreeze` · `POST /operator/reconcile` — `services/svc-ledger/src/operator-http.ts`.                                                                                                    |
| Console hop          | `apps/admin` `/api/ledger-freeze` — documented in [`../OPS-KILL-SWITCH-RUNBOOK.md`](../OPS-KILL-SWITCH-RUNBOOK.md). Front-end path is HUMAN (`nitro-frontend-all`); agents do not craft Vue.                                          |
| Boot-only freeze     | `LEDGER_POSTING_ENABLED=false` — `LedgerService.applyStartupPolicy` **can freeze and can never thaw** via that flag. **Not** the interactive incident lever. Prefer `/admin/ledger/freeze`.                                           |

Use freeze after an **unverifiable book** (§4.2), not as a substitute for killing a single module.

### 2.2 Edge module kill (new commitments; users can still get out)

| Piece                        | Where                                                                                                                             |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Guard                        | `services/svc-edge/src/kill-switch.ts` + `registerKillSwitchGuard` in `control-plane.ts`                                          |
| Flip                         | `POST /admin/kill-switches` `{ module, disabled, reason }` (`reason` ≥ 12 chars)                                                  |
| Durability                   | optional `EDGE_KILL_STATE_PATH` (default `.data/edge-kill-state.json`) — **per host**. Multi-replica share is still a §13 socket. |
| Money-route completeness pin | `services/svc-edge/src/money-routes.kill-switch.test.ts`                                                                          |

**Enforced** only for modules in `UPSTREAMS` (`services/svc-edge/src/routes.ts`): `trade`, `pay`, `identity`, …  
Killing `ws`, `matching`, `ledger`, `edge` on this board is **audit-only**. Ledger halt is §2.1. Matching halt is §2.3.

When `trade` is killed: new places → **503** `edge.module_killed` (or `edge.kill_switch_undecidable` fail-closed). Still pass: tRPC `cancel`, `DELETE /api/v1/orders` / `:id`, `DELETE /api/v1/positions/:id` (`ALWAYS_ALLOWED_REST` in `kill-switch.ts`).

### 2.3 In-service flags already wired (not new policy)

| Flag                                          | Effect already documented                                                                                             |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `TRADE_SPOT_ENABLED` / `trade.spot`           | New spot refused `trade.spot_disabled`; `/ready` 503. Cancels/reads stay. `services/svc-trade/README.md` Kill-switch. |
| `TRADE_FUTURES_ENABLED` / `trade.futures`     | New futures refused; spot unaffected.                                                                                 |
| `TRADE_CONVERT` / convert kill                | Convert execute refuses `trade.convert_disabled`.                                                                     |
| `TRADE_ALGO` / algo kill                      | TWAP create refuses `trade.algo_disabled`.                                                                            |
| `TRADE_MM_SEED_ENABLED`                       | Seed/mm place refuse (SD-4). Default OFF.                                                                             |
| `MATCHING_ENGINE_ENABLED` / `matching.engine` | `engine_disabled` before journal; `/ready` 503. `services/svc-matching/README.md`.                                    |
| Per-market                                    | `setMarketStatus` on svc-trade — finer grain; same “no new risk, no confiscation.”                                    |

**Not a kill switch:** rolling back a deploy (staging workflow). Named in [`../THREAT-MODEL-STAGING-DEPLOY.md`](../THREAT-MODEL-STAGING-DEPLOY.md) §8 row 14.

**Not this playbook:** pay rails / bank earn / partner vendor kills ([`../OPS-KILL-SWITCH-RUNBOOK.md`](../OPS-KILL-SWITCH-RUNBOOK.md) “What this does not cover”). Vendored Java dual-book needs its own halt if still mounted.

---

## 3 · Roles (who may act)

Binding split: [`../THREE-WAY-DISTRIBUTION-2026-08-04.md`](../THREE-WAY-DISTRIBUTION-2026-08-04.md) · [`../NITRO-OWNERSHIP-AND-DENON-DIRECTION-2026-07-31.md`](../NITRO-OWNERSHIP-AND-DENON-DIRECTION-2026-07-31.md).

| Role                                      | During a money-path incident                                                                                                                                                                                                                                                                              | Must not                                                                                                                                                                                                    |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Denon** (`@Phantom-X-007`)              | Incident **technical lead**. Chooses freeze vs module kill vs plane flag. Runs `/operator/reconcile`. Authorizes **unfreeze** only after the book verifies. Product-law calls if the incident exposes a missing spec.                                                                                     | Invent new freeze magnitudes; close Class X; implement Shehzad chain.                                                                                                                                       |
| **Nitro human** (`@ZenYoda3`) Class **X** | Secrets, prod/staging **host** acts, licence, sanctions **content**, wallet_rpc go-live, **take or restore a database backup** (threat-model row 15 — still owner). Rotate leaked credentials.                                                                                                            | Be asked to run git/PR. Agents run the loop.                                                                                                                                                                |
| **Shehzad** (`@shehzad002`)               | If the red is **Protocol Plane / INTACHAIN / bridge / dex self-custody / venue contracts** — he implements. Agents file symptoms and stop.                                                                                                                                                                | Agents writing chain code “to help.”                                                                                                                                                                        |
| **Agents** (Nitro or Denon session)       | **Babysit:** detect from §1, page the right human, follow this page, operate **existing** doors if credentials are already in the environment, keep cancels working, write an honest incident note (what probe, which door pulled, PR/chat link). Open Class N docs/fix PRs that do not invent money law. | Invent kill/freeze policy; restore data; merge Class X as done; dual-edit Shehzad chain mountains; craft Vue (`nitro-frontend-all`); expose `apps/admin` without ACL/SSO (P0 residual on the kill runbook). |

**Credential reminder (already law, not new):** freeze needs `admin:treasury`; module kill needs `admin:write` + MFA. Do not share those tokens in chat or commit them.

---

## 4 · Restore is **not authorized by this runbook**

| Fact                                                                                                                         | Pointer                                                                                                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A throwaway `ledger`-schema dump/restore and SQL consistency drill ran; live cutover and full hash recomputation did not run | [`../MONEY-BACKUP-RESTORE-DRILL.md`](../MONEY-BACKUP-RESTORE-DRILL.md)                                                                                                                                                           |
| Production/PITR/off-host retention, freeze-consistent capture, and coordinated matching/trade/domain restore remain unproven | [`../MONEY-BACKUP-RESTORE-DRILL.md`](../MONEY-BACKUP-RESTORE-DRILL.md) §4 and [`../SPEC-PRO-EXCHANGE-RESILIENCE-AND-INCIDENT-COMMAND-2026-08-24.md`](../SPEC-PRO-EXCHANGE-RESILIENCE-AND-INCIDENT-COMMAND-2026-08-24.md) §§11–12 |
| Staging threat model: **take or restore a database backup** is owner, **no retention policy to implement**                   | [`../THREAT-MODEL-STAGING-DEPLOY.md`](../THREAT-MODEL-STAGING-DEPLOY.md) §8 row 15 · named gap **D4**                                                                                                                            |
| Asymmetric restore is a known money failure                                                                                  | Matching journal vs Postgres fills — [`../adr/2026-08-07-fill-sequence-key-stays.md`](../adr/2026-08-07-fill-sequence-key-stays.md). Restoring one store and not the other is how sequence regression `/ready` 503 exists.       |

The bounded drill does not authorize `pg_restore`, journal replay, volume copying, or production cutover as an incident step. Contain with §2 and follow an owner-authorized, versioned recovery plan with cross-store reconciliation. Unfreeze only when posting is legal again on the proved book — that is Denon’s call, not an inference from the drill.

---

## 5 · After contain (still not restore)

1. Keep **cancels** and documented release REST working. Confirm with a cancel, not with a new place.
2. Recon: `POST /admin/ledger/…` reconcile path / `POST /operator/reconcile` — freeze-on-failure is already coded; do not skip it to “look green.”
3. Engine↔ledger: if `TRADE_RECONCILE_JOBS_ENABLED` logs `REFUSE`, operator resolves; auto-delete is **unfunded pending only**.
4. Un-kill / unfreeze with a reason ≥ 12 characters, same doors as contain.
5. If the hole was missing **procedure**, patch **this file** (or the kill runbook). If the hole was missing **code**, that is a different tracker id — do not smuggle a new money control into an incident PR.

---

## 6 · Honest residuals (named, not invented)

1. **D26-P3-09** local backup/restore drill is bounded evidence; production/PITR/off-host/cross-store recovery and cutover remain unproven.
2. **D26-P3-08** alerts + one real (non-local) dashboard — local compose scrape + `edge-slo.json` exist; remote alert routes are a separate mountain.
3. Multi-replica kill-switch store · operator SSO · flag store · console reconcile stub — [`../OPS-KILL-SWITCH-RUNBOOK.md`](../OPS-KILL-SWITCH-RUNBOOK.md) §13.
4. Edge cannot halt `svc-ws`.
5. `edge.gateway` flag is `NOT_ENFORCED` — live kill is `/admin/kill-switches`, not that flag (`services/svc-edge/README.md`).
6. Admin BFF shared token without network ACL — P0 residual; ship gate for real money.

---

## Leverage

Phase A **IN** — `svc-edge` kill/freeze proxy, `svc-ledger` durable freeze, `svc-trade` / `svc-matching` `/ready` + existing env flags, Prometheus scrape already wired. Horizon: D26-P3-10 is ops procedure (this file). No second admin product, no second book, no greenfield kill-switch.
