# ADMIN-0 inventory — `04_Web_Admin` vs `apps/admin`

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Date:** 2026-08-02  
**Tip base:** `26289f3` (re-derive at read)  
**Slice:** LAW / ADMIN inventory only — **no product UI rewrite in this doc**  
**Law:** Stream A trader foundation first; staff console is a separate plane (AOS ADMIN wave).

---

## 1 · Two admin surfaces (do not conflate)

| Surface                             | Path                    | Stack                                            | Port (dev)           | Role                                                                                        |
| ----------------------------------- | ----------------------- | ------------------------------------------------ | -------------------- | ------------------------------------------------------------------------------------------- |
| **Vendored exchange staff console** | `vendor/*/04_Web_Admin` | Vue 2 · webpack · **iView 2** (iview-admin fork) | webpack-dev (legacy) | Venue-era ops: members, OTC, finance examine, CMS content, red envelopes, etc.              |
| **INTAFACED operator console**      | `apps/admin`            | Next 15 · React 19 · monorepo tokens             | **3100**             | Doctrine §14.6: kill-switches, launch drops, jurisdiction, ledger freeze/reconcile friction |

**Product rule:** `apps/admin` **must not** grow venue SQL or hold balances. Money moves only via ledger recipes / control-plane commands.

---

## 2 · `apps/admin` inventory (present)

| Route           | Component / lib          | Live wire                                         | Residual honesty                                                      |
| --------------- | ------------------------ | ------------------------------------------------- | --------------------------------------------------------------------- |
| `/`             | `kill-switch-board.tsx`  | GET/POST kill-switch via edge when env tokens set | Per-flag staging still partial (flag store)                           |
| `/launch`       | `launch-sequence.tsx`    | Drop table + resolve-at-drop                      | —                                                                     |
| `/jurisdiction` | `jurisdiction-board.tsx` | Matrix + `checkAccess` readout                    | —                                                                     |
| `/ledger`       | `ledger-ops.tsx`         | Freeze/unfreeze path                              | **Reconcile still stubbed** in `operator-commands.ts` (README admits) |
| APIs            | `app/api/*`              | edge + tokens                                     | Requires `EDGE_URL` + operator tokens                                 |

**Doctrine bar (already enforced in README):** no ledger-client imports; no balance math; no hex palette drift.

---

## 3 · `04_Web_Admin` inventory (present)

**~84 Vue views** under `src/views/` (domain folders):

| Domain                                          | Vue files (approx) | Examples (money / risk relevant)                                                                                                       |
| ----------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| **finance**                                     | 8                  | `WithdrawalsExamine`, `WithdrawDetail`, `FeeManage`, `ChargeCoinDetail`, `TradeDetail`, `OtcDetail`, `FinanceStatistic`, `AuditDetail` |
| **member**                                      | 8                  | `MemberAsset`, `MemberDetail`, `memberManage`, `RechargeList`, `DrawList`, `Authenticate*`                                             |
| **otc**                                         | 10                 | OTC staff flows (ads/orders — re-open files before any port)                                                                           |
| **exchange**                                    | 3                  | `Order`, `OrderDetail`, `Setting`                                                                                                      |
| **system**                                      | 10                 | staff users, roles, config                                                                                                             |
| **content**                                     | 5                  | CMS / announcements                                                                                                                    |
| **ctc**                                         | 2                  | C2C staff                                                                                                                              |
| **activity / bond / invitation / redenvelope**  | misc               | marketing ops                                                                                                                          |
| **home / user / own-space / error-page / main** | shell              | login + layout                                                                                                                         |

**Stack facts**

- Package name `admins` · iview-admin lineage · Vue 2 / webpack
- Chinese install notes on disk (`安装手册.txt`) — not product law
- Speaks to **legacy backend HTTP**, not monorepo svc-edge tRPC

---

## 4 · Overlap / collision map

| Capability                | Vendored admin            | apps/admin         | Decision                                                                |
| ------------------------- | ------------------------- | ------------------ | ----------------------------------------------------------------------- |
| Kill-switch / launch drop | No modern equivalent      | **Owns**           | Keep only in apps/admin                                                 |
| Ledger freeze             | No monorepo ledger        | **Owns** (partial) | Finish reconcile stub later — **not** Stream A shell                    |
| Member KYC examine        | `member/*` + authenticate | None               | Stay vendor until identity staff UX is designed                         |
| Withdraw examine          | `finance/Withdrawals*`    | None               | **High risk** — any rebuild must use ledger recipes + dual-book honesty |
| Fee schedule staff edit   | `finance/FeeManage`       | None               | Vendor for now; trader desk only _displays_ venue fee                   |
| Spot order cancel staff   | `exchange/Order*`         | None               | Collision risk with order-route — **do not double-build**               |
| OTC staff                 | `otc/*`                   | None               | Vendor until OTC program claims                                         |
| CMS / announcements       | `content/*`               | None               | B12 marketing craft on trader shell first; staff later                  |

---

## 5 · Recommended program (after trader A foundation)

| Phase       | Work                                                                                                         | Owner plane       |
| ----------- | ------------------------------------------------------------------------------------------------------------ | ----------------- |
| **A0 done** | This inventory                                                                                               | docs              |
| **A1**      | Wire remaining apps/admin stubs (reconcile) with second-pass money audit                                     | `apps/admin` only |
| **A2**      | Per-module staff screens that **must** move: withdraw examine, fee manage — port one at a time via contracts | monorepo + edge   |
| **A3**      | Quarantine / do-not-boot path for unused vendor admin modules                                                | vendor            |
| **Never**   | Import 04_Web_Admin wholesale into Next                                                                      | —                 |

**Stream A (trader `:8090`) must not implement staff money examine inside `05_Web_Front`.**

---

## 6 · Hard blocks

1. Do not connect `04_Web_Admin` webpack to monorepo services without edge auth.
2. Do not store balances in apps/admin session state.
3. Do not “improve” vendor FeeManage while order-route residual PRs own trade path CI.
4. Nitro is not the runner for admin port decisions beyond product priority.

---

## 7 · Residual register stamp

| ID          | Status after this doc                                           |
| ----------- | --------------------------------------------------------------- |
| **ADMIN-0** | **done** — evidence path = this file                            |
| ADMIN-1+    | open — not created as residual items yet; use A1–A3 table above |

---

## 8 · How to re-derive

```bash
find vendor/*/04_Web_Admin/src/views -name '*.vue' | wc -l
find apps/admin/src -name '*.tsx'
pnpm --filter @intafaced/admin typecheck
```
