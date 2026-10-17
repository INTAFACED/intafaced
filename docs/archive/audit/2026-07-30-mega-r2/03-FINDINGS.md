# 03-FINDINGS — live residual table (mega-r2)

**Rule:** after every fix lands, rewrite this table so fixed items are not still BROKEN.

## Findings (this run + prior #176 status on tip)

| id                  | layer   | file:line                   | claim                             | severity | evidence                 | status                                  |
| ------------------- | ------- | --------------------------- | --------------------------------- | -------- | ------------------------ | --------------------------------------- |
| BRAND-1             | L9/L0   | plan overlay                | model-provider name failed brand  | P0       | #176                     | **FIXED on tip**                        |
| M1                  | L10     | trade 0001/0002             | edit-in-place migration           | P0       | #176 0002                | **FIXED on tip**                        |
| FMT-1               | L0      | prettier                    | format red                        | P1       | #176                     | **FIXED on tip**                        |
| R5                  | L3      | trade-service subAccountId  | ungated sub-account               | P1       | fail-closed              | **FIXED on tip**                        |
| R6                  | L3      | private-rest cost           | market buy cost "0"               | P1       | protectionPrice          | **FIXED on tip** (sell residual)        |
| WS-JWT              | L5/L7   | compose svc-ws              | JWT missing in fleet              | P1       | #176 compose             | **FIXED on tip**                        |
| R7                  | L8      | scoreboards                 | free-mountains fossils            | P2       | #176 docs                | **FIXED on tip**                        |
| **FMT-2**           | L0      | docs from #175              | format red after mid-run tip      | **P1**   | prettier                 | **FIXED this run**                      |
| **L7-EQUITY-STALE** | L7      | `apps/web/.../terminal.tsx` | UI claimed no balance read exists | **P1**   | balance REST #145 exists | **FIXED this run** (honest socket copy) |
| L3-7b               | L3      | private-rest cost           | market sell cost still "0"        | residual | no fill avg              | **OPEN residual**                       |
| StreamA             | tooling | uiproof                     | PROOF/Chromium                    | residual | no artifacts             | **UNVERIFIED**                          |
| ledger-client       | L1      | —                           | 0 files in cook delta             | info     | good                     | —                                       |

## Residual verdicts (V2 §6 + overlay) — re-verified this tip

| #   | Item                                     | Verdict                                                                           |
| --- | ---------------------------------------- | --------------------------------------------------------------------------------- |
| 1   | Balance self-only                        | **HOLDS** CODE-REVIEWED + UNIT (no DB)                                            |
| 2   | Convert kill-switch/hold                 | **HOLDS** CODE-REVIEWED (+ UNIT in SKIPPED-MONEY-SUITE)                           |
| 3   | Pay checkout no card invent              | **HOLDS** CODE-REVIEWED                                                           |
| 4   | subAccounts.revoke soft only             | **HOLDS**                                                                         |
| 5   | subAccountId gate on placeOrder          | **HOLDS** fail-closed (`trade.sub_account_ungated`); ownership S2S later residual |
| 6   | Market order cost when price null        | **HOLDS** for market BUY; **OPEN residual** for market SELL                       |
| 7   | Free mountains stale                     | **HOLDS** fossilized in #176                                                      |
| 8   | Migration M1 post-#167                   | **HOLDS** via `0002_display_name_backfill`                                        |
| 9   | Factory honesty                          | **HOLDS**                                                                         |
| 10  | OHLCV [] + positions []                  | **HOLDS** honest empty                                                            |
| 11  | Notify fan-out / p2pDisputeResolved skip | **HOLDS** (intentional)                                                           |
| 12  | events catalog                           | **HOLDS**                                                                         |
| +   | Stream A / uiproof PROOF                 | **CANNOT VERIFY**                                                                 |
| +   | Terminal equity honesty                  | **HOLDS** after L7-EQUITY fix (panel not wired; API exists)                       |
| +   | Actions billing                          | **CANNOT VERIFY green**                                                           |
| +   | Dual-book policy                         | **OPEN** habit residual                                                           |

## L3 language (mandatory)

All money paths: **CODE-REVIEWED + UNIT (no DB)** / **SKIPPED-MONEY-SUITE** for named PG files. **Never MONEY VERIFIED E2E.**

## New agent-fixable P0 this run

**None.**

## New agent-fixable P1 this run

| id              | action                                  |
| --------------- | --------------------------------------- |
| L7-EQUITY-STALE | rewrite terminal socket copy — **done** |

## GATE-3

All layers judged; residual table current → **PASS**.
