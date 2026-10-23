# Spec factory index — D-S-01…18, what exists and what is genuinely blank

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Written by:** Denon, 2026-08-04. **Status:** authoritative index for the D-S board (**18/18 done**).  
**The board it indexes (factory origin):** [`DENON-HARD-TASK-BOARD-FROM-NITRO-SWARM-2026-08-03.md`](DENON-HARD-TASK-BOARD-FROM-NITRO-SWARM-2026-08-03.md) §3.  
**Live Denon hard inventory (engines / rulings after factory):** [`LAST-MVP-BOARDS-2026-08-23.md`](LAST-MVP-BOARDS-2026-08-23.md). Historical 120-ID list: [`DENON-HARD-PARALLEL-BOARD-2026-08-09.md`](DENON-HARD-PARALLEL-BOARD-2026-08-09.md).

---

## Why this file exists

**Seven of the eighteen spec slots were already satisfied by documents merged on 1–2 August, and no board cited them.** The 2026-08-03 board was written without them, so agents have been waiting on specs that were on `main` the whole time.

A `grep` across `DENON-HARD-TASK-BOARD`, `THREE-WAY-DISTRIBUTION`, `LIVE-LANES`, `INTERNET-LEVERAGE`, `REGROUP` and `AGENTS.md` for `SPEC-LENDING|SPEC-OTC|SPEC-PAY-VERTICALS|SPEC-SOVEREIGN|SPEC-SUBACCOUNTS` returns **zero hits**. Only `DIRECTION-2026-07-31.md`, `SHEHZAD-BLOCKCHAIN-TASK-BOARD` and `TRACKER.md` link them.

That is the whole failure: **the work was done and the pointer was missing.** This file is the pointer.

---

## The index

| ID            | Status   | Where the law lives                                                                                                                                                                                                                        |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **D-S-01** ✅ | **done** | [`adr/2026-08-05-futures-risk-and-mark-law.md`](adr/2026-08-05-futures-risk-and-mark-law.md) on `DIRECTION` §1, amended by [`adr/2026-08-07-futures-exit-when-the-feed-is-dark.md`](adr/2026-08-07-futures-exit-when-the-feed-is-dark.md). |
| **D-S-02** ✅ | **done** | [`SPEC-OTC-RFQ-AND-EARN-2026-08-02.md`](SPEC-OTC-RFQ-AND-EARN-2026-08-02.md) Part A                                                                                                                                                        |
| **D-S-03** ✅ | **done** | [`SPEC-SOVEREIGN-ROUTING-AND-COPY-2026-08-01.md`](SPEC-SOVEREIGN-ROUTING-AND-COPY-2026-08-01.md). `DIRECTION` §1 marks the old ban superseded by it.                                                                                       |
| **D-S-04** ✅ | **done** | [`adr/2026-08-04-algo-execution-law.md`](adr/2026-08-04-algo-execution-law.md), on `DIRECTION` §1 (TWAP only, icebergs out).                                                                                                               |
| **D-S-05** ✅ | **done** | [`adr/2026-08-04-instrument-enum-authority.md`](adr/2026-08-04-instrument-enum-authority.md) on `DIRECTION` §2.                                                                                                                            |
| **D-S-06** ✅ | **done** | [`adr/2026-08-04-matching-dual-target.md`](adr/2026-08-04-matching-dual-target.md) — fill-finality answered; INTACORE has zero code refs.                                                                                                  |
| **D-S-07** ✅ | **done** | Lending: [`SPEC-LENDING-2026-08-02.md`](SPEC-LENDING-2026-08-02.md) §1. Futures mark: [`adr/2026-08-05-futures-risk-and-mark-law.md`](adr/2026-08-05-futures-risk-and-mark-law.md)                                                         |
| **D-S-08** ✅ | **done** | [`adr/2026-08-04-p2p-escrow-and-dispute-law.md`](adr/2026-08-04-p2p-escrow-and-dispute-law.md) — escrow-plane conflict resolved.                                                                                                           |
| **D-S-09** ✅ | **done** | Earn half: `SPEC-OTC-RFQ-AND-EARN` Part B + `DIRECTION` §7. Cards/ramps §13 boundary: [`adr/2026-08-04-bank-vertical-law.md`](adr/2026-08-04-bank-vertical-law.md)                                                                         |
| **D-S-10** ✅ | **done** | [`SPEC-PAY-VERTICALS-2026-08-02.md`](SPEC-PAY-VERTICALS-2026-08-02.md) + [`adr/2026-08-04-pay-rails-and-psp-socket.md`](adr/2026-08-04-pay-rails-and-psp-socket.md)                                                                        |
| **D-S-11** ✅ | **done** | [`SPEC-SUBACCOUNTS-2026-08-02.md`](SPEC-SUBACCOUNTS-2026-08-02.md). Adjacent: [`adr/2026-08-04-authority-and-refusal-shape.md`](adr/2026-08-04-authority-and-refusal-shape.md)                                                             |
| **D-S-12** ✅ | **done** | [`adr/2026-08-04-cross-plane-bridge-accounting.md`](adr/2026-08-04-cross-plane-bridge-accounting.md) — accounting law only; chain side is Shehzad S-D7/S-B5.                                                                               |
| **D-S-13** ✅ | **done** | [`adr/2026-08-04-event-socket-vs-broken-promise.md`](adr/2026-08-04-event-socket-vs-broken-promise.md)                                                                                                                                     |
| **D-S-14** ✅ | **done** | [`adr/2026-08-04-token-economics-outcomes.md`](adr/2026-08-04-token-economics-outcomes.md) — decides no number; decides whose they are.                                                                                                    |
| **D-S-15** ✅ | **done** | [`adr/2026-08-04-platform-pages-ia.md`](adr/2026-08-04-platform-pages-ia.md) — law only, craft stays Nitro.                                                                                                                                |
| **D-S-16** ✅ | **done** | [`adr/2026-08-04-class-m-hold-language.md`](adr/2026-08-04-class-m-hold-language.md) on `DIRECTION` §3.                                                                                                                                    |
| **D-S-17** ✅ | **done** | Decision: `DIRECTION` §4 (Option B). Residual: [`adr/2026-08-04-java-dual-book-residual.md`](adr/2026-08-04-java-dual-book-residual.md)                                                                                                    |
| **D-S-18** ✅ | **done** | [`adr/2026-08-04-predict-quant-connect-law.md`](adr/2026-08-04-predict-quant-connect-law.md) — §27 in scope; §28/29 blocked on it; §32 is 5P.                                                                                              |

**Tally: 18 done · 0 partial · 0 blank.** Every slot is law. The board read as 17 blank.

---

## What this changes for agents, today

**Agents may now implement against D-S-02 through 06, 08 through 17 without waiting.** Those fifteen are law on `main`. The "blocked on Denon" label on them was wrong and is withdrawn.

**D-S-01 and 07 are partially law.** Implement the decided part; do not invent the rest. Each row above names which half is which.

**Every slot is now law.** The board read as 17 blank on the morning of 2026-08-04.

---

## Two things this index does not fix

**`D-S-02`, `03`, `09`, `10`, `11` being law does not mean the numbers are decided.** `DIRECTION-2026-07-31.md` §8 is a live ten-item owner-only list — `leader_share_bps`, every fee-share rate, the copy jurisdiction list. **Copy trading's shape is specced and its rates are not**, so D-S-03 unblocks the mechanism and not the launch. Same pattern elsewhere: a spec that says "disclose the spread" does not say what the spread is.

**Roughly twelve owner-gated product decisions have no D-S number at all**, so nothing tracks them: launchpad raise economics, chain governance parameters, consensus params, slash percentages, forex PnL settlement asset, fee/listings/treasury law, scanner signal inputs, attestation threat model, plus `market.vendors`, `mining.pool`, `trade.options`, `trade.ccxt-api`, `venue.aggregation`, `market.commerce`. They sit in `docs/ops/trk/*` naming Denon as blocker with no board row pointing at them.

The sharpest of these: **`dex.quote-router` is finished code that cannot serve a quote**, because `socket.dex-venue-set` records that nobody has decided which venue this platform quotes. One sentence ships a completed service.

---

## One rule that cost two ADRs

> **A gate that freezes a pre-existing finding pins it by an explicit hand-written list. It does not fail unconditionally.**

[D-S-13](adr/2026-08-04-event-socket-vs-broken-promise.md) and [D-S-14](adr/2026-08-04-token-economics-outcomes.md) both said "fail the build" about findings that **already existed**. Both were implemented faithfully, and both produced a gate red on `main` with no path to green — one waiting on four owner numbers, the other on an owner ruling the same ADR reserved. Either would have blocked every unrelated merge in the repo.

**The repo already knew better.** `fabricated-money-scan` froze 12 findings. `vendor-java-money-scan` froze 63, now 55. `wallet-rpc-mainnet-scan` froze 38. **Not one of them fails on its pre-existing set** — and that is exactly why all three are still in the build rather than disabled.

A red that must be routed around to get any work done is a red that gets deleted, and it takes the honest part with it. The pin achieves the real requirement — the finding cannot be shipped further, resolved silently, or forgotten — without holding the repo hostage to a decision that is not the gate's to make.

Both ADRs carry the correction where the rule lives. It is recorded here as well, because it was the same mistake twice in one afternoon and the next author should meet it before making it a third time.

---

## The rule that has now cost three findings in one subsystem

> **A guard that is correct in isolation and unreachable in place is not a guard. Test it where it is wired, not where it is written.**

`svc-trade` futures produced the same defect three separate times, each caught only by adversarial review and never by a test:

| Guard                                             | Correct in isolation                           | Why it never ran                                                                          |
| ------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------- |
| The deviation breaker                             | Unit-tested, integer-only, rounds up correctly | `previous` is `null` at every call site — no production caller supplies `previousMarkFor` |
| `requirePayoutGrade`'s losing-close exemption     | Genuinely exempts losing closes                | `markFor` threw two calls earlier, so the exemption is dead code                          |
| `profitSourceFromConfig`'s refusal (#883, `#950`) | Refuses an unnamed payout account              | Exactly one value was legal, so the refusal was an outage, not a decision gate            |

Each has a comment stating the property it does not have. **A comment asserting a guard's behaviour is not evidence the guard runs** — in all three cases the comment is what stopped anyone looking. The test that would have caught every one of them is the same shape: exercise the guard through the public entry point and assert the refusal, rather than calling the guard function directly.

[The exit-when-dark ADR](adr/2026-08-07-futures-exit-when-the-feed-is-dark.md) carries the product half of this. This row is the engineering half, and it generalises past futures.

---

## Maintaining this file

When a D-S slot moves, edit this table in the same commit. An index that lags is worse than none — the seven-slot gap above exists precisely because the board and the specs were updated in different commits by different people, and neither noticed.
