# BUILD STOP — TRADE lane, 2026-08-08

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

Companion to [`TRADE-LANE-HARVEST-2026-08-08.md`](./TRADE-LANE-HARVEST-2026-08-08.md), which holds the full seven-mountain survey. This is the state of the lane and what is owed.

---

## 1 · The correction the lane turned on

The brief described all seven `trade.*` mountains as unbuilt. **Six were substantially built and merged.** The brief was written against a checkout **320 commits behind** `origin/main` — a tree where `svc-trade` had 78 TypeScript files instead of 123, 5 ADRs instead of 25, and where three of the five law documents it cited _by path_ did not exist.

So the lane's work became **finish, mount, repair** rather than build. Two of the largest items were code that existed, passed its tests, and was reachable from no route at all.

**Standing lesson:** re-derive tip before believing anything about this repo, including a brief that names files.

---

## 2 · Shipped

| PR        | What changed for a trader                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **#1097** | The OTC desk let the **customer name the price it filled at** — `midPrice` was a required wire input under `trade:read`, flowing unvalidated into a fill against house market-maker inventory. A staked caller could quote 10 BTC at a mid of 1 and take the inventory. Mid is now server-sourced and refuses when it cannot source one. Also: settle minted fresh UUIDs per call, so a retry after a partial post placed a **second hold** with no release path — ids are now derived from the quote. |
| **#1098** | The **third funding double-charge** in one file (after #1034 and #1047). The ledger key ended in a loop counter, so a replay whose book had changed — or merely whose row order flipped — reached the ledger under unseen keys and posted again, while the idempotent margin applier recorded one charge. Ledger and `margin_current` diverged, which is the inverse of #1034.                                                                                                                         |
| **#1101** | The harvest doc — nine money defects, eighteen owner decisions, eleven wrong doc lines.                                                                                                                                                                                                                                                                                                                                                                                                                |

## 3 · Also shipped

| PR        | What changed for a trader                                                                                                                                                                                                                                                                                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **#1105** | An oracle that polls charged every trader a **full funding period, every poll** — the period id was derived from a millisecond clock, so each republish minted a fresh unsettled period and `runFundingTick`'s already-settled check was void. The publisher must now name its period, and the name is canonicalised, scoped to its own market, and stamped no further ahead than a minute. |
| **#1107** | A restart silently destroyed every in-flight TWAP — no principal meant a refused child, a refused child was recorded as a _miss_, and a miss advances the schedule. Every surviving algo burned its whole plan and reported `completed` having placed nothing. It halts now, keeps its plan, and says why.                                                                                  |
| **#1110** | Copy-trading exposure was computed in two places that could disagree. It is computed once and the approved value rides on the plan. **Rewritten after review** — see below.                                                                                                                                                                                                                 |
| **#1112** | A bot could not tell a **simulated** market from a real one: paper markets appear in `fetchMarkets` identical to real listings, and orders on them take no hold and post nothing. `paper` is now on the public wire.                                                                                                                                                                        |

**Nothing of this lane's is left open.** All eight PRs merged.

### A correction worth carrying, not just recording

**#1110 shipped the opposite of what I first wrote.** I read exposure's monotonic growth as a bug and made it a signed net position. The adversarial pass went to `SessionKeyLib.sol` and found the cap this code exists to mirror is `uint128 spendLimitWei` — _"cumulative cap on native value this session may ever move"_ — unsigned, monotonic, and enforced on-chain precisely because a service-side cap is "a promise, not a fact".

So the old arithmetic was correct and I had diagnosed a design property as a defect. Measured against my own branch, the signed version let a follower alternate buy-BTC / sell-ETH and mirror **1000 of position under a cap of 100**, and a negative exposure could not even persist — `0011_copy_follows.sql:24` carries `CHECK (exposure >= 0)`, and my test passed only because the memory store has no constraint and `SqlCopyFollowStore` has no coverage at all.

The real bug underneath was the one that survived: the check and the write were two expressions that happened to agree with nothing making them.

---

## 4 · The one thing I set out to do and did not

**The TWAP scheduler is not mounted, deliberately.**

`tickAllAlgos()` has zero callers, so a trader can create a TWAP, get a 201, watch it persist, and never receive a single child order. I built the scheduler (~30 lines on the existing job host, default OFF), and the adversarial pass came back **DO NOT MOUNT**. It was right, and #1107 is the safe half only.

Mounting it opens three money paths in _untouched_ code that nothing has ever exercised, because nothing has ever ticked:

1. **Pause→resume compresses the schedule into a burst.** `dueAt` is `startedAt + index × interval` and resume does not re-space, so every overdue slice fires back-to-back at the tick cadence. Measured against the real engine: a 10-slice, one-per-minute TWAP paused 20 minutes and resumed placed **9 slices in 8 seconds** — the opposite of what a TWAP is for. Any user can trigger it via `algo.resume`; any tick outage triggers it with no user at all.
2. **A failed child cancel leaves the parent active.** The status update sits after the per-child cancel loop, so one throw and the algo keeps placing.
3. **Cancel silently no-ops after a restart.** The parent flips to `cancelled` while every child stays live on the book, holding funds and still filling.

Plus: one bad market freezes every user's algo (the depth calls sit outside the try block, so one rejection aborts the whole sequential sweep — and hydration order is stable, so the same parent starves every other one, every second, forever), and `halt` is terminal while a momentarily one-sided book is enough to halt.

**(1) needs a ruling before code**, which is why this is here and not done: an overdue slice should either be **skipped** — the moment passed, and time-weighted means what it says — or **caught up slowly**. That changes how much of a user's order executes. The other three are engineering and follow the ruling.

---

## 5 · What is blocked on a human

### Denon — product law

| #       | Decision                                                                                                                                                                              | Blocks                                         |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| D1      | **Maintenance margin ladder.** `DIRECTION:32` requires it reference real depth and **forbids a constant**; tip ships a hardcoded 50% nothing overrides, so tip already violates this. | Futures liquidation                            |
| D2      | **Funding rate cap.** Nothing bounds a published rate in law or code — `"1000000"` is accepted and charged as 1,000,000 × notional. **The largest unbounded money lever left.**       | Futures funding                                |
| D3      | Liquidation ladder parameters — margin-call threshold, grace, tranche size, penalty.                                                                                                  | Margin call + partial liquidation, both absent |
| D4      | Insurance fund target size and funding share. `DIRECTION:33` says an empty fund means futures do not list; there is no such gate.                                                     | Futures listing                                |
| D5      | ADL thresholds, ranking, and the pre-open disclosure `DIRECTION:34` mandates.                                                                                                         | Futures endgame                                |
| D6      | Dark-feed horizon — how long a position may stay `closing`.                                                                                                                           | Exit-when-dark                                 |
| D7      | **Options settlement fixing** — which source, what window, what expiry time, which funded account pays ITM holders.                                                                   | All of `trade.options`                         |
| D8      | **Forex settlement law** — stablecoin-margined vs true fiat omnibus. Note `PAY_CRYPTO_ASSETS` can answer this **by accident** if someone maps `EUR` to a euro stablecoin.             | All of `trade.forex`                           |
| D9      | OTC minimum notional and maximum quote size. SPEC A1 requires refusing an unfillably large request; there is no number to refuse against.                                             | OTC completeness                               |
| D10     | Copy: spot-only or leveraged for v1? The spec is silent across all 166 lines.                                                                                                         | Copy scope                                     |
| D11     | Copy: the period boundary. The cap is keyed leader:follower with no period column, so it is a _lifetime_ cap and decay never resets.                                                  | Copy settlement                                |
| D12     | Which tier ladder is authoritative for OTC — three exist; the desk reads only one.                                                                                                    | OTC tiering                                    |
| **D13** | **TWAP overdue-slice policy — skip or catch up.** New; see §4.                                                                                                                        | Mounting the scheduler                         |

### Nitro

| #   | Decision                                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| N1  | **`TRADE_FUTURES_PROFIT_SOURCE`** — which account funds realised profit and how it is capitalised. Mechanism built and correct; `open()` refuses until set.                                                                                                   |
| N2  | **Confirm max leverage is 10×.** `DIRECTION:27` states it, `AFK-RESIDUAL-STOP-2026-08-07.md:38` disputes agents may use it. Currently **completely unenforced** — only constraint is `> 0`, column allows 999,999.99. One sentence unblocks a one-line guard. |
| N3  | Do paper markets belong in the public `fetchMarkets` listing? Today a bot cannot tell one from a real market and books positions that do not exist.                                                                                                           |
| N4  | Which rate limits are real — the published `1200/600/20` that nothing enforces, or the edge's actual flat 300/min.                                                                                                                                            |
| N5  | Should the six FX pairs stay listed while unfundable?                                                                                                                                                                                                         |
| N6  | `EDGE_TRUST_PROXY` for the deployed topology — unset behind nginx, the limiter throttles the whole platform as one bucket.                                                                                                                                    |

---

## 6 · Named residuals, recorded not guessed

Each is written at the code site, not only here.

- **`socket.otc-mid-feed`** — `TRADE_OTC_MIDS` is a fixed price read once at boot with no observation time. A stale mid is the same economic hole as a caller-supplied one, needing patience instead of a wire field. **The variable must stay empty in production** until the source carries a timestamp and refuses on age. The max-age number is owner law.
- **`socket.algo-principal-durability`** — making a TWAP survive a restart means storing an authorisation grant that outlives the session that gave it. How long a schedule may carry the right to trade on someone's behalf is owner law; minting a principal from a stored `userId` is worse.
- **Copy fee-share cap race** — `settleFeeShare` reads, posts, re-reads and writes with no lock, so two concurrent fills both pass the cap and both pay. The ledger side is safe on business keys, which is the trap: it faithfully _records_ the over-payment. Needs a reserve-then-post restructure and an atomic store primitive **before any route reaches that class**.
- **Funding period membership** — the loader returns positions open _now_, not as of the period, so a position opened between a failed tick and its replay adds a leg. The victim is the payer's ledger-vs-margin divergence, not the new position. Needs a ruling on what a period's membership is.

---

## 7 · Not real, despite the record

**VWAP/POV is recorded as blocked on "no honest volume series". The series exists.** `spot/candles.ts` sums taker fills with seeded market-maker volume excluded on _both_ sides, live-computed per request, already served at `GET /api/v1/ohlcv/:symbol`.

The accurate statement is that it is **thin**, not absent — and the ADR blocks on market _maturity_, reserving that call to the owner. **Still do not build VWAP.** The honest next step is one read-only query measuring real non-seeded volume per market over 30 days, handed over as evidence.

---

## 8 · Method note, for whoever runs the next lane

Every PR here was reviewed by a fresh agent whose only instruction was to break the money path. It was worth it every time:

- On the OTC desk it found **a bug I had introduced** (a normalisation split that made unsettleable quotes), reproduced a pre-existing stranding bug I had not looked for, and named the staleness gap that became `socket.otc-mid-feed`.
- On the funding key it proved the fix killed **more** than I claimed (a bare row-order flip re-posted the entire plan), found the new failure mode I was most worried about and guarded it, and **corrected my description of the residual** — I had named the wrong victim, because I had looked at the ledger side and not the margin side.
- On the TWAP scheduler it said do not mount, and produced the measurement that settled it.

Two of those three changed what shipped. A self-scored money diff would have shipped all three as-is.

**Machine state:** `pnpm` is not installed on this machine — the repo declares `pnpm@10.25.0` and the binary is absent from `~/Library/pnpm` (only the store remains). Everything here ran through `npx -y pnpm@10.25.0`. Worth fixing properly rather than rediscovering.
