# 03-FINDINGS — live (appended)

| id            | layer   | file:line                                                            | claim                                                                            | severity | evidence                          | fix-owner          |
| ------------- | ------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------- | --------------------------------- | ------------------ |
| BRAND-1       | L9/L0   | `docs/MEGA-AUDIT-PLAN-V2-EXEC-OVERLAY-2026-07-30.md:5,9,14,15,23,69` | Forbidden model-provider name `Claude` fails `scan:brand`                        | **P0**   | L0 brand exit 1 · 6 hits          | agent              |
| M1            | L10     | `svc-trade/scripts/migrate.ts:52-57` + `drizzle/0001_…sql`           | #167 edited applied migration in place; runner name-only; backfill never re-runs | **P0**   | code explorer + migrate.ts        | agent: new `0002`  |
| FMT-1         | L0      | 38 files (identity, notify, pay, protocol, trade, docs)              | `format:check` red                                                               | **P1**   | prettier                          | agent              |
| R5            | L3      | `trade-service.ts:461`                                               | `subAccountId` stored with no ownership/revoked gate                             | **P1**   | no identity consult               | agent: fail-closed |
| R6            | L3      | `private-rest.ts:165-167`                                            | filled market orders present `cost:"0"` when `price===null`                      | **P1**   | presentCcxtOrder                  | agent              |
| WS-JWT        | L5/L7   | `docker-compose.apps.yml` svc-ws env                                 | private stream code needs JWT; compose never sets secret → fleet 403             | **P1**   | env optional → privateTokens=null | agent              |
| R7            | L8      | AFK night + cook scoreboard free-mountains                           | stale “still open” lists                                                         | **P2**   | docs                              | agent docs         |
| L5-4          | L5      | same as WS-JWT                                                       | fleet private WS dead                                                            | **P1**   | = WS-JWT                          | agent              |
| StreamA       | tooling | uiproof                                                              | PROOF UNVERIFIED                                                                 | residual | no artifacts                      | human desktop      |
| ledger-client | L1      | —                                                                    | 0 files in delta                                                                 | info     | good                              | —                  |

## Residual verdicts (V2 §6 + overlay)

| #   | Item                                     | Verdict                                        |
| --- | ---------------------------------------- | ---------------------------------------------- |
| 1   | Balance self-only                        | **HOLDS** CODE-REVIEWED + UNIT                 |
| 2   | Convert kill-switch/hold                 | **HOLDS** CODE-REVIEWED + UNIT (PG suite skip) |
| 3   | Pay checkout no card invent              | **HOLDS**                                      |
| 4   | subAccounts.revoke soft only             | **HOLDS**                                      |
| 5   | subAccountId gate on placeOrder          | **BROKEN (P1)** → fix                          |
| 6   | Market order cost when price null        | **BROKEN (P1)** → fix                          |
| 7   | Free mountains stale                     | **BROKEN (P2)** → fix docs                     |
| 8   | Migration M1 post-#167                   | **BROKEN (P0)** → fix 0002                     |
| 9   | Factory honesty                          | **HOLDS**                                      |
| 10  | OHLCV [] + positions []                  | **HOLDS**                                      |
| 11  | Notify fan-out / p2pDisputeResolved skip | **HOLDS** (intentional)                        |
| 12  | events catalog                           | **HOLDS**                                      |
| +   | Stream A / uiproof                       | **CANNOT VERIFY** PROOF                        |
| +   | subAccountId (above)                     | P1                                             |
| +   | M1 #167                                  | P0                                             |

## L3 language

All money paths: **CODE-REVIEWED + UNIT (no DB)** / **SKIPPED-MONEY-SUITE** for named PG files. Never MONEY VERIFIED E2E.
