# 02-DELTA — surface inventory (mega-r2)

**Range (cook):** `8a8c19bc626e6dada49a33be1f88d17873f42502` .. `6dd3defec668e2dfc07042d39c0e8eab9672e248`  
**Commits (cook):** **67** · #110–#177  
**Last PEACE-audited tip:** `d926edfc6479dcb0f8babe226415cf60992b130c` (#176)  
**Worktree tip:** `6dd3def` = #177

## 1) Surface table (diff-derived — no silent drops)

| Surface                      | file count | money?       | auth?           | deploy?     | migration?     | judged-by       | notes                                                |
| ---------------------------- | ---------: | ------------ | --------------- | ----------- | -------------- | --------------- | ---------------------------------------------------- |
| `services/svc-notify`        |         16 | no           | yes             | yes         | yes 0000       | L2/L5/L6        | inbox + bus fans                                     |
| `services/svc-trade`         |         11 | **yes**      | yes             | no          | 0001+#176 0002 | L1/L3/L10       | convert, private REST, honesty routes                |
| `services/svc-pay`           |          9 | **yes**      | merchant+public | no          | 0002 links     | L3/L6           | links + hosted checkout                              |
| `tooling/**`                 |          9 | no           | no              | tooling     | postgres-init  | L8/StreamA      | tracker, uiproof                                     |
| `services/svc-identity`      |          8 | no           | **yes**         | no          | 0002 revoke    | L2              | ifc\_ exchange, subAccounts                          |
| `services/svc-ws`            |          7 | no           | JWT private     | yes JWT env | no             | L2/L5/L7        | private stream + public tape                         |
| `services/svc-edge`          |          6 | no           | ifc\_+JWT       | yes         | no             | L2/L5           | /api/v1 preservePath                                 |
| `apps/web`                   |         6+ | no           | UI              | no          | no             | L6/L7           | tape + terminal honesty (**L7-EQUITY fix this run**) |
| `docs/**`                    |         37 | n/a          | n/a             | n/a         | n/a            | L9              | archive + PEACE                                      |
| `vendor/**`                  |          4 | dual-book UI | no              | no          | no             | L4/L9           | UI only not books                                    |
| `services/svc-token`         |          3 | **yes**      | operator        | no          | no             | L3              | yield/buyback                                        |
| `packages/config`            |          3 | no           | no              | no          | no             | L5              | env/flags                                            |
| `services/svc-protocol`      |          2 | no           | no              | no          | no             | L4              | factory honesty                                      |
| `packages/i18n`              |          2 | no           | no              | no          | no             | L9              | notify keys                                          |
| `packages/events`            |          1 | bus          | no              | no          | no             | L11 residual 12 | orderUpdated/fillSettled                             |
| `packages/auth`              |          1 | no           | **yes**         | no          | no             | L2              | scopes                                               |
| `Dockerfile`                 |          1 | no           | no              | **yes**     | no             | L5              | notify COPY                                          |
| `docker-compose.apps.yml`    |          1 | no           | JWT ws          | **yes**     | no             | L5              | notify + WS JWT                                      |
| `pnpm-lock.yaml`             |          1 | supply       | no              | no          | no             | L11             | Playwright family                                    |
| `package.json`               |          1 | no           | no              | no          | no             | StreamA         | ui:boot/ui:proof                                     |
| `README.md` / `.gitignore`   |          2 | n/a          | n/a             | n/a         | n/a            | n/a             | —                                                    |
| **`packages/ledger-client`** |      **0** | —            | —               | —           | —              | L1              | **stated: good news**                                |

## 2) Migrations (all judged)

| Migration                                  | L10 verdict                                    |
| ------------------------------------------ | ---------------------------------------------- |
| identity `0002_sub_accounts_revoke` + down | HOLDS soft-revoke                              |
| notify `0000_notify_init` + down           | HOLDS new service                              |
| pay `0002_pay_payment_links` + down        | HOLDS                                          |
| trade `0001_multi_asset_instruments`       | **edited in place by #167** — runner name-only |
| trade `0002_display_name_backfill` + down  | **HOLDS** — #176 fix for already-migrated DBs  |

**M1 answer:** Applied migration edited in place does not re-run; `0002` is the correct repair. Present on tip.

## 3) Lockfile new third-parties

`@playwright/test@1.62.0` (+ playwright, playwright-core) for Stream A. No novel money deps.

## 4) Events catalog

`orderUpdated`, `fillSettled` in catalog. No missing publisher subjects found.

## 5) New since last audit `d926edf..TIP`

1 commit: `6dd3def` #177 docs only (PEACE tip SHA). **No product code.**

## GATE-2

Every surface named and assigned a judgment layer → **PASS**.

## Tip moved mid-run

After Phase 0 freeze, origin advanced:

| SHA       | PR   | files                                                                  |
| --------- | ---- | ---------------------------------------------------------------------- |
| `d92e121` | #175 | `docs/NITRO-AGENT-PACKAGES-2026-07-30.md`, `tooling/ci/brand-scan.mjs` |
| `3687475` | #178 | grind/scoreboard high water docs                                       |

Judged: **docs + brand allowlist only** — not money/auth/migrate. Brand re-run green after rebase.
