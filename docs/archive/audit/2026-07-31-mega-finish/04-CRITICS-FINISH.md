# 04 — Critics on finish residual set

**Role:** finish-fire maker-checker (assume wrong until held with evidence)  
**UTC:** 2026-07-31

| id                       | Claim                                 | Critic                                                                        | Disposition                      |
| ------------------------ | ------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------- |
| M226-01                  | MemoryBroadcastStore P0 multi-replica | **ACCEPT hold** — #266 owns durable journal; competing implement is collision | **#266 babysit** · residual pack |
| M226-02                  | Refund sequence key P1                | **ACCEPT hold** — RailAdapter surface Class M; not silent one-liner           | residual pack                    |
| M226-03                  | Watcher mark-before-2xx               | **CLOSED** #252                                                               | done                             |
| M226-04                  | First-tx dust P1                      | **ACCEPT hold product**                                                       | residual pack                    |
| B-01 bank shortfall      | outstanding zero without insurance    | **CLOSED** #252 + critic follow-up                                            | done                             |
| B-02 reconcile tautology | drift always 0                        | **ACCEPT hold** until journal/funding table                                   | residual pack                    |
| P2P-01 funds rehydrate   | typed error lost on HTTP              | **CLOSED** #254–#255                                                          | done                             |
| T-02 token_params        | code defaults live                    | **CLOSED** #257                                                               | done                             |
| T-04 bank S2S body       | v1 headers                            | **CLOSED** #257                                                               | done                             |
| T-01 buyback market      | operator burn not structural          | **ACCEPT hold product**                                                       | residual T-01 note               |
| ID-P1-2 freeze refresh   | refresh ignores status                | **CLOSED** #258–#259                                                          | done                             |
| ID-P1-1 recovery codes   | codes not stored/redeemed             | **FIX this fire** — hashed store + redeem                                     | implement                        |
| Stress PG e2e            | local money suites                    | **BLOCKED** host no Postgres/Docker                                           | skip ledger + CI note            |
| R4 smart-accounts done   |                                       | **HOLD** research pack only; prod chain D1                                    | research pack                    |

## Stress honesty

Local stress/e2e **cannot** complete without Postgres/anvil. Finish does **not** pretend otherwise. CI success on recent main product tips is recorded as fleet proof separate from local skip ledger.
