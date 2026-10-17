# LANE-STOP L02 ACADEMY · wave 4 · 2026-08-09

## Shipped (PRs — merge when CI green)

| PR                                                            | Plain words                                                                               | Class |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----- |
| [#1254](https://github.com/Phantom-X-007/intafaced/pull/1254) | Season status only moves on legal edges; blank prize pools stay refuse-closed on the wire | N     |
| [#1255](https://github.com/Phantom-X-007/intafaced/pull/1255) | XP plane no longer prices markets-v1 (a cert nobody can grant)                            | N     |
| [#1256](https://github.com/Phantom-X-007/intafaced/pull/1256) | Host scene writes use concurrency policy — stale tabs conflict                            | N     |
| [#1258](https://github.com/Phantom-X-007/intafaced/pull/1258) | Import gate refuses thin bodies the depth floor already forbids                           | N     |
| [#1259](https://github.com/Phantom-X-007/intafaced/pull/1259) | Paper isolation scan covers router wire, not only `src/paper`                             | N     |
| [#1260](https://github.com/Phantom-X-007/intafaced/pull/1260) | Unfreeze an ambassador without re-appoint theatre                                         | N     |

Local proof before push (sample): tournament suite **31 files / 509 tests**; certs **505 + typecheck**; spatial **506 + typecheck**; paper isolation **9**; import-pipeline **13**.

## Engine B — promise falsification matrix

| Domain                | Claim                                        | Tip verdict                          | Residual                                |
| --------------------- | -------------------------------------------- | ------------------------------------ | --------------------------------------- |
| Lobbies               | free/staked/invite + host rights fail-closed | **HOLDS**                            | Stake TOCTOU accepted (documented)      |
| Stream/video          | LiveKit v1                                   | **Honest refuse** (`provider=none`)  | SFU deploy = product                    |
| Curriculum count      | 20 playbooks + 3 workbooks                   | **HOLDS** platform-native            | Licensed DERIV residual (title wording) |
| Curriculum depth      | Bodies worth reading                         | **HOLDS** floor 900, `thinSlugs=[]`  | Import floor now matches (#1258)        |
| Paper isolation       | No real ledger                               | **HOLDS** + wire scan (#1259)        | `market.paper` caller-asserted          |
| Paper labels          | Cannot read as live money                    | **HOLDS** seal literals              | Nested valuation optional polish        |
| Certs progress        | Durable grant + XP                           | **HOLDS** SQL + bus degrade          | Self-asserted complete                  |
| Certs XP double       | Idempotent key                               | **HOLDS** identity ON CONFLICT       | No outbox                               |
| Certs perks           | Real perks                                   | **Indirect** via rank only           | No cert→perk map (correct)              |
| Ambassadors programme | Status model                                 | **HOLDS** + unfreeze (#1260)         | Shell badge residual (L11)              |
| Ambassador IFC pay    | Pay programme                                | **Refuse-closed**                    | Nitro rates Class M/X                   |
| Residencies           | Applications                                 | **HOLDS** durable                    | Seasons/KPIs Nitro                      |
| Tournaments ladder    | Seasonal ladders                             | **HOLDS** + lifecycle wire (#1254)   | Score source product law                |
| Tournament prizes     | IFC pools                                    | **Refuse-closed** on wire (#1254)    | Class M recipes                         |
| Spatial scene         | Size gate + schema                           | **HOLDS** + edit policy wire (#1256) | Shell canvas L11                        |
| Rank host gate        | Rank 4+ hosts                                | **HOLDS** S2S createRoom             | —                                       |
| crew-events           | Class B close                                | **NOT WIRED** (honest header)        | Needs bus decision                      |

## Engine C — attack surface

| Surface              | Status after wave                |
| -------------------- | -------------------------------- |
| Tier gates           | Fail-closed stake + host         |
| Paper flags          | Trust gap known; no ledger post  |
| Prize config         | Refuse-closed on wire            |
| XP double-award      | Business key + identity dedupe   |
| Re-rank after freeze | Lifecycle edges enforced (#1254) |
| Ghost XP policy      | markets-v1 removed (#1255)       |

## In flight

CI babysit → squash-merge #1254–#1260 when green (serial if path-conflict on `router.ts` / `academy-service.ts`).

## Parked (pick-up)

1. **market.paper verify** — needs `packages/contracts` trade market read (multi-service)
2. **IFC pay rates / residency economics / prize amounts** — Nitro §8 only (Class M/X)
3. **Shell canvas product** — L11 shell wall, not academy
4. **crew-events bus mount** — owner scope (ADR D-S-13)
5. **markets/builder/sovereign cert shells** — only with product law for multi-path certs (no invent XP amounts)
6. **Durable freeze snapshot table** — optional audit
7. **Bulk score on wire** — Class N residual after lifecycle
8. **Video SFU** — honest refuse until deploy

## Nitro must decide

**none** for the Class N units above.

Class M/X only if he wants: IFC rates, prize funding source, residency pay, licensed curriculum rename-or-import.

## SAFE TO CLOSE

**yes for this cook** once #1254–#1260 are merged or parked with pick-up — wall residual is either Nitro-only money or shell/L11.

tip: re-derive `git log -1 --oneline origin/main` after merges.
