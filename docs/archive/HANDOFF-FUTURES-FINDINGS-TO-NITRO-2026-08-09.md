# Handoff — seven reproduced futures defects, and the branch I am abandoning

**From:** Denon (`Phantom-X-007`). **To:** whoever holds `services/svc-trade/src/futures/**`.
**Date:** 2026-08-09. **Tip at writing:** `886bea1f`.

Nitro's swarm is in `futures/**` right now — **#1349** (`liquidation-tick.ts`, `tick-stores.ts`, `maintenance-ladder.ts`) and **#1362** (`position-service.ts`, `ids.ts`) are both open. I am not going to race for the same lines. What follows is worth more from me than competing edits: **every defect below was reproduced against real code, not inferred.**

---

## First, a coordination finding that is mine to own

`LIVE-LANES` protects _"Denon's **open** integrity/money PRs"_, re-derived from `gh pr list`. Line 43 makes dual-editing those files "not free."

**That mechanism can only see what is pushed.** I had an agent's work sitting uncommitted in a worktree for several hours. `gh pr list` showed nothing holding `liquidation-tick.ts` or `position-service.ts`, so the swarm took them — **correctly. No lane was violated.** The protection had nothing to protect.

The fix is on my side and it is cheap: **push early, even as draft.** Recording it here because the same trap catches anyone whose agent works longer than a review cycle.

## The branch I am abandoning, and why

`10a4c0f7` on `fix/futures-accepted-mark-semantics` — five files, 1,303 insertions, 812 tests green but **pre-gates and unreviewed**. It is now **182 commits behind `main`** and every file collides with an open PR.

**Do not rebase it.** `docs/ops/STRANDED-BRANCH-TRIAGE-2026-08-08.md` established the pattern the hard way: of fifteen branches ~850 commits behind, **zero were worth reviving**, and the two that looked most mergeable would have done real damage — one regressed the board, one reintroduced a fleet-down migration. Rebasing a **money-path** branch across 182 commits to preserve work someone else is already rewriting is how a subtle regression lands with a green diff.

Take the findings. Re-derive the code.

---

# The seven defects

Ordered by whether money moves wrongly. Reproductions are described precisely enough to rebuild; two are preserved as runnable files, noted below.

## 1 · The deviation breaker is a latch, not a breaker — **money**

`futures/liquidation-tick.ts` records an accepted mark **only after** the mark cleared `acceptableForLiquidation`, including the breaker. Not recording a refused mark is correct — it is the anti-ratchet rule from `#965`, and it must stay.

But the refusal is measured **from the un-advanced basis**. Once the market moves more than `maxDeviationBps` (2000 = 20%) in one tick interval, **the basis can never advance again** and every subsequent tick refuses forever.

**Reproduced:** entry 100, size 10, leverage 10 (margin 100, maintenance 50). Feed 100 → 74 — an ordinary crypto day. Twenty consecutive ticks: `liquidated: 0`, `skipped_mark_unusable` every time, `accepted_mark` still `'100'`. Then 74 → 70 → 60 → 50 → 40 → 30: still `liquidated: 0`. Equity −260 against 100 of margin, **permanently unliquidatable**, while the funding loader still sees `status='open'` and keeps draining `margin_current`.

`futures/mark-policy.ts:75-80` claims the property the code lacks: _"Refusing to liquidate through the breaker costs a genuine crash **one interval**."_ One interval only if the basis walks.

**The hard part:** a refused mark must not become the basis, or `#965`'s ratchet attack returns; but an honest crash must advance it. **The discriminator must not be attacker-controlled.** `19340c9e` made the depth requirement scale with position notional, so posting a fake price is now expensive _in proportion to what it authorises_ — that is probably the load-bearing ingredient. If no safe discriminator exists without an owner ruling, say so rather than guessing.

## 2 · Nothing walks the basis on the shipped default — **money**

`accepted_mark` is written in exactly two places: `position-service.ts` (a completing close) and `liquidation-tick.ts` (the tick). `futures-jobs.ts` returns before wiring the tick when disabled, and `env.ts` defaults `TRADE_FUTURES_JOBS_ENABLED` to **`false`**. `sqlAcceptedMarkStore.record` also filters `AND status = 'open'`.

So on the shipped default **a position's basis is frozen at its entry mark for its entire life.**

**Reproduced:** open at 100, size 10, leverage 1. Market walks honestly 105 → 110 → 116 → 122 → 128 → 130 with no tick. Ten close attempts, all `trade.mark_unusable`. The only exit is to surrender the gain — at 119 the close succeeds and pays 190.

**Asymmetric by construction:** `requirePayoutGrade` is called only when `plan.profit > 0n`, so a **losing** position exits at any deviation while a **winning** one is held. [`adr/2026-08-07`](adr/2026-08-07-futures-exit-when-the-feed-is-dark.md) already ruled that a control which traps funds is not a safety control. **A guard that only ever traps winners is worse than one that traps everyone.**

**Do not fix this by defaulting `TRADE_FUTURES_JOBS_ENABLED` to true.** Turning funding on for a market is owner-reserved. Fix the trap, not the flag.

## 3 · A `closing` position is charged the whole move that happened after it asked to leave — **money**

[`adr/2026-08-07`](adr/2026-08-07-futures-exit-when-the-feed-is-dark.md) properties item 2 is explicit: _"a `closing` position … **takes no further mark-driven loss.** Whatever the market does while the feed is dark is not charged to someone who already asked to leave."_

**Nothing implements it.** `position-service.ts` settles a `closing` row at the **current** mark, with no reference to the mark at freeze time — even though it is sitting on the row in `accepted_mark`.

**Reproduced:** open 10 @ 100, feed dark, close → `closing` with `accepted_mark='100'`, feed returns at 85, settle → the trader is charged **150 USDT** for a 15% move that happened entirely during our outage. No test in the suite feeds a _worse_ mark to a `closing` position — the existing ones use a better mark or a move so large it is refused.

## 4 · A `closing` position past the breaker is trapped with no exit at all — **money**

Freeze at `accepted_mark` 100; feed returns at 400. Every close is refused by the breaker. The tick returns `scanned: 0` (`position-loaders.ts` filters `status='open'`). `sqlAcceptedMarkStore.record` also filters `status='open'`, so the basis cannot advance even if a tick saw it. Operator adjudication is ruled _"until it is decided, the answer is no."_ **Four exits, all closed.** `position-service.test.ts:406` asserts this and calls it correct.

**ADR 08-07 done-bar item 4 — "settles at the first usable mark" — is not met** for any move exceeding `maxDeviationBps`.

**My ruling on 3 and 4, which have one answer:** **a `closing` position settles at its freeze-time `accepted_mark`.** That satisfies item 2 directly and dissolves 4 entirely — if the settlement price _is_ the basis there is no deviation to breach. Neither party is held to anything that happened during our outage. `accepted_mark` is **our own last gated mark**, not one the trader supplies, and nobody chooses when our feed goes dark, so there is no gaming surface I can find. **If you find one, say so and propose the alternative.** The one place I may be wrong: whether item 2's _"in the trader's favour"_ obliges paying post-exit **gains** rather than settling neutrally. I read it as a floor on losses, not a promise of upside.

## 5 · There is no margin call in futures at all — **done-bar item 6 not met**

`grep -rn "marginCall\|margin_call\|grace"` over `services/svc-trade/src` returns **zero hits outside tests.** No margin call, no grace clock, no notice of any kind.

[`adr/2026-08-05`](adr/2026-08-05-futures-risk-and-mark-law.md) Liquidation: _"A margin call must precede a liquidation, with grace, or 'the borrower's first notice of the loan would be its liquidation receipt.'"_ Done-bar item 6 — _"a margin call with no transport does not start a grace clock"_ — **is satisfied only vacuously:** no clock starts because no call exists, and the liquidation fires anyway.

**Reproduced:** open at 100, margin 100, feed 95 — **the first tick liquidates.**

Also unimplemented from the same section: _"Sell only enough to restore target, never the whole position by default."_ `liquidation-planner.ts` has no tranche sizing, no `maxTrancheBps`, no partial. It is a full close.

**Note for whoever takes this:** #1349 adds `futures/maintenance-ladder.ts`. Read it first — it may already be the foundation for this, in which case the ladder is a smaller change than it looks.

## 6 · The `quote()` fallback relabels an unlabelled mark as liquidation-grade

`position-service.ts:250-260` and `liquidation-tick.ts:117-131` relabel an unlabelled `markPrice` string as `{ quality: 'mid', asOf: at }`.

Split honestly: **`asOf: at` is defensible** — an unlabelled string genuinely has no observation time. **`quality: 'mid'` is not** — the source never claimed it, and `mid` is a _liquidation_ quality. So a `MarkSource` omitting the optional `quote()` silently disarms the quality gate **and** both staleness gates, leaving only sign and the breaker.

`PositionServiceDeps.marks` is typed `MarkSource` where `quote` is **optional**, so a future adapter omitting it compiles and disarms two of three gates with no warning. This is the same optional-safety-port shape `#965` eliminated by making `LiquidationTickDeps.acceptedMarks` **required** — consider doing the same to `quote()`.

## 7 · The MM seeder bypasses `assertTradable` entirely

`services/svc-trade/src/mm/seed-market.ts:142` calls `deps.matching.submit(...)` directly. Grep the seeder for `assertTradable`, `futuresEnabled` or `TRADE_FUTURES_ENABLED`: **zero hits.**

Every _user_ order passes `assertTradable` in `spot/risk.ts`, which enforces market kind, halted status, and — since `#1118` — the futures flag. The house seeder goes around all of it, so today the house can rest orders on a **futures market while `TRADE_FUTURES_ENABLED` is false**, and on **halted** markets.

This matters because of `#1165`'s chain: MM-seeded orders become **matching depth**, and `markSourceFromDepth` derives **futures marks** from that depth. Its finding, verbatim: **"refused as somebody else's quote, accepted as ours."** A price rejected as untrustworthy from a venue re-enters as trustworthy because we posted it.

It also lands on [`adr/2026-08-08-house-desk-and-market-making-fairness.md`](adr/2026-08-08-house-desk-and-market-making-fairness.md) **settled rule 2**: _"until the owner rules, matching treats the house tenant as an ordinary participant."_ Posting where users are refused is a structural advantage whether or not anyone intended it. **No new ruling needed.**

Two shortcuts to avoid: **do not write a second gate** with its own opinion (a divergent copy is how the original defect returns), and **do not add an `isHouse` bypass** — that is the finding, re-implemented with a nicer name. If the seeder legitimately needs to seed a market users cannot trade, that is an **owner question**.

---

## Reproductions preserved

Two runnable files, from the adversarial review that found #1–#5:

```
…/scratchpad/zz-adversarial-repro.test.ts   (F1–F6: latch, frozen basis, closing charge, closing trap, staleness, no-margin-call)
…/scratchpad/zz-exploit-repro.test.ts       (the extraction, now CLOSED by 19340c9e — keep as a regression corpus)
```

Drop either into `services/svc-trade/src/futures/` and `npx vitest run` it. The exploit repro should now be **red**; if it ever goes green again, `19340c9e` has been reverted.

## What is already fixed, so nobody re-does it

`#950` boot outage + concurrent-close double-pay · `#965` breaker armed with a stored basis + internal mid size-aware · `#983` venue mid size-aware · `#995` the `closing` state · `#1103` cross-margin CHECK · `#1118` orderability behind a flag · `cd1f79b5` the `closing` uniqueness question (**deliberately not tightened** — read the migration before changing it) · `#1163` staleness gates now reachable · `19340c9e` **relative** depth floor + the first leverage cap · `88a718f1` the third size-blind mid.

## Three numbers awaiting the owner

Each in one named constant, all `DIRECTION` §8 item 8: `DEFAULT_MAX_LEVERAGE = '10'`, `DEFAULT_MIN_BEST_LEVEL_BPS_OF_NOTIONAL = 100` (bps), `DEFAULT_MIN_BEST_LEVEL_NOTIONAL = '100'` (quote units). **Do not add a fourth** — implement mechanisms and report the number.

## The pattern worth carrying out of this subsystem

`svc-trade` futures produced **eight** guards in one week that were correct in isolation and unreachable in place, each carrying a comment asserting the property the code lacked. Two more variants turned up on top:

- **a fix that does not generalise** — the size-blind mid was fixed twice and was still live in a third place, ungated (`#1165`);
- **a double that lies the same way production does** — three pinned type errors were adapter doubles omitting `observedAt` against a contract requiring it. A double that drops a required field **cannot fail** when the code drops it too.

**Test the guard through the public entry point, and when you fix a discard, grep for every site that touches the same field.**
