# LANE-STOP L02 ACADEMY · wave 5 · 2026-08-09

## Shipped (PRs — merge when CI green, serial if path-conflict)

| PR                                                            | Plain words                                                                                         | Class | Units                                                       |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----- | ----------------------------------------------------------- |
| [#1368](https://github.com/Phantom-X-007/intafaced/pull/1368) | Same fill id cannot inflate paper PnL; valuation carries simulated seal nested                      | N     | P1 fillId conflict + P2 idempotent honesty + P3 nested seal |
| [#1369](https://github.com/Phantom-X-007/intafaced/pull/1369) | Operators can bulk-score a live season; freeze stores ranked audit snapshot                         | N     | T3 bulk wire + T2 durable freeze snapshot                   |
| [#1370](https://github.com/Phantom-X-007/intafaced/pull/1370) | Cert required lessons must exist on curriculum; enroll only Blueprint paths; depth floor docs = 900 | N     | U5 spine gate + U3 enroll + U7/U12 docs honesty             |
| [#1371](https://github.com/Phantom-X-007/intafaced/pull/1371) | Ambassador pay plane stays dark on the wire; no ledger import in ambassadors                        | N     | A1 mount refuse + A2 ledger isolation scan                  |

**Local proof before push (sample):** paper **524** tests; bulk **522**; certs **525**; amb **528** — all typecheck clean on branch.

**Merge order (path safety):** prefer **#1371 → #1370 → #1368 → #1369** (amb tests-only first; then certs/service; then paper router; then tournament bulk+freeze). Or serial squash when green.

## A0 babysit

No open academy PRs at wave-5 start. W4 #1254–#1260 + stop #1302 already on tip. Sealed: paper isolation / curriculum honesty not regressed.

## Engine A — units this cook (≥8)

| #   | Unit                          | Done bar                                                   | Disposition       |
| --- | ----------------------------- | ---------------------------------------------------------- | ----------------- |
| 1   | Paper fillId conflict         | same id different body → `bad_fill`                        | **shipped #1368** |
| 2   | Paper fillId dedupe valuation | fillCount unique; no inflate                               | **shipped #1368** |
| 3   | Nested valuation seal         | seal literals on valuation object                          | **shipped #1368** |
| 4   | Bulk score on wire            | `bulkSetStandings` admin + refuse empty/dup/not-live       | **shipped #1369** |
| 5   | Durable freeze snapshot       | live→frozen writes `tournament_freeze_snapshots`; read API | **shipped #1369** |
| 6   | Cert ↔ spine integrity        | every requiredItemSlug ∈ curriculum                        | **shipped #1370** |
| 7   | Enroll Blueprint paths only   | invent pathSlug refuses                                    | **shipped #1370** |
| 8   | Depth floor docs honesty      | README/comments say 900 not 40                             | **shipped #1370** |
| 9   | Ambassador pay mount RED      | plane dark + PRECONDITION_FAILED                           | **shipped #1371** |
| 10  | Ambassadors ledger scan       | no recipes/LedgerClient in ambassadors                     | **shipped #1371** |

## Engine B — promise falsification matrix (tip + this wave)

| Domain             | Claim                                 | Verdict                             | Residual                         |
| ------------------ | ------------------------------------- | ----------------------------------- | -------------------------------- |
| Lobbies            | free/staked/invite + host fail-closed | **HOLDS**                           | Stake TOCTOU accepted            |
| Stream/video       | LiveKit v1                            | **REFUSE-CLOSED** (`provider=none`) | SFU deploy = product             |
| Curriculum count   | 20 pb + 3 wb platform-native          | **HOLDS**                           | Licensed DERIV Class X           |
| Curriculum depth   | floor 900, thinSlugs=[]               | **HOLDS** + docs fixed #1370        | —                                |
| Paper isolation    | no real ledger                        | **HOLDS** + fill honesty #1368      | `market.paper` multi-svc         |
| Paper labels       | cannot read as live money             | **HOLDS** + nested seal #1368       | —                                |
| Certs progress     | durable grant + XP                    | **HOLDS**                           | Self-asserted complete (product) |
| Certs XP double    | idempotent key                        | **HOLDS**                           | No outbox                        |
| Certs perks        | real perks                            | **Indirect** via rank only          | Correct non-map                  |
| Ambassadors        | status + unfreeze                     | **HOLDS** + mount pay refuse #1371  | Shell badge L11                  |
| Ambassador IFC     | pay programme                         | **REFUSE-CLOSED** + mount proven    | Nitro rates Class M/X            |
| Residencies        | applications                          | **HOLDS** durable                   | Seasons/KPIs Nitro               |
| Tournaments ladder | seasonal ladders                      | **HOLDS** + bulk wire #1369         | Score source product law         |
| Tournament prizes  | IFC pools                             | **REFUSE-CLOSED**                   | Class M recipes                  |
| Freeze audit       | snapshot at freeze                    | **HOLDS** durable #1369             | —                                |
| Spatial scene      | size + edit policy                    | **HOLDS**                           | Shell canvas L11                 |
| Rank host gate     | Rank 4+ hosts                         | **HOLDS** S2S                       | —                                |
| crew-events        | Class B close                         | **NOT WIRED** (honest)              | Bus mount ADR D-S-13             |

## Engine C — attack surface

| Surface               | Status after wave 5                                                            |
| --------------------- | ------------------------------------------------------------------------------ |
| Tier gates            | Fail-closed stake + host                                                       |
| Paper flags           | Trust gap known (`market.paper` caller); no ledger post; fillId inflate closed |
| Prize config          | Refuse-closed on wire                                                          |
| XP double-award       | Business key + identity dedupe                                                 |
| Freeze re-rank        | Illegal edges + durable freeze snapshot                                        |
| Ghost XP policy       | markets-v1 removed; spine gate on required slugs                               |
| Ambassador pay invent | Mount RED + source scan                                                        |

## In flight

CI babysit → squash-merge #1368–#1371 when green (serial on `router.ts` / `academy-service.ts` conflicts).

## Parked (pick-up)

1. **market.paper verify** — needs trade market read via `packages/contracts` (multi-service)
2. **IFC pay rates / residency economics / prize amounts** — Nitro §8 only (Class M/X)
3. **Shell canvas product** — L11 wall
4. **crew-events bus mount** — owner ADR D-S-13
5. **markets/builder/sovereign cert shells** — only with product law for XP amounts
6. **Video SFU / stored video library** — infra + keys
7. **Self-asserted curriculum complete** — product: exam gate or document as law
8. **Certs tracker WIP ghost** (`owner: nitro-agent`, title “→ real perks”) — mountain event: retitle to “→ XP” or keep WIP until identity perk surface; not falsely `done`
9. **Curriculum/tournaments/spatial tracker status MISSING** — honesty pass (L15 or mountain event)
10. **Score auto from paper/live trade** — product law residual
11. **XP outbox/sweep** — recovery today = re-call grantCert

## Nitro must decide

**none** for the Class N units above.

Class M/X only if he wants: IFC rates, prize funding source, residency pay, licensed curriculum rename-or-import, exam vs self-assert complete.

## SAFE TO CLOSE

**yes for this cook** once #1368–#1371 are merged or parked with pick-up — wall residual is Nitro-only money, multi-service contracts, L11 shell, or SFU/infra.

tip: re-derive `git log -1 --oneline origin/main` after merges.
