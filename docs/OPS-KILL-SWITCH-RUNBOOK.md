# Operator kill-switch runbook

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Status:** live on tip (wired #186; admin board live-module path A-P5-OPS)  
**Law:** `INTAFACED_DEFINITIVE_BUILD.md` §14.6 · edge fail-closed · never trap funds  
**Board Clear:** A-P5-OPS (ops surface)

This is the operator path to **halt a module without a deploy**, and the ledger freeze path that **halts all value movement**. It is not a full `ops.admin` product (listings, fee params, treasury UI, SSO) — those remain residual.

**When ledger/trade is red (roles + detect + which door):** [`ops/INCIDENT-MONEY-PATH-RUNBOOK.md`](ops/INCIDENT-MONEY-PATH-RUNBOOK.md) (D26-P3-10). That page does not invent a second switch.

---

## What is real today

| Surface                                                         | What it does                                                    | Credential                                                |
| --------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------- |
| `GET/POST /admin/kill-switches` on **svc-edge**                 | Read / flip **module** kill-switches; audit trail               | Bearer with `admin:write` + MFA                           |
| `GET /admin/status` on **svc-edge**                             | One-shot control-plane summary for operators / probes           | Bearer with `admin:write` + MFA                           |
| `GET/POST /admin/ledger/freeze` · `POST /admin/ledger/unfreeze` | Ledger **posting freeze** (money plane)                         | Bearer with `admin:treasury` (+ MFA via interactive-only) |
| `apps/admin` → `GET/POST /api/kill-switch`                      | Server-side hop so the browser never holds the token            | `EDGE_URL` + `ADMIN_OPERATOR_TOKEN` on the console        |
| `apps/admin` → `GET/POST /api/ledger-freeze`                    | Same hop for freeze                                             | `EDGE_URL` + `ADMIN_TREASURY_TOKEN`                       |
| Kill-switch **guard** on every `/api/*`                         | Refuses new commitments when a module is killed; lets users out | n/a (process-local state on the edge)                     |

**Not live (honest residual):**

- Per-flag env / flag-store overrides staged on the console remain **browser-session preview** until a durable flag store lands (§13).
- Ledger **reconcile** from the console is still a stub (`operator-commands.ts`).
- Console has **no operator SSO** of its own — tokens are deployment credentials; audit names the console principal until SSO.
  - **P0 residual:** anyone who can reach `apps/admin` BFF routes can use the shared operator token. **Do not expose admin without network ACL / SSO.** Ship gate for real money.
  - Optional **BFF gate:** set `ADMIN_BFF_SHARED_SECRET` and inject header `x-intafaced-admin-bff` from reverse proxy after SSO. When unset, network ACL only.
- Kill-switch state: optional **restart durability** via `EDGE_KILL_STATE_PATH` (default `.data/edge-kill-state.json`) so a bounce does not wipe an incident kill. **Multi-replica share is still a §13 socket** (file is per host).

---

## Rule of the switch (must hold during an incident)

When a module is killed:

1. **New commitments refuse** — place order, deposit, relay submit, etc. → **503** `edge.module_killed` (or `edge.kill_switch_undecidable` if the check itself fails — **fail closed**).
2. **Users can still get out** — cancels and documented release REST paths still pass:
   - tRPC leaf `cancel` (any module)
   - `DELETE /api/v1/orders/:id` and `DELETE /api/v1/orders` (CCXT cancel)
   - `POST /api/v1/positions/:id/close` and `POST /api/v1/futures/positions/close-all` (futures close — must not trap margin under a trade kill). `DELETE /api/v1/positions/:id` does not close and does not release margin.
3. **Reads still pass** — a kill is not a blackout of balances / open orders.
4. **Control plane stays reachable** — `/admin/*`, `/health`, `/ready` are **outside** the kill guard so the operator can un-kill and the LB can still probe.
5. **Perimeter-only enforcement** — edge kill only stops modules mapped in `UPSTREAMS` (`trade`, `pay`, `identity`, …). Killing `ws`, `matching`, `ledger`, `edge` is **audit-only** until a real control path exists; the board labels these “Not edge-enforced.”

A control that traps open risk is not a safety control.

---

## How to pull a module switch

### Via `apps/admin` (preferred when deployed)

1. Set on the console process:
   - `EDGE_URL` — base URL of svc-edge (no trailing slash required)
   - `ADMIN_OPERATOR_TOKEN` — access token with `admin:write` + MFA claim
2. Open `/` (Kill-switches). Control-plane panel must show **reachable**.
3. On the module row, kill / enable and enter a **reason ≥ 12 characters** (server-enforced).
4. Confirm the audit line appears (who / module / previous → next).

If status is **unconfigured**, the console cannot reach the edge — fix env; do not trust a local staged flip as live.

If status is **unreachable**, the edge refused or timed out — check token scopes, MFA, and edge health.

### Via curl (break-glass)

```bash
# Read
curl -sS -H "Authorization: Bearer $ADMIN_OPERATOR_TOKEN" \
  "$EDGE_URL/admin/kill-switches" | jq .

# Status summary
curl -sS -H "Authorization: Bearer $ADMIN_OPERATOR_TOKEN" \
  "$EDGE_URL/admin/status" | jq .

# Kill trade (example)
curl -sS -X POST -H "Authorization: Bearer $ADMIN_OPERATOR_TOKEN" \
  -H "content-type: application/json" \
  -d '{"module":"trade","disabled":true,"reason":"incident: halt new risk while investigating fill anomaly"}' \
  "$EDGE_URL/admin/kill-switches" | jq .

# Re-enable
curl -sS -X POST -H "Authorization: Bearer $ADMIN_OPERATOR_TOKEN" \
  -H "content-type: application/json" \
  -d '{"module":"trade","disabled":false,"reason":"incident closed: reopening trade after review"}' \
  "$EDGE_URL/admin/kill-switches" | jq .
```

`module` must be a known `ModuleId` from `@intafaced/config`.

---

## Ledger freeze (money plane — separate authority)

Halting **one market** (`admin:write`) is not the same as halting **all posting** (`admin:treasury`).

```bash
curl -sS -H "Authorization: Bearer $ADMIN_TREASURY_TOKEN" \
  "$EDGE_URL/admin/ledger/freeze" | jq .

curl -sS -X POST -H "Authorization: Bearer $ADMIN_TREASURY_TOKEN" \
  -H "content-type: application/json" \
  -d '{"reason":"reconciliation mismatch — freeze until book verifies"}' \
  "$EDGE_URL/admin/ledger/freeze" | jq .

curl -sS -X POST -H "Authorization: Bearer $ADMIN_TREASURY_TOKEN" \
  -H "content-type: application/json" \
  -d '{}' \
  "$EDGE_URL/admin/ledger/unfreeze" | jq .
```

Requires `LEDGER_URL` on svc-edge. If unset, freeze endpoints return **503** `edge.ledger_unreachable` — never a fake success.

Use freeze after an **unverifiable book** (§4.2), not as a substitute for killing a single module.

---

## Proof that it is wired (do not skip)

| Check                                                                      | Where                                                             |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Behavioural e2e: flip → traffic refuses → cancel still ok                  | `services/svc-edge/src/control-plane.e2e.test.ts`                 |
| Structural DoD: routes declare `module`, guard is `onRequest`, fail closed | `tooling/ci/killswitch-reachability.mjs` (part of `pnpm verify`)  |
| Admin client talks to edge                                                 | `apps/admin/src/lib/control-plane-client.ts` + `/api/kill-switch` |

---

## §13 sockets (named residuals)

1. **Durable multi-replica kill-switch store** — edge process memory today; restart clears kills.
2. **Operator SSO** — console token is per-deployment; audit names console principal until human SSO.
3. **Flag store** — per-flag overrides on the board are still session staging.
4. **Ledger reconcile live from console** — stub until tRPC/admin path is swapped in `operator-commands.ts`.
5. **In-service `set…Enabled` hooks** — still boot-env only for some services; edge perimeter is the reachable switch.

---

## What this does **not** cover

- Bank earn / cards / ramps money paths (separate Phase 5 human / bank lanes).
- Pay rails, partner names, or vendor kill paths.
- Stopping a **vendored Java dual-book** path if one is still mounted — edge kills our `/api/*` modules; foreign books need their own halt (see vendored overlap audit).
- Go-live Class X claims — this runbook is operator tooling, not a launch certificate.
