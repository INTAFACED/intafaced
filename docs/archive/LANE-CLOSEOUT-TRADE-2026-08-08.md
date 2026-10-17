> **Supersession (2026-08-09):** Any line that treats **Actions thrift**, run-count caps, `THRIFT_ALLOW`, or holding PRs for CI spend as current law is **void**. The repo is public; thrift was deleted 2026-08-07. See [`GITHUB-CI-SPEND-CONTROL-2026-07-31.md`](GITHUB-CI-SPEND-CONTROL-2026-07-31.md).

# TRADE lane closeout — 2026-08-08

**Tip at writing:** `f29ddf69`

Detail lives in [`BUILD-STOP-TRADE-2026-08-08.md`](./BUILD-STOP-TRADE-2026-08-08.md) and [`TRADE-LANE-HARVEST-2026-08-08.md`](./TRADE-LANE-HARVEST-2026-08-08.md). This is the landing record.

**The premise correction that shaped the whole lane:** the brief described all seven `trade.*` mountains as unbuilt. **Six were substantially built and merged.** It was written against a checkout **320 commits behind** `origin/main` — 78 TypeScript files in `svc-trade` instead of 123, 5 ADRs instead of 25, and three of the five law documents it cited _by path_ did not exist in that tree. The lane became finish/mount/repair, not build.

---

## Shipped

| PR                        | What a user or operator can now do                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **#1097**                 | An OTC customer can no longer name the price the house fills them at. `midPrice` was a required wire input under `trade:read`, flowing unvalidated into a fill against house market-maker inventory — a staked caller could quote 10 BTC at a mid of `1` and take the inventory. The mid is now server-sourced and refuses when it cannot source one. Same PR: a settle retry no longer places a second hold on the customer's funds, and a desk short of inventory no longer strands them. |
| **#1098**                 | A funding retry can no longer charge a trader twice — the **third** such bug in that file after #1034 and #1047. The ledger key ended in a loop counter, so a replay whose book had changed (or merely whose row order flipped) reached the ledger under unseen keys and posted again, while the idempotent margin applier recorded one charge.                                                                                                                                             |
| **#1105**                 | An oracle that polls no longer charges every trader a full funding period **on every poll**. The period id was derived from a millisecond clock, so each republish minted a fresh unsettled period and the already-settled guard was void. The publisher must now name its period, and that name is canonicalised, scoped to its own market, and stamped no further ahead than a minute.                                                                                                    |
| **#1107**                 | A restart no longer silently destroys every in-flight TWAP. No principal meant a refused child, a refused child was recorded as a _miss_, and a miss **advances** the schedule — so every surviving algo burned its whole remaining plan and reported `completed` having placed nothing. It halts now, keeps its plan, and says why.                                                                                                                                                        |
| **#1110**                 | Copy-trading exposure is computed once instead of in two places that could disagree.                                                                                                                                                                                                                                                                                                                                                                                                        |
| **#1112**                 | A bot can tell a **simulated** market from a real one. Paper markets appeared in `fetchMarkets` identical to real listings while orders on them took no hold and posted nothing — a bot booked positions that did not exist.                                                                                                                                                                                                                                                                |
| **#1101 · #1111 · #1113** | The harvest, the stop note, and the closing correction.                                                                                                                                                                                                                                                                                                                                                                                                                                     |

All nine merged. **#1104 was closed deliberately** — superseded by #1107 after its adversarial pass returned _do not mount_.

---

## Left open, and why

**Nothing of mine is open.** No draft, no red PR, no dangling branch. Three things are _recorded rather than fixed_, each deliberately:

- **The TWAP scheduler is not mounted, so a created TWAP still places nothing.** I built it, and the adversarial pass returned **DO NOT MOUNT** with measurements. Mounting opens three money paths in untouched code that nothing has ever exercised — the worst being that pause→resume compresses the remaining schedule into a burst (measured: **9 slices in 8 seconds** for a schedule asking one per minute, triggerable by any user via `algo.resume`). Also: a failed child cancel leaves the parent active and still trading; and after a restart cancel silently no-ops while children stay live on the book holding funds.
  **Next session:** the blocker is D13 below, not code. Once ruled, the other three are ordinary engineering. Read `docs/adr/2026-08-04-algo-execution-law.md` — its Done bar is at `:94-101`, and note it never says "a slice must fire", which is exactly how a scheduler-less algo passed all six boxes.
  This is tip's pre-existing state; I did not make it worse, and #1107's body says plainly that a created TWAP still places nothing.

- **The copy module stays unmounted.** Its earnings cap does not hold under concurrency: `settleFeeShare` reads, posts, re-reads and writes with no lock, so two concurrent fills both pass the cap and both pay. The ledger side is safe on business keys, which is the trap — it faithfully _records_ the over-payment. Documented at the method. Needs a reserve-then-post restructure plus an atomic store primitive **before any route reaches that class**.

- **The funding period anchor.** #1105 shrank the surface from "any string" to "any valid instant" and the file says in those words that this is a reduction, not a bound. A publisher sending a fresh ISO instant per poll still mints a fresh period. The bound is the market's funding boundary, which is the product fact the endpoint refuses to invent — it has to arrive as per-market config.

---

## Not started

Two of my seven mountains, both blocked on a human rather than on effort:

- **`trade.options`** — instrument enum only. **Read:** `docs/ops/trk/trade.options.md` + `TRK-trade.options.md`, and `docs/adr/2026-08-04-instrument-enum-authority.md` (the multi-asset law it was waiting on, now delivered). **Done bar:** European, cash-settled, full collateral in v1. Note the pack's two stated blockers are both **stale** — Shehzad M3 was reclaimed 2026-08-04 and the multi-asset law shipped as D-S-05. The one real blocker is D7. A useful correction for whoever picks it up: full-collateral European options need **no IV model at all** — payoff is mechanical once the settlement price is known. Chasing an IV surface would be building the wrong thing. The honest thin slice (contract terms migration with a CHECK that a half-listed option cannot exist, plus a listing path that refuses `kind='options'` until a fixing is configured) is written up in the harvest.

- **`trade.forex`** — the hours engine is genuinely done and well tested; the settlement half does not exist. **Read:** the `trade.forex` note in `tooling/tracker/features.mjs`, and `docs/ops/trk/trade.forex.md`. **Done bar:** fiat pairs on the same engine with honest hours and real settlement rails. **The tracker note is wrong** and should be corrected: it says "no forex market is listed in production", but migration `0001_multi_asset_instruments.sql:152-157` seeds six FX majors `active` and the public market list calls them "live listings". The honest wording is _no forex market is **fundable**_. Blocked on D8. Buildable today with no invented numbers: publish the schedule and next-open on the public market payload, add holiday calendars (both shipped schedules carry `holidays: []` against a schema comment warning that an empty list fails **open**), and gate `convertQuote` on hours — it currently quotes a shut venue.

`trade.futures`, `trade.otc`, `trade.copy`, `trade.algo` and `trade.ccxt-api` were all reached. **Note:** #1118 (`feat/futures-orderable-path`) is another lane in futures — I did not touch it.

---

## Only Nitro can decide

Full table in the stop note; these are the ones that block work rather than polish it.

| #      | Decision                                                                                                                                                                                                                                                                                        |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **N1** | **`TRADE_FUTURES_PROFIT_SOURCE`** — which account funds realised futures profit and how it is capitalised. The mechanism is built and correct; `open()` refuses outright until this is set.                                                                                                     |
| **N2** | **Confirm max leverage is 10×.** `DIRECTION:27` states it; `AFK-RESIDUAL-STOP-2026-08-07.md:38` disputes whether agents may use it. It is currently **completely unenforced** — the only constraint is `leverage > 0` and the column allows 999,999.99. One sentence unblocks a one-line guard. |
| **N3** | Do paper markets belong in the public `fetchMarkets` listing at all? #1112 makes them _distinguishable_; whether they should be listed is a product call with a compliance edge.                                                                                                                |
| **N4** | Which rate limits are real — the published `1200/600/20` that nothing enforces, or the edge's actual flat 300/min. They cannot both be the contract.                                                                                                                                            |
| **N5** | Should the six FX pairs stay listed while unfundable?                                                                                                                                                                                                                                           |
| **N6** | `EDGE_TRUST_PROXY` for the deployed topology — unset behind nginx, the limiter keys every caller into one bucket and throttles the whole platform.                                                                                                                                              |

**Denon — product law.** D1 maintenance-margin ladder (tip ships a hardcoded 50% that `DIRECTION:32` explicitly forbids) · **D2 funding-rate cap — nothing bounds a published rate in law or code, `"1000000"` is accepted and charged as 1,000,000 × notional, and it is the largest unbounded money lever left** · D3 liquidation ladder parameters · D4 insurance fund size and the listing gate `DIRECTION:33` requires · D5 ADL thresholds and disclosure · D6 dark-feed horizon · D7 options settlement fixing · D8 forex settlement law (note `PAY_CRYPTO_ASSETS` can answer this **by accident** if someone maps `EUR` to a euro stablecoin) · D9 OTC min notional and max quote size · D10 copy spot-only or leveraged · D11 copy period boundary · D12 which of three tier ladders is authoritative for OTC · **D13 TWAP overdue-slice policy — skip or catch up** (new; gates the scheduler).

---

## What I could not break, having tried

The honest negatives. Every PR got a fresh agent whose only instruction was to break the money path, and these are the places they went looking and found nothing.

- **The OTC settle path against a real ledger.** Every crash interleaving of the three posts was walked, and **both** ledger engines were read rather than trusting the recipe comment — `MemoryLedger` and `PostgresLedger` each return the original transaction on a duplicate key, the latter twice (a fast path, then a re-check inside the `FOR UPDATE` chain-tip lock). No leg silently no-ops that genuinely needed to move.
- **Concurrent OTC settle.** There _is_ a window where two calls pass the lookup — it was run. Money moved exactly once, `reconcile()` clean. A double _report_, not a double _move_. The service has no mutual exclusion at all; its safety is entirely delegated to ledger idempotency, and #1097 is what makes that delegation valid.
- **Id-derivation collisions** across all four `derive()` namespaces — impossible by prefix divergence. Taker and maker ids differ by a literal suffix on a server-minted UUID containing no colon.
- **Removing `midPrice` from the wire.** Repo-wide grep across `apps/`, `packages/`, the vendored shell, docs and contracts: **nothing left dangling.**
- **The funding key change breaking existing ledger keys.** Verified independently, not relayed: both env flags default off, and no compose file, `.env.example`, seed, migration, fixture or ops manifest sets either. Nothing in this repo has ever run funding. _Caveat carried forward: deployment configs outside this repo were not visible._
- **The `isLast` remainder branch** in the funding planner conserves the payer's total; `piece <= 0n → continue` can only skip a zero remainder.
- **TWAP child idempotency under multiple replicas** — traced end to end: `algo:{parentId}:{sliceIndex}` → `orderIdFor` → `findOrder` early-return **before** any insert or ledger post, backed by a real unique index at `0000_trade_init.sql:145`. Two replicas placing the same slice cannot double-place or double-hold.
- **The default-OFF coercion inconsistency** I worried about (allowlist next to denylist) — 14 inputs run through both. Each fails safe _for its own default_: the scheduler lands OFF on an unknown string, the kill-switch lands ON. Not a trap.
- **No exhaustiveness hole** from the new error code: `Record<TradeErrorCode, Arm>` is exhaustive by type, `tsc` clean, no switch falls through.

**And two negatives that were not negatives** — worth more than the rest:

- On #1110 the reviewer found **I had the model backwards**. I read copy exposure's monotonic growth as a bug and made it signed; it went to `SessionKeyLib.sol` and found the cap this code mirrors is `uint128 spendLimitWei`, _"cumulative cap on native value this session may ever move"_ — unsigned, enforced on-chain precisely because a service-side cap is a promise rather than a fact. My version let a follower mirror **1000 of position under a cap of 100**, and a negative exposure could not have persisted at all (`0011_copy_follows.sql:24` carries `CHECK (exposure >= 0)`; my test passed only because the memory store has no constraint and `SqlCopyFollowStore` has **no coverage anywhere in the repo**).
- On #1097 the reviewer found **a bug I had introduced** — a normalisation split that made unsettleable quotes.

**Two of six adversarial passes changed what shipped.** A self-scored money diff would have shipped all six as written.

---

## Machine state

`pnpm` is **not installed** on this machine. The repo pins `pnpm@10.25.0` and the binary is absent from `~/Library/pnpm` (only the store remains), while `~/.volta`, `~/.asdf` and `~/.fnm` are on `PATH` but do not exist. Everything in this lane ran through `npx -y pnpm@10.25.0`. Worth fixing properly rather than rediscovering.

**Historical note (2026-08-08 pack):** thrift-preflight was already obsolete on a public repo; thrift was fully deleted 2026-08-07. There is no run-count hold and no `THRIFT_ALLOW`. Open PRs when the unit is done.
