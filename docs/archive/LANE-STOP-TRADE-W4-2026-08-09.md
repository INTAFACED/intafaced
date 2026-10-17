# LANE STOP — TRADE wave 4 · 2026-08-09

**Tip at writing:** re-derive with `git log -1 --oneline origin/main`.  
**Lane:** L05 trade residual · promise falsification · money attack surface.  
**Mode:** AFK long cook · residual only.

Companion: [`LANE-STOP-TRADE-W3-2026-08-09.md`](./LANE-STOP-TRADE-W3-2026-08-09.md) · Engine B: [`TRADE-PROMISE-FALSIFY-W3-2026-08-09.md`](./TRADE-PROMISE-FALSIFY-W3-2026-08-09.md).

---

## Verdict

**SAFE TO CLOSE this wave** for agent residual craft under the exclusive wall.

Wave 3 money top-10 held. Wave 4 shipped **claim unlock + real residual breaks** (TWAP cancel-fail / seed FX place / liq mark size / presentation honesty / docs) without inventing owner numbers.

---

## Merged this wave (named)

| PR        | What a trader / operator can now rely on                                                                                                                        | Class |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| **#1215** | `svc-trade` no longer whole-locked by ghost `trade.futures @nitro-agent` or vault `module:trade` invent; claim-check module fallback only when `requires` empty | N     |
| **#1220** | Seed production FX/commodity **cannot take a real hold** — place/convert/TWAP share `assertSettlementRails`                                                     | P     |
| **#1222** | Liquidation marks pass **position size** (relative depth floor); `initialMargin` ≠ residual after funding                                                       | M     |
| **#1223** | README: algo jobs mounted **default OFF**, not “dead code”; SIGTERM stops reconcile host                                                                        | N     |
| **#1219** | Failed TWAP cancel **pauses** (no more slices); resume refused until re-cancel (`cancel_incomplete`); `tickAll` isolates parents                                | M     |
| **#1237** | Matching journal header honesty (replay-once ≠ live id guard)                                                                                                   | N     |

Re-derive merge list from `gh pr list --state merged --search "trade w4"` if tip moved.

---

## Engine A scoreboard (after wave 4)

| Prio | Unit                     | Disposition                                                          |
| ---- | ------------------------ | -------------------------------------------------------------------- |
| A0   | Open trade / claim clear | **Done #1215**                                                       |
| A1   | copy mount               | **PARK** — money sealed W3; still unmounted by design                |
| A1   | OTC residual             | **PARK owner** — mid max-age socket                                  |
| A1   | MM residual              | Sealed W3 size/age; sequenced-book residual still open (not shipped) |
| A1   | venue residual           | Sealed public second venue; single-id mark mount                     |
| A2   | algo OFF respect         | **#1219** cancel-fail + resume gate; jobs still OFF default          |
| A2   | ccxt residual            | Sealed 501s; no new hole                                             |
| A2   | forex thin               | **#1220** place refuse on unsettled class                            |
| A3   | matching falsify         | **#1237** journal honesty; refuse table sealed                       |
| A3   | margin-call              | Sealed W3 #1211 — no invent D3                                       |
| A3   | Engine B re-run          | Harvest complete; new units above only                               |
| A3   | stop note T* table       | **This file**                                                        |

---

## Parked (honest)

1. **Copy mount** — deliberate Class M + migration `copy_mirrored_fills` + §8 rates
2. **OTC mid age** — owner max-age
3. **TWAP principal durability** — socket (no mint)
4. **Sequenced venue book for marks** — age-on-poll incomplete
5. **Futures R1/R2** concurrent liq claim/lock — harvested, not shipped this wave
6. **Funding block-next unsettled period** — ADR residual
7. **leader_share_bps / leverage / venue keys** — Nitro-only

---

## Nitro must decide

- **N5** reflag seed FX markets public list (paper/pending) — place path now refuses anyway
- **N1** `TRADE_FUTURES_PROFIT_SOURCE` capitalisation
- Copy mount **go** if product wants routes
- OTC mid max-age number

Or **none** required to leave residual safe.

---

## Machine

- Worktrees: `feat-trade-w4-*` under `~/projects/sovereign-worktrees/`
- Class M: self-audit + adversarial on #1219 / #1222
- Local: 26/26 `twap-engine` tests green; CI seal on merges
- Claim-check after #1215: `services/svc-trade` clear

---

## SAFE TO CLOSE?

**Yes — for wave 4 residual engines as scoped.**

```
LANE: L05 TRADE wave 4
shipped: #1215 claim unlock · #1220 seed FX place refuse · #1222 liq size + margin honesty · #1223 README jobs OFF · #1219 TWAP cancel-fail · #1237 matching journal honesty
in flight: re-derive open trade PRs
parked: copy mount · OTC mid age · principal durability · sequenced book · concurrent liq claim
Nitro must decide: N5 seed list policy · copy mount go · OTC max-age · or none
SAFE TO CLOSE: yes
tip: 6938d971
```
