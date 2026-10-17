# LANE STOP — L13 TOKEN · wave 4 · 2026-08-09

## Packet

```
LANE: L13 TOKEN wave 4
shipped: #1257 tRPC stake no 10^18 scale · #1268 yield plan matches sweep + zero-buy window claim refuse · #1273 refusal tests · #1275 README honesty · #1291 cron mint kill-switch HTTP proof
in flight: none
parked: empty-staker yield window header claim · mint post-then-row crash×retune · emission curve §8 · yield/buyback/governance flywheel sockets
Nitro must decide: emission curve live vs seed (§8) — or none
SAFE TO CLOSE: yes
tip: re-derive origin/main
```

## What shipped

| PR    | Class | Plain                                                                         |
| ----- | ----- | ----------------------------------------------------------------------------- |
| #1257 | M     | Edge stake reads used raw scaled bigint; now decimal                          |
| #1268 | M     | Dup fee sources underfunded plan; concurrent count lie; zero buy spent window |
| #1273 | P     | Pending unstake + governance edges + curve shape refusals executed            |
| #1275 | N     | README no longer claims unvalidated revenueTotal / missing yield claim        |
| #1291 | N     | Cron mint kill-switch unit-proved at HTTP boundary                            |

## Sealed re-verified (not re-shipped)

#1100 stake wire · #1083 mint ceiling · #1076 yield plan · #767 buyback claim

## Fenced

market stake writes · protocol minter

## Pick-up

1. Empty-staker distribute: claim `(window_id, total)` before sweep
2. Mint claim-before-post (crash + retune under-books)
