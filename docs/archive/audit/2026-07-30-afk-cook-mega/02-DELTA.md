# 02-DELTA — surface inventory

**Range:** `8a8c19bc626e6dada49a33be1f88d17873f42502` .. `2d1582143b0c1a95e8250a2f53f68fa71eb6b9ad`  
**Commits:** 65 · includes Stream A #169/#172 + plan #174

## Surface table (diff-derived — no silent drops)

| Surface                      | Files | PRs (representative)              | money?       | auth?                   | deploy? | migration?        | judged-by             |
| ---------------------------- | ----- | --------------------------------- | ------------ | ----------------------- | ------- | ----------------- | --------------------- |
| `services/svc-notify`        | 16    | #129,#134,#148,#150,#156,#157     | no           | yes (edge principal)    | yes     | **yes** 0000      | L5/L6/L8/R11          |
| `services/svc-trade`         | 9     | #123–#147,#154,#163,#167          | **yes**      | yes                     | no      | **yes** 0001 edit | L1–L3/L10             |
| `services/svc-pay`           | 9     | #120,#124,#139                    | **yes**      | merchant + public token | no      | **yes** 0002      | L3/L6                 |
| `services/svc-identity`      | 8     | #113,#116,#158                    | no           | **yes**                 | no      | **yes** 0002      | L2/R4/R5              |
| `services/svc-ws`            | 7     | #119,#122                         | no           | **yes** JWT private     | yes     | no                | L5/L7                 |
| `services/svc-edge`          | 6     | #114                              | no           | **yes** ifc\_           | yes     | no                | L2/L5                 |
| `apps/web`                   | 6     | #162                              | no           | no                      | no      | no                | L7                    |
| `vendor/**`                  | 4     | brand/i18n scrub                  | dual-book UI | no                      | no      | no                | L4/L9                 |
| `tooling/**`                 | 9     | tracker, migrate-all, **uiproof** | no           | no                      | tooling | schema init       | L8/L11/A              |
| `services/svc-token`         | 3     | #112                              | **yes**      | operator                | no      | no                | L3                    |
| `packages/config`            | 3     | flags/modules                     | no           | no                      | no      | no                | L1 sample             |
| `services/svc-protocol`      | 2     | #128                              | no           | no                      | no      | no                | L4                    |
| `packages/i18n`              | 2     | notify keys                       | no           | no                      | no      | no                | L9                    |
| `packages/events`            | 1     | catalog                           | bus          | no                      | no      | no                | R12                   |
| `packages/auth`              | 1     | scopes                            | no           | **yes**                 | no      | no                | L2                    |
| `Dockerfile` (root)          | 1     | notify in image                   | no           | no                      | **yes** | no                | L5                    |
| `docker-compose.apps.yml`    | 1     | notify + fleet                    | no           | JWT gap                 | **yes** | no                | L5                    |
| `pnpm-lock.yaml`             | 1     | playwright                        | supply       | no                      | no      | no                | L11                   |
| `package.json`               | 1     | ui:boot/proof                     | no           | no                      | no      | no                | Stream A              |
| `docs/**`                    | 27    | scoreboards, plans                | n/a          | n/a                     | n/a     | n/a               | L9/R7                 |
| `README.md`, `.gitignore`    | 2     | n/a                               | n/a          | n/a                     | n/a     | n/a               | n/a                   |
| **`packages/ledger-client`** | **0** | —                                 | —            | —                       | —       | —                 | **stated: good news** |

## Migrations (all four + infra)

| File                                                                 | Kind                     | L10                                     |
| -------------------------------------------------------------------- | ------------------------ | --------------------------------------- |
| `services/svc-identity/drizzle/0002_sub_accounts_revoke.sql` (+down) | new                      | additive soft revoke                    |
| `services/svc-notify/drizzle/0000_notify_init.sql` (+down)           | new service init         | paired down                             |
| `services/svc-pay/drizzle/0002_pay_payment_links.sql` (+down)        | new                      | paired down                             |
| `services/svc-trade/drizzle/0001_multi_asset_instruments.sql`        | **edited in place #167** | **M1 P0** — runner name-only, no re-run |
| `tooling/infra/postgres-init/01-service-schemas.sql`                 | notify role              | deploy residual                         |

## Lockfile (L11)

New third-party in cook delta:

- **`@playwright/test@1.62.0`** (+ `playwright` / `playwright-core`) for Stream A `tooling/uiproof`
- First-party workspace importer: `services/svc-notify` (no novel money deps)

## Stream A

#169 boot.mjs + #172 harness on tip. **PROOF/Chromium: UNVERIFIED** (no artifacts; SEGV residual). Not money.
