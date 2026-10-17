# WAVE-AUDIT — residual futures planners / ticks / close (2026-07-31)

**Scope:** Residual campaign product ships after AMM mint/swap through close wire.  
**Tip at write:** re-check `git log origin/main -1` — git wins.

## Ships in this wave (re-derive)

| PR    | Class | What                              | Residual after         |
| ----- | ----- | --------------------------------- | ---------------------- |
| #291  | P     | Funding settlement planner        | Rate invent banned     |
| #292  | P     | Liquidation planner               | Mark invent banned     |
| #293  | P     | Funding tick job                  | Needs rate source      |
| #296  | P     | Liquidation tick job              | Needs mark source      |
| #300  | P     | Mark-source port (index/mid/last) | Live index still open  |
| #303  | P     | Funding-rate-source port          | Live oracle still open |
| #304  | M     | futuresRealizeProfit recipe       | Close stack            |
| #305  | P     | Close planner                     | Wire REST              |
| #306+ | M     | close() wire exitPrice            | Live oracle + matching |

## Adversarial checks

1. **No invent prices/rates** — every tick/planner refuses null/empty/stale; default liq refuses `last` quality.
2. **Money only via recipes** — planClose posts profit/loss/release only; no balances outside ledger-client.
3. **Idempotency** — period store + attempt ids + recipe keys.
4. **Not product-done** — matching engine, wall-clock cron hosts, multi-venue index, go-live X still open.
5. **Tracker** — `trade.futures` stays **wip** with honest notes (not 🟢 done).

## Collisions left alone

- #289 order-route (other program)
- Frontend Wave B craft (sibling lane on main)

## Next residual queue

1. Job host skeleton (setInterval/cron wrapper — no invent)
2. Wire mark-source to matching mid (explicit book read)
3. Matching / mm-bot seed depth
4. Human X: prod RPC, secrets, go-live

## Verdict

Wave is **honest partial progress** on trade.futures. Safe to keep COOKING; do not mark futures done.

## Addendum — jobs wire (#308–#312)

| PR   | What                                                       |
| ---- | ---------------------------------------------------------- |
| #308 | job-host interval wrapper                                  |
| #309 | mark-from-depth                                            |
| #310 | SQL position loaders                                       |
| #311 | funding_periods + liquidation_attempts + sqlPositionCloser |
| #312 | startFuturesJobs in svc-trade **default OFF**              |

**Adversarial:** default-off prevents silent money on boot. Empty FUNDING_MARKET_IDS schedules no funding jobs. Depth empty → liq skip. Rate book empty → funding skip.
