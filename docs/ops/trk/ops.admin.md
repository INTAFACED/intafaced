# TRK-ops.admin — research / spec pack

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Tracker id:** `ops.admin`  
**Title:** apps/admin — listings, fee params, treasury, kill-switches  
**Module / phase:** `core-ops` · phase **5** · plane **F**  
**Status on tip:** `ready` · **owner:** none  
**Depends on:** `infra.ui-tokens` (**done**) · **requires:** `apps/admin`  
**Tip freeze:** `origin/main` @ `d9e517bd` (re-derive before implement)  
**Pack type:** research only — no invent treasury money; no dual-edit Denon open money PRs; no `features.mjs` edit.

---

## 1 · What “done” means (plain language)

1. An operator opens **`apps/admin`** and sees **live** control-plane state (not React-only theatre).
2. Module kill and ledger freeze **actually stop** commitments / posting on the platform when env + tokens are configured.
3. Fee params, listings, treasury, and other staff tools either call **real** monorepo endpoints **or** refuse with a clear “not wired / simulated” marker — never a green success that only flipped local state.
4. Console is not world-reachable on shared tokens alone: **SSO or network ACL + BFF secret** before real-money exposure.
5. No balances computed in the admin app; no `ledger-client` money movement from the browser plane.
6. Tracker title lists **listings / fee params / treasury / kill-switches** — kill-switch + freeze are the doctrine §14.6 core; listings/fees are a **larger staff product** that must not double-build the vendored admin without a port plan.

---

## 2 · Current code state (tip)

### 2.1 Two admin surfaces (do not conflate)

| Surface                        | Path                                     | Role                                                         |
| ------------------------------ | ---------------------------------------- | ------------------------------------------------------------ |
| **INTAFACED operator console** | `apps/admin` (Next 15, port **3100**)    | §14.6 kill-switch, launch drops, jurisdiction, ledger freeze |
| **Vendored staff admin**       | `vendor/**/04_Web_Admin` (Vue 2 / iView) | Legacy members, withdraw examine, fee manage, OTC, CMS, etc. |

Inventory law: `docs/ADMIN-0-INVENTORY-VENDOR-VS-APPS-2026-08-02.md`.  
**Product rule:** monorepo admin never grows venue SQL or holds balances.

### 2.2 `apps/admin` routes (tip)

| Route           | What                                        | Live?                                                                                                        |
| --------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `/`             | Module kill-switches + control-plane status | **Yes** when `EDGE_URL` + `ADMIN_OPERATOR_TOKEN` — GET/POST `/api/kill-switch` → edge `/admin/kill-switches` |
| `/launch`       | §11 drop table + resolve-at-drop            | Local config resolution (honest for launch matrix)                                                           |
| `/jurisdiction` | Matrix + live `checkAccess()` readout       | Config-backed, not edge money                                                                                |
| `/ledger`       | Freeze / unfreeze / reconcile UI            | Freeze/unfreeze via `/api/ledger-freeze` → edge → ledger; **reconcile still simulated**                      |

BFF routes keep tokens **server-side**. Optional `ADMIN_BFF_SHARED_SECRET` + header `x-intafaced-admin-bff`.

### 2.3 Edge control plane (`services/svc-edge`)

| Path                                | Scope                                | Effect                                                                   |
| ----------------------------------- | ------------------------------------ | ------------------------------------------------------------------------ |
| `/admin/kill-switches`              | `admin:write` + MFA                  | Module disable/enable + audit; only **edge-enforceable** modules armable |
| `/admin/status`                     | same                                 | Operator summary                                                         |
| `/admin/ledger/freeze` · `unfreeze` | `admin:treasury` (+ interactive MFA) | Money-plane posting freeze                                               |

**Honesty already fixed in code comments:** cannot arm modules the edge cannot enforce (e.g. `ws` direct) — refuse with reason, not green theatre.  
Kill guard: new commitments 503; **exit paths** (cancel, futures close) still pass; control plane outside kill guard.  
Restart durability: `EDGE_KILL_STATE_PATH` (per host); **multi-replica share = §13**.

### 2.4 Tests (tracker note is stale)

Older tracker note claimed “ZERO test files / pure useState.” **On tip that is false for the live paths:**

- `apps/admin`: `console-status-banner.test.tsx`, `console-status.test.ts`, `control-plane-client.test.ts`
- `svc-edge`: `admin-api.test.ts`, kill-switch / control-plane tests

**Still true residual:**

- Per-flag rows on kill board: **session-staged** until durable flag store (§13).
- `operator-commands.ts`: **only reconcile** remains simulated (freeze stubs deleted on purpose; type forces `simulated` + notice string).
- **No operator SSO** in the app itself.
- **No** monorepo listings / fee-edit / full treasury UI (beyond freeze).
- Tracker status still `ready` (not `done`) — correct relative to full title.
- Tracker **note** still claims pure useState — **stale**; honesty PR is free Class N residual.

### 2.5 Open PR awareness (re-derive)

Denon/config work has historically touched kill-switch board / vitest. Before implementing admin UI: `gh pr list`, path intersect, do not dual-edit.

---

## 3 · Doctrine constraints

| Law                       | Implication                                                                                          |
| ------------------------- | ---------------------------------------------------------------------------------------------------- |
| §14.6                     | Admin controls: kill-switch + config surface in `apps/admin`                                         |
| §0.6                      | No value movement outside ledger recipes; admin issues **commands**, does not post entries itself    |
| No fabricated money       | Simulated reconcile must stay labeled; zeros only until real route                                   |
| Fail closed               | Kill undecidable → refuse new work; freeze friction proportional to blast radius                     |
| Scopes                    | `admin:write` ≠ `admin:treasury`; never mint admin scopes on normal sessions                         |
| Agent protocol            | Edge vs admin vs ledger = **separate PRs** when wiring new routes (reconcile needs edge route first) |
| Class X                   | Production SSO, token issuance, who may hold `admin:treasury`                                        |
| Shehzad / money mountains | Fee/treasury product law and bank/pay money paths are not free craft under this research             |

---

## 4 · DoD sketch (checkable — staged)

### Stage 1 — §14.6 control plane (near residual)

- [ ] Kill + freeze documented runbook followed in a real staging env (`docs/OPS-KILL-SWITCH-RUNBOOK.md`).
- [ ] Console status banner never looks “all green” when tokens missing.
- [ ] Reconcile either: (a) edge route + BFF + live numbers, or (b) remains simulated with permanent marker — no half-wire.
- [ ] BFF secret or SSO required for any non-localhost exposure with money authority.
- [ ] Multi-edge kill share decision recorded (§13 or real store).
- [ ] Tracker note rewritten so agents do not re-implement theatre that already ships.

### Stage 2 — staff product slices (after Stage 1 + SoT decision)

- [ ] Explicit SoT: which screens stay on vendor admin vs port to `apps/admin`.
- [ ] First money-adjacent staff screen (e.g. withdraw examine or fee read-only) uses **contracts/events + ledger recipes**, dual-book honesty, Class M audit if money.
- [ ] Fee **edit** only after fee schedule ownership is clear (config vs trade service) — no invent.
- [ ] Listings (markets enable/disable) align with existing trade/venue kill paths — no second switch.

### Tracker `done` bar

Flip only when Stage 1 is production-safe **and** product accepts Stage 2 scope (or cuts listings/fees to separate tracker rows). Current single row title is **broader than code**; prefer splitting in a future mountain event rather than lying with `done`.

---

## 5 · Open questions

1. **SSO provider / IdP** for operators (Class X).
2. **Who mints** `admin:write` / `admin:treasury` tokens in ops practice?
3. **Flag store** design for durable per-flag overrides (today session-staged).
4. **Reconcile priority** vs other residual — needs edge PR + money self-audit.
5. **Vendor admin retirement plan** — port order for FeeManage / WithdrawalsExamine / members (ADMIN-0 phases A1–A2).
6. **Listings** meaning: market list CRUD vs venue enable vs CMS — product law.
7. **Treasury UI** beyond freeze: transfers, hot/cold ops? Custody runbook vs this app.

---

## 6 · Gaps (named)

1. Ledger reconcile: no edge proxy → still simulated in `operator-commands.ts`.
2. Durable remote flag store (§13) for kill board rows.
3. Operator SSO absent.
4. Listings / fee-edit / full treasury not in monorepo console.
5. Stale tracker note misleads residual swarms.

---

## 7 · Risks

| Risk                                 | Why it hurts                      |
| ------------------------------------ | --------------------------------- |
| Fake freeze / kill in UI only        | Operators believe platform halted |
| Reconcile without `simulated` marker | Fabricated money report           |
| World-open admin with treasury scope | Class X incident                  |
| Port FeeManage without SoT           | Dual admin + invent fee schedules |
| Dual-edit Denon kill board           | Merge conflict / doctrine drift   |

---

## 8 · Estimated size

| Slice                                              | Size           | Notes                                                             |
| -------------------------------------------------- | -------------- | ----------------------------------------------------------------- |
| Docs/runbook + console honesty polish              | **XS** Class N | Already largely written                                           |
| Tracker note honesty                               | **XS** Class N | Separate mountain event if editing features.mjs                   |
| Edge `ledger.reconcile` proxy + admin BFF + unstub | **S–M**        | Two services if strict one-service-per-PR: edge first, then admin |
| Durable flag store + board                         | **M**          | §13 product                                                       |
| Operator SSO                                       | **M–L**        | Class X / infra                                                   |
| Port one vendor finance screen to monorepo         | **L**          | Class M if money; contracts first                                 |
| Full fee + listings + treasury product             | **XL**         | Multi-PR program; Denon direction for product law                 |

**First implement PR (when free):** **S** — edge reconcile route **or** admin-only residual that cannot invent money (freeze already live; ban any path that reintroduces fake freeze). Prefer **reconcile wire** only with green money tests. **No** FeeManage port without SoT decision.

**Human blockers:** secrets, SSO, production exposure ACL — not agent-mergeable as Class X.

---

## 9 · Related docs / code

- `apps/admin/README.md`
- `docs/OPS-KILL-SWITCH-RUNBOOK.md`
- `docs/ADMIN-0-INVENTORY-VENDOR-VS-APPS-2026-08-02.md`
- `services/svc-edge/src/admin-api.ts`, `kill-switch.ts`, `control-plane.ts`
- `apps/admin/src/lib/operator-commands.ts` (reconcile residual law)
- Sister long-form: `TRK-ops.admin.md`

---

## 10 · Explicit non-goals for this pack

- No inventing fee schedules or treasury balances.
- No port of vendor withdraw examine without Class M + contracts.
- No Shehzad lane implement under admin UI.
- No tracker ownership flip from research.
- No dual-edit of open Denon PRs that rewrite kill-switch board / config flags without path claim.
