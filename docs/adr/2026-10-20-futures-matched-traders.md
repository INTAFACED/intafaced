# ADR: futures match trader against trader, and settle through one clearing pot on the ledger

**Status:** accepted 2026-10-20. Decided on evidence by an agent under the project's decision rule (Nino, 2026-10-20 05:01: decide without waiting on Phantom; Phantom may overrule afterwards).
**Date:** 2026-10-20
**Area:** perpetual and dated futures in `services/svc-trade/src/futures/`, the futures recipes in `packages/ledger-client/src/recipes/index.ts`, futures markets in `services/svc-matching`.
**Answers:** architecture call 3 ("futures engine vs the one-ledger rule"), and makes the payout default decided on #5089 (2026-10-20) concrete.
**Supersedes, by the owner's rule:** the line in the [futures risk and mark law](2026-08-05-futures-risk-and-mark-law.md) ("The payout bound" and its PKT-B5 seal) that reserves to the owner the choice of account that pays realised profit, and the same reservation in engine spec X-7 and J-1. The authority is Nino's rule of 2026-10-20 05:01 (agents decide on evidence, without waiting on Phantom, who may overrule) and the closing decision on #5089 (2026-10-20 05:03), which named the futures loss pot. The rest of that ADR stands. The PKT-B5 rule that the setting has no default also stands (section 3).
**Does not decide:** the liquidation fee (an owner carve-out in the 2026-10-14 ADR; the insurance ADR allows no second inflow recipe), ADL ranking numbers, the insurance target size, and the price band width. Each stays blank and refuses on live; the TEST profile may set a value labelled TEST.
**Builds on, does not replace otherwise:** [futures risk and mark law](2026-08-05-futures-risk-and-mark-law.md) (a price that moves money is never supplied by the party it pays; isolated margin only), [insurance fund funding policy](2026-08-13-insurance-fund-funding-policy.md) (empty fund, no real-money listing; the fund is a ledger account), [liquidation shortfall insurance leg](2026-10-14-liquidation-shortfall-insurance-leg.md) (rung serialisation, divergence guard, reconciliation), [matching dual-target](2026-08-04-matching-dual-target.md) (a fill is final when the ledger has posted it), [house desk and market making](2026-08-08-house-desk-and-market-making-fairness.md).

## Context

Checked on `origin/main` 8559312 (2026-10-20).

- **The house is the counterparty of every futures trade.** `PositionService.open` (`position-service.ts:920`) opens a position at the mark with no order and no other trader. `close` settles at the mark (`position-service.ts` around `:1990`, `planClose` in `close-planner.ts`). Losses go into `futuresLossSink`; profits are paid by `futuresRealizeProfit` out of `houseFees('trade')` (`recipes/index.ts:659`). So the house's fee pot is the risk book, with no hedge and no ceiling except the payout bound in `profit-source.ts`.
- **That is where the payout bug comes from.** A winner is paid from a pot that has nothing to do with the losers on the other side, so a run of winners drains it and every later winner is refused (engine spec D1 and D2; #5089). The expiry loop no longer stops at the first refusal (#5267), but "who pays winners" was left blank.
- **Funding is already peer to peer** (`futuresFundingPay` moves value from one position's pot to another trader), but with no matching the long and short sides are never equal, so the unmatched side is skipped (`funding-settlement.ts`, engine spec FD-5).
- **`svc-matching` is already the one order book and is product-agnostic.** It speaks account ids and quantities and has no balances (its README). Nothing stops a futures market id from being a market there.
- **ADL exists only as a gate.** `adl-last-resort.ts` refuses without an owner policy, reduces only the winning candidate, never the bankrupt side, and has no reducer implementation (`liquidation-adl-gate.ts`).

## Options

- **A. Keep the house as counterparty.** Simple. Winners are paid out of house money, and when the pot runs dry they cannot close. The house carries unhedged directional risk on every market. Rejected.
- **B. Matched traders, a margin book beside matching, an insurance fund, ADL.** Every long is someone's short. Losers pay winners through one ledger account. Chosen.
- **C. A separate perps ledger.** Fast, but it is a second money book. Breaks Money rule 3. Rejected.

## Decision

### 1. One order book

A futures market is a market in `svc-matching`, exactly like spot. `svc-trade` sends futures orders there and settles the fills. There is no second matcher, no RFQ against the house and no "open at mark". Every change in open interest is a fill between two accounts, so long size always equals short size. The house desk may quote like any other account under the house-desk ADR; it is never the default counterparty.

**The fill price moves money between two traders, so it is bounded.** The risk ADR's rule (a price that moves money is never supplied by the party it pays) is kept this way:

- **Price band.** `svc-trade` refuses a futures order whose limit price is outside a band around the mark, and gives a market order a protective limit at the band edge. The band width is an owner number; blank refuses `trade.futures_price_band_unset` (the TEST profile sets a TEST value). Two colluding accounts can then only trade near the mark.
- **No fill past bankruptcy.** A reducing or closing order may not have a limit beyond the position's bankruptcy price, and a market reduce gets that price as its limit. So a voluntary reduce or close can never create loss beyond margin. Only a liquidation order may go past it, and only by what the insurance fund covers (section 5).
- **No opening fill underwater past its margin.** An order that opens or grows a position locks initial margin at the mark plus the adverse distance between its limit and the mark (`size × (limit − mark)` for a buy above the mark, mirror for a sell). So right after any fill inside the band, equity at the mark is at least initial margin, whatever leverage the market allows and however wide the band is. A fill at a better price releases the unused part.
- **Resting reduce orders follow the margin.** When margin changes (funding, add, release), resting reduce orders whose limit is now past the new bankruptcy price are re-priced to it or cancelled.
- The mark stays the only price for margin, liquidation triggers and payout grade, exactly as the risk ADR says. The fill price only splits realised PnL between the two traders who agreed it, inside those two bounds.

Liquidation orders go through the same book (rule 5). ADL is not an order book: it is a forced transfer of position between two named accounts at one stated price, recorded in the margin book and posted to the ledger (rule 6).

### 2. The margin book holds positions, never balances

The margin book is the futures tables `svc-trade` already owns (`trade.positions`, liquidation rungs, funding periods), plus order margin records. A row may hold only:

1. **a position**: market, side, size, entry price, leverage;
2. **a mirror of a ledger pot**: for example `margin_current`, which must equal the `position:<id>` collateral account and is checked against it (the divergence guard and reconciliation of the 2026-10-14 ADR);
3. **an intent to post**: a recipe, its business key and its amounts, written before the first ledger call and posted exactly once (engine spec X-1, as rungs already do).

No row is spendable, transferable or withdrawable. Every check that lets money leave (payout bound, insurance bound, withdrawal) reads the ledger, not a row.

### 3. One clearing pot per asset

`futuresLossSink(asset)` becomes the clearing pot for that asset. The account id does not change.

- Losses go in through `futuresRealizeLoss` (unchanged).
- Profits come out through `futuresRealizeProfit`, re-pointed from `houseFees('trade')` to the clearing pot. This is the #5089 default, now with the reason it is correct: with matched traders, every unit of profit is a unit some other trader lost.
- The insurance fund pays in only through the bankruptcy leg of `futuresRealizeLoss` (`fromInsurance`, unchanged). It never pays a winner directly.
- Fees are not in the pot. Trading fees go to `houseFees` through a fee recipe. A liquidation fee is not decided here; with none set, none is charged (engine spec LQ-1).
- `TRADE_FUTURES_PROFIT_SOURCE` stays a named setting with no default and must name the clearing pot (`profit-source.ts` already checks the setting against the recipe's funding leg). The TEST profile names it; live stays blank until the real-funds day.

**The identity.** Once every position comes from a fill (phase 1 slice 6), trades are zero-sum at fill prices, so for any mark M:

`clearing pot = Σ unrealised PnL of open positions at M + Σ payouts owed but not yet paid` (funding and fees aside, since they never touch the pot).

So the pot is short of a winner only while losers still hold their losses as unrealised, or while a bankrupt loss has not been booked. Neither is solved by drawing on the house.

The identity needs every open position to come from a fill. Positions opened at the mark under today's model are test-money only; slice 6 closes them out before matching turns on for a market. Until then pending payouts under the house model may not clear, which is acceptable on test money.

### 4. Settling a winner

1. The payout bound reads the clearing pot inside the position row lock (as it does today against the configured source).
2. If the pot covers it, `futuresRealizeProfit` posts.
3. If it does not, the position still closes, because the fill already happened in the book, and the profit becomes an intent row in state `payout_pending` with refusal code `trade.clearing_pot_short`. A tick retries it with the same key and pays it exactly once when the pot holds it. Margin is released as normal, the pending profit is shown to the trader, and nothing is minted, scaled down or paid from house money (#5089 point 3).
4. The bound is read under the position's own lock only, so two winners can race for the same pot. The intent row is written before the post, and a ledger insufficient-funds answer on the profit leg turns into `payout_pending`, never an error after margin has moved.
5. The total owed is shown wherever the pot is shown (the futures reads and the reconciliation report), so the liability is visible next to the ledger balance, not only inside a row.
6. Phase 2 (below) removes most of the wait by collecting losers' variation at the mark.

### 5. Liquidation, insurance and bankruptcy

1. A position under maintenance is reduced by a reduce-only IOC order in the book. Its limit is the bankruptcy price, widened only by what the insurance fund can cover at that moment (bounded by the live balance, as `insurance-bound.ts` does). This is dYdX v4's rule: insurance pays by allowing a worse fill price (engine spec E-h, E-i).
2. A fill worse than the bankruptcy price books the excess through `fromInsurance`. A fill better than it leaves collateral, which is released to the trader. No liquidation fee is charged unless the owner sets one (engine spec LQ-1).
3. Whatever the book cannot fill is bankrupt and goes to ADL.
4. The existing rung machine, serialisation and park rules (2026-10-14 ADR) stay. Only the source of the closing fill changes, from "the mark" to "the book".

### 6. ADL

ADL closes the bankrupt remainder against opposite-side positions at the **bankruptcy price**, so the bankrupt trader loses exactly their margin and the insurance fund pays nothing. It is zero-sum at that price, so the identity in section 3 still holds.

- Both sides shrink by the same size under both row locks, taken in position-id order. The intent rows for both legs are written in that transaction.
- The bankrupt side posts `futuresRealizeLoss(fromMargin = remaining margin)` first.
- The candidate's profit at the bankruptcy price is `size × (candidate entry − bankruptcy price)` for a short candidate, mirror for a long. It differs from the margin just paid in by `size × (candidate entry − bankrupt entry)`, so it can be larger than the pot. It therefore goes through the same payout bound as any winner (section 4): paid if the pot holds it, otherwise `payout_pending`. ADL never fails because a payout is short.
- Candidates are opposite side, same market, a different user, in profit at the bankruptcy price, and acknowledged the ADL disclosure. They are ranked by the owner formula (engine spec LQ-3); a blank formula refuses `trade.adl_unconfigured`, as today. The TEST profile supplies a ranking labelled TEST (profit percentage times leverage, highest first) so the test rig can exercise it. Live stays blank.
- Keys: `futures.adl:<bankruptPositionId>:<rungId>:<candidatePositionId>` with `:loss` and `:profit` legs.

### 7. Funding

Unchanged in shape. Because long size now equals short size, the imbalance case in FD-5 cannot arise from matching. Funding stays peer to peer and never touches the clearing pot.

### 8. Order margin

An order that opens or grows a position locks initial margin, plus the adverse distance to the mark from section 1, before it rests, so a fill never needs money the trader no longer has. This needs an order margin hold recipe in `packages/ledger-client` (engine spec J-6), and its own PR before the order path.

## Fit with the Money rules (AGENTS.md)

| Rule                                                                                  | How B stays inside it                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Value moves only through `ledger-client` recipes; `svc-ledger` is the only balance | Every movement is an existing or new recipe: margin lock, add and release, realise loss, realise profit, funding, insurance top-up, plus the new order margin hold recipe. The margin book holds positions, mirrors and intents only (section 2), and every money-out check reads the ledger. |
| 2. No money in a `number`                                                             | Unchanged: scaled bigint in memory, decimal strings on the wire.                                                                                                                                                                                                                              |
| 3. No second money book, no service-held balance, no second order book                | Margin book rows are positions, ledger mirrors and intents, never spendable (section 2). `svc-matching` is the only order book (section 1). ADL is a position transfer at one price, not an order book. The insurance fund and the clearing pot are ledger accounts.                          |
| 4. Business keys, failure branches, invariant test                                    | Keys: `futures.fill:<marketId>:<sequence>:<positionId>`, `futures.profit:<closeId>`, `futures.adl:…` (section 6). Invariant tests: the identity in section 3, and long size equals short size per market.                                                                                     |
| 5. Protocol Plane never imports write recipes                                         | Not touched.                                                                                                                                                                                                                                                                                  |
| 6. Freezes                                                                            | Account freeze stays with `svc-identity`; the posting freeze stays with `svc-ledger`.                                                                                                                                                                                                         |

**No gate-file rule change is needed.** B fits the rules as written. Two places come closest, and both stay inside: a `payout_pending` row is an intent to post one recipe with one key (section 2, kind 3), never spendable, and its total is shown beside the pot (section 4). In phase 2 the margin book computes each account's net result between posts. That includes PnL realised by fills inside the window, so phase 2 must hold it as intents (kind 3) keyed per account and window, with the same total shown beside the pot, and nothing is paid or withdrawn until the ledger has posted it. Phase 2 is built only after its own review against this rule.

## Phases

**Phase 1, test money.** These are the slices the futures lanes wait on. Each is one PR, in this order where they depend on each other.

| #   | Slice                                                                                                                                                                           | Package or service                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| 1   | `futuresRealizeProfit` draws from the clearing pot                                                                                                                              | `packages/ledger-client`                    |
| 2   | Payout bound and `payout_pending` against the clearing pot; the TEST profile names it                                                                                           | `svc-trade`                                 |
| 3   | ADL pairs both sides at the bankruptcy price, with a reducer, keys and the zero-sum test                                                                                        | `svc-trade`                                 |
| 4   | Grant an insurance top-up writer for the existing `futuresInsuranceTopup` (D7)                                                                                                  | `svc-ledger`                                |
| 5   | Order margin hold recipe (J-6)                                                                                                                                                  | `packages/ledger-client`, then `svc-ledger` |
| 6   | Futures orders through `svc-matching` with the price band and bankruptcy bound, fills update both positions, open and close at mark retired and their test positions closed out | `svc-trade`                                 |
| 7   | Liquidation by reduce-only IOC in the book, insurance-widened limit, remainder to ADL                                                                                           | `svc-trade`                                 |

Slices 1 to 3 run under today's model as well, so they land first. Their pending payouts may not clear until slice 6 (section 3).

**Phase 2, designed, built before real funds. Variation settlement in batches.**

- On a timer, and whenever a payout is pending, each open loser's unrealised loss at the mark is realised into the clearing pot from their own margin (`futuresRealizeLoss`, key `futures.variation:<positionId>:<batchId>`). The row's margin drops by the same amount and its settlement basis moves to the mark. Equity is unchanged; the original entry price is kept for display. After a pass, the identity in section 3 gives `pot ≥ every open winner's gain at the mark`, so a pending payout waits one pass at most.
- The same pass is the throughput fix. Fills update the margin book only, and each account's net result for the window is posted as one ledger entry per account, instead of one post per fill. The per-fill ledger load disappears (the per-file ledger figure is about 200 to 350 posts a second). The risk between passes is covered by the order margin already locked and by liquidation.
- Not built now, because test money does not need the throughput and phase 1 is already correct (just slower to pay).

## Consequences

- Good: the house no longer carries directional risk; winners are paid from losers; funding balances; the insurance fund pays only bankruptcies; every number in the margin book can be checked against the ledger.
- Bad: winners can see `payout_pending` until phase 2, and the trade path gets longer (order, then match, then settle).
- Risk: a thin book makes liquidation fills worse, so the insurance fund and ADL get used more. Monitor ADL count and insurance draws per market.
- Undo: the recipe change and each slice revert as one PR each. Ledger postings already made are correct facts and stay.

## Revisit when

- Phantom overrules any part of this.
- Real funds are near: phase 2 must be built first.
- A cross-margin mode is proposed: the isolated-only assumptions in sections 5 and 6 need redoing.
- The owner publishes ADL ranking, price band or insurance target numbers: they replace the TEST values.
- The owner decides a liquidation fee: it needs its own recipe and an update to the insurance ADR.
