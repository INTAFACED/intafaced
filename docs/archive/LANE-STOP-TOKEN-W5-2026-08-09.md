# LANE STOP — L13 TOKEN · wave 5 · 2026-08-09

## Packet

```
LANE: L13 TOKEN wave 5
shipped: #1353 empty yield freezes + mint claim-before-post + fee pot check + buyback MFA + README honesty
in flight: none
parked: emission curve §8 · yield/buyback/governance flywheel sockets · engine residual after empty sweep (operator schedule)
Nitro must decide: emission curve live vs seed (§8) — or none
SAFE TO CLOSE: yes
tip: re-derive origin/main (ship #1353 e8828ff2)
```

## What shipped (wave 5)

| PR    | Class | Plain                                                                                                 |
| ----- | ----- | ----------------------------------------------------------------------------------------------------- |
| #1353 | M     | Empty yield claims `(window_id,total)` before sweep; late joiners need a new window id                |
| #1353 | M     | Mint claims epoch open (reserves mined) before ledger post; resume uses snapshot after crash/retune   |
| #1353 | M     | First-claim houseFees pot check — over-claim refuses before header (`token.yield_source_underfunded`) |
| #1353 | P     | `recordBuyback` refuses without MFA (mount)                                                           |
| #1353 | N     | README unstake ordering + empty-header honesty                                                        |

## Sealed re-verified (not re-shipped)

| Item        | Note                                       |
| ----------- | ------------------------------------------ |
| #1257       | tRPC stake decimal (no 10^18 wire)         |
| #1291       | Cron mint kill-switch HTTP proof           |
| #1273       | Refusal tests residual                     |
| #1100       | Stake wire fail-closed                     |
| #1083       | Mint ceiling vs book                       |
| #1076       | Yield plan freeze (non-empty)              |
| #767 / 0002 | Buyback claim-before-burn                  |
| tip         | Concurrent double-vote (unique idx + test) |

## Fenced

market stake writes · protocol minter

## Parked with pick-up

1. **Emission curve §8** — Nitro owner numbers (seed vs live drift inventory in economics tests). Do not invent.
2. **Flywheel sockets** — `token.yield` aggregation job (still operator-typed sources after T-03 pot bind), `token.buyback` real market-buy via svc-trade, `token.governance` quorum/threshold/status executor.
3. **Empty-window engine residual** — empty distribute still sweeps into rewards engine; a later window with stakers needs **new** houseFees sources. Paying stranded engine residual without a second typed amount is socket work, not a free craft.

## Engine B / C pass (this wave)

- §4.3 staking / mint ordering: claim-before-post sealed for stake, buyback, yield header, mint.
- Fail-closed stake rescale: sealed (#1100 class).
- Double distribute / late joiner: empty + non-empty headers.
- Proposals: concurrent ballot sealed; status flip still socket.

## Local verify (agent)

- typecheck `@intafaced/svc-token` clean
- mount 25/25; economics+internal 119/119
- Money suite sealed by CI on #1353 (Tests success)
