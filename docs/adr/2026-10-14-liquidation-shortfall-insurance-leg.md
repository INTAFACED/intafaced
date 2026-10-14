# ADR: A liquidation shortfall is serialised first, then booked to the insurance fund

**Status:** accepted (phased). **Phase 1** (serialisation, divergence guard, reconciliation) ships in the PR that adds this file. **Phase 2** (partial-rung insurance booking with the `g + c_est` bound and same-tick takeover) is accepted as the next step and is not built yet.
**Date:** 2026-10-14
**Deciders:** agents (Opus), reviewed by chat 2 2; a fresh Opus refuter verified the evidence and changed the plan (see "What the refutation changed")
**Area:** svc-trade perpetual futures liquidation (`services/svc-trade/src/futures/`), ledger recipes `futuresRealizeLoss` / `futuresInsuranceTopup`
**Owner carve-outs touched:** none. No new recipe, no migration, no owner number invented. Two follow-up decisions that ARE owner carve-outs (DIRECTION §3) are listed below and are not taken here.

## Context and problem

A liquidation rung is planned against the position's margin. Before its loss posts, the position's isolated collateral pot (`position:<id>` in the ledger) can shrink: a funding payment, a margin withdrawal (`reduceIsolatedMargin`), a leverage change that releases margin (`setLeverage`), or a voluntary close can all move money out. The ledger then refuses the loss (`ledger.insufficient_funds`). The question is who pays the gap and how it is booked.

What `driveRung` in `liquidation-tick.ts` does today:

- **Closing rung.** The pot leg drops to what the pot holds and the gap moves to the insurance leg of the same `futuresRealizeLoss` key, after `checkInsuranceBound`. If the fund cannot cover it, the position is parked and `parkUnderfundedWithAdl` runs. ADL is unconfigured in production (`futures-jobs.ts`: "ADL omitted: owner policy unset"), so in practice the rung stays live and an alert fires.
- **Partial rung.** The trader is charged only what the pot holds. The gap goes into `plan.lossShort` and the alert `trade.liquidation_loss_short`. **No ledger entry records it.** `houseFees('trade')` is the PnL clearing pot, and it simply receives less than the mark said it should, with no ceiling.
- **A partial shortfall means the position is bankrupt.** A partial rung is only planned while equity > 0. If the pot later holds less than the tranche's loss, pot plus unrealised PnL is below zero, so the whole position has negative equity and the remainder is a bankrupt full close that draws on insurance on the next tick. One bankruptcy is therefore booked two inconsistent ways: the first slice off-ledger, the rest insured and bounded.
- **The withdrawal race.** `reduceIsolatedMargin`, `setLeverage`, `addIsolatedMargin` and `close` lock the position row `FOR UPDATE` but never looked at `trade.liquidation_rungs`. A withdrawal landing between `begin` and the loss post shrinks the pot, and the closing-rung amendment then makes **the insurance fund pay for money the trader just withdrew**. The Opus review on PR #4668 listed this and the house-absorbed `lossShort` as follow-ups.
- **Margin mode.** Isolated only (`CHECK (margin_mode = 'isolated')`, risk ADR rule 8: "no cross-margin path exists, even disabled").

## Decision drivers

- **Money truth.** Every unit of bad debt is a ledger fact under a named account, not a gap between a log line and a pot.
- **Existing law.** The insurance ADR ([`2026-08-13-insurance-fund-funding-policy.md`](2026-08-13-insurance-fund-funding-policy.md)) and the risk ADR ([`2026-08-05-futures-risk-and-mark-law.md`](2026-08-05-futures-risk-and-mark-law.md)) both say a house account is not an insurance fund.
- **The isolated-margin promise.** The trader never loses more than the position's margin.
- **Reduce risk first.** Never leave leveraged exposure open to save a bookkeeping entry.
- **Fraud.** A trader must not be able to withdraw collateral into a liquidation and have insurance refill it.
- **Effort and reversibility.** No new recipe and no migration (`plan` is jsonb).

## Considered options

- **(a) Insurance leg with a bound check for partial rungs too**, exactly like the closing rung. One rule for all bankruptcy losses and an audit entry per draw. Cost: it draws on a small fund, and if the fund is short something still has to give.
- **(b) Keep house-absorbed plus an alert (today).** No work and the tranche always completes. Unbounded, off the ledger, against both ADRs, and inconsistent with how the next tick books the same bankruptcy.
- **(c) Charge the trader's other balances.** Rejected: it breaks isolated margin, which is our only mode and is ADR-sealed, and it turns a liquidation into a collections problem. We did not rely on any regulatory source for this; it is a product-promise decision.
- **(d) Serialise: refuse margin outflows and closes while a rung is live.** Removes the withdrawal, leverage and close races at the source. Funding cannot be refused (the payee is owed), so (d) alone does not close the funding race. Cost: a short 409 window for the trader.

## Evidence

Limited to claims a fresh refuter checked. Retrieved 2026-10-14.

| Venue          | What they do with loss beyond margin                                                                                                                                                                            | Source                                                                                             | Confidence                                                   |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| dYdX v4        | The insurance fund "covers insufficient collateral by adjusting liquidation order prices". Once equity is negative, deleveraging occurs without using the fund.                                                 | https://docs.dydx.xyz/concepts/trading/contract-loss-mechanism                                     | high (fetched)                                               |
| Hyperliquid    | ADL when account value or an isolated position's value becomes negative; in isolated mode only that position's margin is at stake. **No insurance fund is mentioned on the liquidation and ADL pages checked.** | https://hyperliquid.gitbook.io/hyperliquid-docs/trading/auto-deleveraging ; …/trading/liquidations | high (fetched)                                               |
| BitMEX         | Insurance fund pays to close beyond the bankruptcy price; ADL if the fund cannot. "You cannot lose more than you deposit."                                                                                      | https://www.services.bitmex.com/app/liquidation                                                    | medium (search index of primary pages; direct fetch blocked) |
| Bybit          | Tiered partial close; failing that the engine takes the position over at the bankruptcy price; insurance fund, then ADL.                                                                                        | https://www.bybit.com/en/contract-rules                                                            | medium (search only)                                         |
| Binance USDⓈ-M | Partial reduction first; an unfilled bankrupt remainder is taken over by the insurance fund "to the extent possible"; ADL last.                                                                                 | https://www.binance.com/en/support/faq/binance-futures-liquidation-protocols-360033525271          | medium (search only)                                         |

What this supports, and what it does not. Among the venues checked, four name a payer for a bankruptcy gap (insurance first, then ADL or socialised loss); Hyperliquid names none on the pages read. **Nothing here says whether a trader can still act on a position once the engine has taken it over.** That is not stated for standard Binance or Bybit futures, so rule 4 below is our own design, not an industry fact.

## Decision outcome

Chosen: **(d) first, then (a)**, with one rule per rung type and no new recipe. (d) is a precondition of (a), not an alternative: booking a shortfall to insurance while a trader can still withdraw into the same rung would make the fund pay for the withdrawal.

### Phase 1 (this PR)

1. **Serialisation under the existing row lock.** `reduceIsolatedMargin`, `setLeverage`, `close` and `addIsolatedMargin` read `trade.liquidation_rungs` after `FOR UPDATE OF p`. The tick's `begin` and `apply` take the same lock first, so for one position exactly one of "the trader's change" and "a rung going live" wins; every writer takes the position row first and only reads the rung table, so there is no lock-order cycle.
   - **A live rung** (`planned` or `posted`): `close`, `reduceIsolatedMargin` and `setLeverage` are refused with **409 `trade.liquidation_in_progress`**. `addIsolatedMargin` is refused **only while the live rung is a closing rung**: a partial rung applies a delta to the row, so margin added meanwhile survives it; a closing rung would strand it in the pot.
   - **A parked position** (latest rung `abandoned`, or an old-style `liquidation_attempts` claim on a still-open position): `close`, `reduceIsolatedMargin` and `setLeverage` are refused with **409 `trade.position_under_review`**. Only adding margin is allowed. An earlier draft allowed `close` on a parked position; that leaks money, because the row is not reconciled with a loss already booked. The operator resolves the park per runbook section 2.
   - **Dated futures run through rungs too** (`sqlLiquidationPositionLoader` lists every open position). Settlement has already posted its money by the time the row is closed, so the gate is in `sqlDatedSettlementPositionLoader`: a position with a live rung, or a parked one, is not handed to settlement. A narrow window remains between that read and settlement's posts; it ends in an abandoned rung and a loud alert, as before.
   - **The withdrawal gate follows the ladder.** When a ladder policy is published, `reduceIsolatedMargin` and `setLeverage` rate what would be left with the ladder's depth-tiered maintenance (`PositionService` takes the same `depth` and `policy` as the tick, via `startFuturesJobs().ladderGate`). Without a policy the old equity-only gate applies. An unreadable book refuses (503 `trade.depth_unknown`) rather than releasing margin blind.
   - **Funding is not blocked.** A payee is owed; the rung's amendment path absorbs that race.
2. **Divergence guard.** `runLadderRung` reads the position's collateral pot from the ledger and plans with `min(row margin, pot)`. Any difference is raised as an error-level log `trade.liquidation_margin_divergence` (row, pot, position id). A row above the pot gives phantom-margin partials; a crash between a ledger release and the row update leaves the pot below the row. The rung's compare-and-set still uses the row snapshot, so a divergent position cannot produce a rung that errors every tick. The read happens after the no-policy and no-depth skips, so a deployment with no ladder makes no extra ledger call.
3. **Replay hygiene.** The refused-insurance-leg branch of `driveRung` reads `current.fromInsurance` (the amended plan), not `plan.fromInsurance`. A **partial** rung whose insurance leg is refused re-amends to pot-only plus `lossShort` instead of going to `underfundedItem` and ADL; a **closing** rung is unchanged. Today a partial rung never carries an insurance leg (it is planned only while equity > 0), so the new branch is unreachable in production and is covered by a replay test that stores such a rung by hand.
4. **Reconciliation to the ledger, not to plan fields.** `liquidation-reconcile.ts` is a pure function. For each applied rung it compares the ledger transaction `futures.loss:<liqId>:rung:<rungId>:loss` (`meta.fromMargin`, `meta.fromInsurance`) with the rung's `marginTaken` and `fromInsurance`, and compares the sum of insurance-fund credits with reason `futures.loss.realized` under rung keys with the sum of `plan.fromInsurance`. svc-trade has no ledger query surface and none is added: the runbook carries the SQL for both sides.

### Phase 2 (accepted, not built)

1. **Partial rung, pot short:** amend the unbooked loss to `fromMargin = pot`, `fromInsurance = gap`, bounded by the live fund balance.
2. **The bound is `g + c_est`, not `g`**, where `g` is the partial gap and `c_est = plannedLoss × (fromSize − sizeClosed) / sizeClosed` is the remainder's deficit at the plan mark. A fund that covers `g` but not the bankrupt remainder that follows would be drained for the first slice and leave the closing rung unable to close. If the fund cannot cover `g + c_est`, book the pot-only fallback with `lossShort` (paged) and do not park: parking a solvent-looking partial leaves leveraged size open over a small amount. All or nothing: the fund is never part-drawn for a partial rung.
3. **Same-tick takeover.** After any short partial, re-evaluate that position in the same tick and take over the bankrupt remainder, instead of waiting 15 seconds.
4. **Reconciliation identity** `marginTaken + fromInsurance + lossShort = plannedLoss`, with `plannedLoss` stored in `RungPlan` (defaulting on decode for old rows), kept as a secondary check.

### Honesty about what this does and does not do

- **Booking to insurance moves money between two house accounts.** The fund is topped up from `houseFees('trade')` and draws flow back into it. The gain is a balance ceiling and an audit entry per draw, not a different payer. Phase 1 changes no payer at all; it removes a trader-fraud path and makes the books checkable.
- **There is no live exposure today.** Production never supplies `ladderPolicy`, so every position is `skipped_d3_unset`, and opens are refused while `profitSource` is unset. This lands ahead of launch; it is not an incident fix.
- **The alerts are error-level logs.** No paging route exists. `trade.liquidation_margin_divergence`, `trade.liquidation_loss_short`, `trade.liquidation_margin_drift` and the rest are lines a person has to be watching for until a route exists. Nothing in this ADR creates one.

## What the refutation changed

A fresh Opus refuter returned "holds with changes". The accepted changes: serialisation comes first and in the same line of work as the insurance booking; a parked position refuses `close` as well as outflows; add-margin is refused only while a closing rung is live; dated settlement and every other row writer are checked; the withdrawal gate follows the ladder; the draw bound is `g + c_est`; the divergence guard is added; the `:983` "bug" is not a live bug (replay uses the stored amended plan) and becomes hygiene plus the partial-rung branch; reconciliation is to the ledger; and the honesty section above.

## Follow-up decisions (owner carve-outs, DIRECTION §3, not taken here)

- **A liquidation clearance fee paid into the insurance fund.** Every venue checked funds its backstop from liquidations; ours returns the residual margin and has no inflow except manual top-ups. A fee changes what a trader pays, so it is Nitro's decision.
- **ADL or socialised loss.** Blocked: the D5 numbers are owner-unset. Until they exist the "fund short" fallback in phase 2 is house absorption with a page-worthy alert.

## Consequences

- Good: the withdrawal and close races are closed at the source; a trader cannot withdraw into a liquidation and have insurance refill it; a divergent row can no longer make a phantom-margin partial; applied rungs can be checked against the ledger.
- Bad: a trader sees a 409 for one tick at most, longer while a rung is stuck. A parked position cannot be closed or reduced until an operator acts, so the park queue becomes a trader-facing service level.
- Risk: a stuck live rung blocks adding margin to a position being closed. Acceptable: the rung is already committed and adding margin would only strand it.
- Monitor: the rate of 409 `trade.liquidation_in_progress` and `trade.position_under_review`; every `trade.liquidation_margin_divergence` line; the reconciliation output being `clean`; and, after phase 2, count and amount of `loss_insured` and `loss_short` per asset per day.

## Reversibility

Two-way. Phase 1 is code only: reverting the PR removes the 409s, the guard and the helper and leaves nothing to unwind in data. A trader who was refused simply retries. Phase 2 books real insurance draws; reverting its code stops new draws, and draws already booked are correct ledger facts and are not reversed. Cost of undoing either: one PR.

## Revisit when

- Any `trade.liquidation_margin_divergence` or (after phase 2) `trade.liquidation_loss_insured` event in production: investigate the divergence, do not tune a threshold.
- An owner ADL policy (D5) ships: the phase 2 "fund short" fallback should go to ADL instead of house absorption.
- An owner insurance target size (D4) exists: add a low-water alert on the fund.
- The owner publishes the ladder table (production stops being `skipped_d3_unset`): live exposure begins, and the monitors above become real.
- A paging route exists: move the alerts onto it.
- `trade.position_under_review` 409s become routine: the operator queue is now trader-facing.
- A cross-margin mode is ever proposed: option (c) and negative-balance protection need redoing.
- The clearance-fee decision is taken.

## Files (phase 1)

`position-service.ts` (hold check, ladder gate), `liquidation-tick.ts` (divergence guard, replay hygiene), `liquidation-reconcile.ts` (pure reconciliation), `position-loaders.ts` (dated settlement gate), `futures-jobs.ts` and `index.ts` (ladder gate wiring, divergence log), `docs/runbooks/liquidation-rung-ops.md` (alerts, 409s, reconciliation SQL).

## Open questions for Nitro

None. The fund target size and ADL numbers stay owner-open under the existing ADRs; this decision does not need them.
