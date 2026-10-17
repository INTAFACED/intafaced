# LANE STOP — L13 TOKEN · wave 6 · 2026-08-09

## Packet

```
LANE: L13 TOKEN wave 6
shipped: #1418 crash mid stake/unstake + stake↔ledger reconcile + accessOf=stakeOf + draft terminal · #1422 README claim-order + houseFees pot honesty
in flight: none
parked: emission curve §8 · yield/buyback/governance flywheel sockets · tracker note freshness (L15 wall) · empty-window engine residual schedule · under-sweep invent still allowed by design
Nitro must decide: emission curve live vs seed (§8) — or none
SAFE TO CLOSE: yes
tip: re-derive origin/main (ship #1418 7b98cd1f · #1422 b99cde28)
```

## What shipped (wave 6)

| PR    | Class | Plain                                                                                                                                                       |
| ----- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #1418 | M/P/N | M-02 post-before-activate resume; M-04 unstaking claim-before-post resume; active-sum==ledger; accessOf.staked==stakeOf; draft stays terminal after opensAt |
| #1422 | N     | README auto-vs-person: pot bind on first yield claim; stake pending→fund→active; test inventory                                                             |

## Sealed re-verified (not re-shipped)

| Item         | Note                                                       |
| ------------ | ---------------------------------------------------------- |
| #1353 / 0004 | Empty yield freezes; mint claim-before-post; fee pot check |
| #767 / 0002  | Buyback claim-before-burn                                  |
| #1076 / 0003 | Yield plan freeze (non-empty)                              |
| #1257        | tRPC stake decimal                                         |
| #1291        | Cron mint kill-switch HTTP                                 |
| #1100        | Internal stake wire fail-closed                            |
| #1083        | Mint ceiling vs book                                       |
| tip          | token_params live drive (T-02); fee discount governance    |

## Engine A rank (wave 6 disposition)

| Prio | Unit                       | Disposition                                                                    |
| ---- | -------------------------- | ------------------------------------------------------------------------------ |
| A0   | Open token-wall PR merge   | **clear** — 0 open product PRs at start; merged W6                             |
| A1   | empty-staker yield         | **sealed** #1353                                                               |
| A1   | mint crash residual        | **sealed** #1353                                                               |
| A1   | stake claim-before-post    | **sealed** + **proved** M-02 in #1418                                          |
| A1   | unstake crash residual     | **sealed** + **proved** M-04 in #1418                                          |
| A2   | stake↔ledger reconcile     | **proved** #1418                                                               |
| A2   | yield window resume        | **sealed** #1076/#1353                                                         |
| A2   | buyback claim-before-burn  | **sealed** #767                                                                |
| A2   | yield amount honesty       | **partial** — over-claim refuse; under-sweep allowed; aggregation job = socket |
| A2   | token_params live drive    | **sealed** T-02                                                                |
| A2   | EMISSIONS kill             | **sealed** #1291 + mount                                                       |
| A2   | internal stake hot-path    | **sealed** #1100 + accessOf=stakeOf #1418                                      |
| A3   | fee discount governance    | **sealed** tests on tip                                                        |
| A3   | governance ballot          | **sealed**; executor/quorum §8 **park**                                        |
| A3   | buyback split conservation | **sealed** pure + CK                                                           |
| A3   | socket honesty             | **README** #1422; **tracker notes stale** → L15                                |
| A3   | Engine B chapter pass      | **this stop**                                                                  |

## Fenced

market stake writes · protocol minter

## Parked with pick-up

1. **Emission curve §8** — Nitro owner numbers (seed vs live). Do not invent.
2. **Flywheel sockets** — `token.yield` aggregation job (sources still operator-typed after pot bind), `token.buyback` real market-buy via svc-trade, `token.governance` quorum/threshold/status executor.
3. **Empty-window engine residual** — empty distribute still sweeps into rewards engine; later stakers need a **new** window id + fees still in houseFees.
4. **Tracker note freshness (L15 wall)** — `features.mjs` `token.yield` / `token.buyback` notes still claim "nothing reads houseFees" / unvalidated revenueTotal. Status correctly remains `socket`. Honesty patch is board/tooling, not svc-token.
5. **Yield under-sweep invent** — operator may name less than pot; intentional partial settlement until aggregation job.

## Engine B — README chapter falsification (this wave)

| Chapter                         | Verdict on tip                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------ |
| Auto vs person table            | **honest after #1422** — sockets named; pot bind stated; no scheduled flywheel |
| Staking ladder / lock tiers     | **live** — claim-before-post; locks; concurrent unstake                        |
| Access tiers / fee discount     | **live** — token_params authority; unreadable refuses                          |
| Emissions schedule / ceiling    | **live** — claim-before-post; emitted-total cap; kill-switch                   |
| Kill-switch + auto-tick off     | **live** — tRPC + internal + boot gate                                         |
| Yield operator-only             | **true** — no cron/bus/admin form                                              |
| Yield empty window / empty set  | **sealed** 0004                                                                |
| Buyback operator-asserted       | **true** — no market-buy                                                       |
| Buyback claim-before-burn       | **sealed** 0002                                                                |
| Governance ballots only         | **true** — draft terminal proved #1418                                         |
| Ledger recipes                  | **all present** — stake/unstake/sweep/reward/burn/mint                         |
| Events stake.created / buyback  | **publish only** — no invented consumers                                       |
| IFC ledger asset not chain coin | **true** — no deposit/withdraw/self-custody                                    |

## Engine C — attack surface (sample)

double stake id · double unstake · locked early · mint kill off · double distribute · double buyback window · ballot stuffing · free userId internal · MFA treasury · houseFees over-claim · dual truth active rows — **covered or sealed**. Dark trade buy for buyback = socket.

## Local verify (agent)

- economics 106/106 green
- money suite: **CI Tests success** on #1418 (3m40s) + DoD success
- no local Docker/Postgres in agent host this cycle
