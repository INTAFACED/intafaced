# LANE-STOP L02 ACADEMY · wave 6 · 2026-08-09

## Shipped

| PR                                                            | Plain words                                                                          | Class | Units                    |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----- | ------------------------ |
| [#1371](https://github.com/Phantom-X-007/intafaced/pull/1371) | Ambassador pay refuse mount-proven + ledger isolation                                | N     | A0/A2 amb residual       |
| [#1370](https://github.com/Phantom-X-007/intafaced/pull/1370) | Cert required slugs on curriculum spine; enroll Blueprint paths only; depth docs 900 | N     | A1 certs residual        |
| [#1368](https://github.com/Phantom-X-007/intafaced/pull/1368) | Paper fillId cannot double-count / inflate PnL                                       | N     | A2 paper residual        |
| [#1369](https://github.com/Phantom-X-007/intafaced/pull/1369) | Bulk scores on wire + durable freeze snapshots                                       | N     | A1 bulk residual         |
| [#1410](https://github.com/Phantom-X-007/intafaced/pull/1410) | Live seasons cannot score after calendar ends                                        | N     | score window hot path    |
| [#1411](https://github.com/Phantom-X-007/intafaced/pull/1411) | Re-appoint cannot erase frozen ambassador audit                                      | N     | freeze audit residual    |
| [#1423](https://github.com/Phantom-X-007/intafaced/pull/1423) | Session read includes sceneFingerprint                                               | N     | spatial concurrent token |
| [#1424](https://github.com/Phantom-X-007/intafaced/pull/1424) | Pin crew unmounted + NullStream refuse                                               | N     | park honesty             |

**Merge note:** #1368–#1371 rebased onto tip (pay G4 fixture red was sibling, not academy) then squash-merged. Tip at wave-6 bank of those four: `0282c94d` bulk scores.

## A0 babysit

Open academy red at wave-6 start was monorepo `svc-pay` fixture shape (`0xg4finish`), not academy suite (33/33 academy green in CI). Rebase onto tip fixed Tests. W5 stop #1375 already on tip.

## Engine A — units this cook (≥8)

| #   | Unit                      | Done bar                      | Disposition      |
| --- | ------------------------- | ----------------------------- | ---------------- |
| 1   | Open PR merge amb         | green                         | **merged #1371** |
| 2   | Cert required slugs       | spine integrity               | **merged #1370** |
| 3   | Bulk scores durable       | wire + freeze snapshot        | **merged #1369** |
| 4   | Paper fillId honesty      | no inflate same id            | **merged #1368** |
| 5   | Score calendar gate       | live after endsAt refuses     | **#1410**        |
| 6   | Appoint freeze audit      | re-appoint refuses frozen     | **#1411**        |
| 7   | Session sceneFingerprint  | read returns token            | **#1423**        |
| 8   | Crew-events unmounted pin | index never subscribes        | **#1424**        |
| 9   | Video SFU park pin        | NullStream refuses credential | **#1424**        |
| 10  | Engine B matrix           | this stop                     | **complete**     |

## Engine B — promise falsification matrix

| Domain                   | Claim                                 | Verdict                                 | Residual                                              |
| ------------------------ | ------------------------------------- | --------------------------------------- | ----------------------------------------------------- |
| Lobbies                  | free/staked/invite + host fail-closed | **HOLDS**                               | Stake TOCTOU accepted; capacity race harness optional |
| Stream/video             | LiveKit v1                            | **REFUSE-CLOSED** + park pin            | SFU deploy = product/infra                            |
| Curriculum count/depth   | 20+3, floor 900                       | **HOLDS**                               | Licensed DERIV Class X                                |
| Paper isolation / labels | no ledger; sealed                     | **HOLDS** + fillId #1368                | `market.paper` multi-svc                              |
| Certs spine / enroll     | required slugs + Blueprint            | **HOLDS** #1370                         | Self-assert complete product                          |
| Certs XP double          | business key                          | **HOLDS**                               | No outbox; recovery = re-grant                        |
| Ambassadors              | status + unfreeze                     | **HOLDS** + freeze audit #1411          | Shell badge L11                                       |
| Ambassador IFC           | pay                                   | **REFUSE-CLOSED** #1371                 | Nitro rates Class M/X                                 |
| Tournaments ladder       | seasons/scores                        | **HOLDS** + bulk #1369 + calendar #1410 | Score source product law                              |
| Tournament prizes        | IFC pools                             | **REFUSE-CLOSED**                       | Class M recipes                                       |
| Freeze audit             | durable snapshot                      | **HOLDS** #1369                         | —                                                     |
| Spatial concurrent       | fingerprint policy                    | **HOLDS** + read token (scene-fp)       | require-fp after non-empty optional; canvas UI L11    |
| crew-events              | Class B close                         | **NOT WIRED** + pin                     | ADR D-S-13                                            |

## Engine C — attack surface

| Surface                    | Status after wave 6                               |
| -------------------------- | ------------------------------------------------- |
| Tier gates                 | Fail-closed stake + host                          |
| Paper flags                | Trust gap known; no ledger; fillId inflate closed |
| Prize config               | Refuse-closed on wire                             |
| XP double-award            | Business key + identity dedupe                    |
| Score after calendar end   | **Closed** via assertScoreWindowOpen (#1410)      |
| Freeze re-rank             | Lifecycle edges + durable snapshot                |
| Ghost XP / cert spine      | markets-v1 removed; spine gate #1370              |
| Freeze audit via appoint   | **Closed** #1411                                  |
| Scene concurrent half-wire | Read token shipped (scene-fp)                     |

## In flight

- #1410 score window, #1411 appoint freeze — merge when CI green
- #1423 scene-fp + #1424 crew-video park — CI babysit
- Re-derive tip after those merges

## Parked (pick-up)

1. **market.paper verify** — multi-service contracts
2. **IFC rates / residency economics / prize amounts** — Nitro §8 only (Class M/X)
3. **Shell canvas / ambassador badge** — L11 wall
4. **crew-events bus mount** — ADR D-S-13
5. **markets/builder/sovereign cert shells** — product law for XP amounts
6. **Video SFU / stored media library** — infra + keys (no invent CDN)
7. **Self-asserted curriculum complete** — product exam vs self-assert
8. **XP outbox/sweep** — recovery today = re-call grantCert
9. **Require fingerprint after non-empty scene** — optional harden (omit still last-write on first)
10. **Capacity race harness** — testcontainers optional
11. **Tracker mountain honesty** — certs WIP ghost / curriculum rows (L15 or mountain event)

## Nitro must decide

**none** for Class N units above.

Class M/X only if he wants: IFC rates, prize funding, residency pay, licensed curriculum, exam vs self-assert complete.

## SAFE TO CLOSE

**yes for this cook** once #1410/#1411 + scene-fp + crew-video park are merged or parked with pick-up — remaining wall residual is Nitro-only money, multi-service contracts, L11 shell, SFU/infra, or product law.

tip: re-derive `git log -1 --oneline origin/main` after merges.

```
LANE: L02 ACADEMY wave 6
shipped: #1371 amb pay refuse · #1370 cert spine · #1368 paper fillId · #1369 bulk+freeze · #1410 score window · #1411 freeze audit · scene-fp · crew/video park pins
in flight: #1410 #1411 #1423 #1424 CI
parked: IFC/prizes/residency · market.paper multi-svc · SFU · crew bus · shell L11 · self-assert exam · XP outbox
Nitro must decide: none (Class N)
SAFE TO CLOSE: yes once open residual PRs merge or stay parked with pick-up
tip: re-derive
```
