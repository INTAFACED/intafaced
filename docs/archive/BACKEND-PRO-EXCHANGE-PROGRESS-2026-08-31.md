# Backend pro-exchange — what is specced vs finished (2026-08-31)

**Audience:** next Grok bot + Nitro. **Scope:** backend only. Desk look is Codex / M07 — out of this file.  
**Tip at write:** `origin/main` `f495de5f5` plus #3447/#3448 if already merged. Re-fetch.  
**This is not a second spec.** It is a progress reading of existing law.

## Source-of-truth stack (read in this order)

1. [`INTAFACED_DEFINITIVE_BUILD.md`](../INTAFACED_DEFINITIVE_BUILD.md) — money, identity, one book, refuse-closed.
2. [`PRO_TRADER_EXCHANGE_DEFINITIVE_SCOPE.md`](../PRO_TRADER_EXCHANGE_DEFINITIVE_SCOPE.md) v1.20 — north-star mountains M00–M28 (ignore M07 here). Competitive refresh 31 August 2026.
3. Child contracts `docs/SPEC-PRO-EXCHANGE-*-2026-08-2{3,4}.md` (`PX-S01`…`PX-S16`) plus [`SPEC-PRO-EXCHANGE-COMPETITIVE-DELTA-2026-08-31.md`](SPEC-PRO-EXCHANGE-COMPETITIVE-DELTA-2026-08-31.md).
4. `origin/main` — what actually ships. Not this file’s maturity lines copied from the north-star (those are **spec-time census**, now stale).
5. GitHub issue [#3446](https://github.com/Phantom-X-007/intafaced/issues/3446) — live leftover queue for the next bot.

Do **not** treat [`SPEC-FACTORY-INDEX-2026-08-04.md`](SPEC-FACTORY-INDEX-2026-08-04.md) as the pro-exchange index. That file indexes the older D-S-01…18 factory board. Pro-exchange children are the `SPEC-PRO-EXCHANGE-*` set.

## Two percentages (do not mix)

| Question                                                         | Answer   | How scored                                                                                                                                                                                      |
| ---------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Is backend **specced enough** to build without a new north-star? | **~95%** | 27 backend mountains have north-star R-items **and** a child `PX-S*` contract. Remaining holes are owner magnitudes and external adapters, already labeled `OWNER-SET` / `EXTERNAL` / `SOCKET`. |
| Is backend **finished as a professional venue** vs that spec?    | **~50%** | 27 mountains scored 0–4 for a real user/money/safety slice on `origin/main` (not UI). Total 57 / 108.                                                                                           |

343 backend requirement IDs (`PTX-Mxx-Ryy`, excluding M07’s 21). A “green tracker row” is not 343/343. Many R-items are owner numbers, licensed entities, or operating model.

## Mountain scores (backend)

Score: **4** core professional slice exists · **3** important slice, depth remains · **2** refuse-closed / thin honest slice · **1** spec + stubs · **0** absent.

| M   | Domain                  | R   | Score | On `main` now (plain)                                                                               | Still not a finished venue                                                                                     |
| --- | ----------------------- | --- | ----- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| M00 | Rulebook / decisions    | 7   | 2     | Halt / delist / prelaunch exist as engine+trade refuses. Blank magnitudes refuse.                   | Public versioned rulebook, disputes, “best execution” claims.                                                  |
| M01 | Identity / orgs         | 12  | 3     | Orgs, admin/trader/auditor/risk-manager, four-eyes admin, keys, panic, sessions, sub-account bind.  | Full DMA broker hierarchy, desks/shifts as products.                                                           |
| M02 | Instrument lifecycle    | 8   | 3     | Prelaunch, halt, post-only, reduce-only, expire, delist, auction PLACE refuse.                      | Listing governance, corporate actions, admission reviews.                                                      |
| M03 | Matching                | 13  | 3     | Priority, STP, AON, iceberg, peg+offset, collar, min-notional, mass-cancel, session-dead, halt-all. | FileJournal still drops collar on encode (crash can rest a refused collar). Native L3. Owner fat-finger bands. |
| M04 | Orders / algos          | 17  | 3     | Core TIF, OMS TWAP/VWAP/POV signed start, stage/release/kill, halt refuses start.                   | Basket/rebalance/IS depth, SOR as a proven best-ex product.                                                    |
| M05 | Connectivity            | 13  | 2     | REST/WS, drop-copy seats, key/IP/product doors. Binary/L3 **refused** (not faked).                  | **FIX** order entry + MD. Real binary/SBE feed.                                                                |
| M06 | Market data             | 14  | 2     | L2 + status names, tape **kind or unknown**, correction as new row.                                 | Real L3/queue, historical tick warehouse as a product.                                                         |
| M08 | Collateral / margin     | 13  | 2     | Isolated/cross primitives, ledger holds.                                                            | Portfolio margin, owner haircuts, trade-finance lines.                                                         |
| M09 | Risk / liquidation      | 13  | 2     | Liquidation/default primitives, refuse-closed blanks.                                               | Full waterfall, ADL, insurance as proven ops.                                                                  |
| M10 | Spot / perp / futures   | 11  | 2     | Spot + linear perps exist as product surfaces.                                                      | Dated futures lifecycle, hedge vs one-way migration as proven.                                                 |
| M11 | Options                 | 12  | 1     | MMP/mass-quote **refuse without owner thresholds**.                                                 | Not a volatility venue (chain, combos, exercise, Greeks). Spec exists (`PX-S08`).                              |
| M12 | RFQ / block / give-up   | 12  | 3     | Firm quote, expire, last-look refuse, unlabeled capacity refuse, unnamed give-up refuse.            | Named give-up until owner law; full DMA allocation/affirmation.                                                |
| M13 | Liquidity / MM          | 12  | 2     | MM engine, quote-group cancel, house≠tenant intent.                                                 | External maker programs, quality SLOs (owner/external).                                                        |
| M14 | Reporting / PnL         | 9   | 1     | Records exist; missing-lot tax refuse.                                                              | NAV, statements, regulator export as a product.                                                                |
| M15 | Custody / settlement    | 15  | 2     | Ledger book, ops freeze refuse, support cannot fake payout.                                         | Third-party/off-exchange custody choice, fiat rails.                                                           |
| M16 | Surveillance            | 12  | 1     | STP/self-trade primitives.                                                                          | Case system, spoofing/layering ops, position accountability.                                                   |
| M17 | Participant security    | 10  | 2     | Key/session revoke, IP allowlist, freeze doors.                                                     | Withdrawal cooling (bank) still missing unique commit.                                                         |
| M18 | Resilience / incident   | 11  | 2     | Matching halt named on WS/notify; incident silence not auto all-clear.                              | Drills, RTO/RPO proof, status-page product.                                                                    |
| M19 | Sandbox / certification | 9   | 1     | Internal tests.                                                                                     | Public testnet parity, FIX certification program.                                                              |
| M20 | Institutional service   | 12  | 1     | Orgs exist.                                                                                         | KYB/ops coverage — mostly operating model, not a missing spec.                                                 |
| M21 | Fees                    | 11  | 1     | Preview plumbing; **no invented rates**.                                                            | Owner fee/rebate schedule.                                                                                     |
| M22 | Multi-venue / DEX       | 11  | 2     | Adapters; arb/DEX/indexer unknown≠fill.                                                             | Best-ex evidence, venue capital, owner venue set.                                                              |
| M23 | Finance / wind-down     | 11  | 2     | One ledger, unbalance refuse.                                                                       | Attestations, wind-down playbook as ops.                                                                       |
| M24 | Quant lifecycle         | 16  | 2     | Paper≠live, no ledger on paper.                                                                     | Full approve/deploy/runtime proof, Monte Carlo (named residual).                                               |
| M25 | OMS / TCA               | 16  | 3     | Stage, assign, kill, halt, TCA-unavailable-when-missing.                                            | Full care desk + TCA productization.                                                                           |
| M26 | Copy                    | 14  | 3     | Follower limits, pause≠flatten, flatten explicit.                                                   | Drift refuse + leader-integrity remaining.                                                                     |
| M27 | Convert / FX            | 11  | 2     | Convert is a firm quote, not a book fill.                                                           | FX settlement rail still socketed.                                                                             |
| M28 | Agentic                 | 18  | 2     | Research/read/draft cannot place/withdraw.                                                          | Bounded autonomous live, injection program as proven.                                                          |

## Do we need more spec?

**No new mountain list.** v1.20 added 12 R-items on existing mountains after a 31 August competitor pass (TradFi-linked perps, yield-bearing collateral, IFM, MMP two-sided, FIX version, off-book credit). Grok bot implements those; it does not recook boards.

Still **not** a spec gap (do not mill new docs):

- Owner magnitudes (fees, MMP, leverage, cooling hours, venue set) — Nitro, already `OWNER-SET`.
- FIX, options venue, surveillance ops, institutional custody — **already specified**; they need build, not another inventory.
- M20 service model — people/process as much as software.

Optional later (only if a child spec is silent on a **new** behavior): none identified this pass that should block implementation.

## Next implementation (unblocked)

1. Matching FileJournal `encode()` persist collar/min/max — crash must not rest a refused collar.
2. OMS `killLiveAlgoParent`: unknown child cancel ≠ `killed: true`.
3. Trade: RFQ expire must not overwrite a bound quote; copy drift/unavailable refuses (no invented flatten).
4. Bank offramp cooling — prior attempt **no unique commit**; still missing.
5. Only if still absent after (4): pay unknown≠success, token unknown≠pass, portfolio missing PnL named, WS sequence-gap honesty.

If `origin/main` already has the behavior, stop. No wrap mill.

## What Grok bot must not do

- Frontend / `05_Web_Front`.
- Invent owner numbers.
- Second SPA or second money book.
- Dual-write one service.
- Treat north-star **Maturity:** lines as live state.
- Wait for Nitro, CI-green, or a new spec factory.
