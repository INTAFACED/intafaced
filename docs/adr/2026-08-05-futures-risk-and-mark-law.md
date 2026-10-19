# ADR: futures risk and mark law — the engine must not be told what a position is worth

**Status:** **Accepted — 2026-08-05.** Owner decision, stated and confirmed.
**Decision owner:** repo owner. **Written by:** Denon.
**Spec ids:** **D-S-01** (futures risk product law) and the futures half of **D-S-07** (oracle / mark policy). The lending half of D-S-07 is already law in `SPEC-LENDING-2026-08-02.md` (removed) §1 and is unchanged.
**Builds on:** `DIRECTION-2026-07-31.md` (removed) §1 — isolated margin only, partial-liquidation posture, MVP done bar. All of that stands.
**Binds:** [`adr/2026-08-04-bank-vertical-law.md`](2026-08-04-bank-vertical-law.md), which already binds futures to `prices.ts`'s refusal vocabulary. This is the other half of that sentence.

---

## The decision

> **A price that moves money is never supplied by the party it pays.**
>
> Entry price, exit price and mark price are read from a source the caller cannot choose or influence. They are never accepted from a request body, never defaulted, and never inferred from the order that is being settled.

This is settled. Agents and engineers implement it; they do not re-litigate it.

---

## Why this is the whole ADR

Verified on `main`, 2026-08-05:

```
services/svc-trade/src/private-rest.ts:641
  const entryPrice = typeof body.entryPrice === 'string' ? body.entryPrice : '';
services/svc-trade/src/private-rest.ts:102
  closePosition(principal, positionId, exitPrice: string): Promise<Position>
```

**Both prices come from the request.** They flow to `close-planner.ts` `unrealizedPnl(...)` and on to `futuresRealizeProfit`, which pays from `houseFees` — so a caller who names their own exit price names their own profit, and the platform funds it.

The service is otherwise careful about exactly this. `futures/funding-tick.ts:26-33` states the correct rule for its own port:

> "Return the rate for this market/period window, or null if no rate is available (oracle down, market not funding-enabled, period already unknown). **Implementations MUST NOT invent a placeholder rate.**"

That is right, and it is the pattern. **The gap is not that nobody thought about it — it is that the guard was put on the source and not on the caller.** A rule that forbids the engine from inventing a price, while the API accepts one from whoever is being paid, protects nothing.

---

## The mark vocabulary is already written. Do not respell it.

`services/svc-bank/src/loans/prices.ts` decided when a price may move someone's money, and the bank-vertical ADR binds futures to it. Restating, because this is where it gets applied:

- **`MarkQuality`** — `'mid' | 'last' | 'index'`. Not a new enum.
- **`MarkPolicy`** — `maxAgeSeconds`, `liquidationMaxAgeSeconds`, `maxDeviationBps`, `liquidationQualities`.
- **The split gates** — `acceptableForMarking` and `acceptableForLiquidation`, and the error codes `bank.mark_unusable` / `bank.mark_invalid`. Futures gets its own codes in its own namespace, with the same shape and the same meanings.

Three properties carry across unchanged, each already argued once:

**The asymmetry.** Warnings tolerate a stale mark; seizures do not. _"Refusing to warn a borrower because the feed is 40 seconds old leaves them uninformed; refusing to SELL on the same mark leaves them with their collateral."_ On a perp the equivalent is: a margin-call notice may use a slightly stale mark, a liquidation may not.

**`last` is not a liquidation basis.** `liquidationQualities: ['index', 'mid']`. A market with no two-sided quote cannot be liquidated at all — the position sits and an operator looks at it. _"An illiquid book is exactly where a forced sale does most damage."_

**A missing mark is not a zero mark.** Omitted from the map, so the caller refuses to value the position rather than valuing it at nothing. On a perp, valuing a missing mark at zero liquidates everyone.

The deviation breaker stays integer-only and rounds up, so a move exactly on the breaker trips it. No floats in this path, ever.

---

## Funding

**The port is correct and stays.** `FundingRateSource.quote()` returns a rate or `null`, and implementations may not invent. Add to it:

- **A missing rate is a skipped period, recorded as skipped** — never a zero-rate period. Zero is a real rate and means something different from "we could not get one".
- **Funding is settled per period with a business idempotency key** derived from market and period, never from a clock reading. Re-driving settles once. The convention is `bank.ts:46-50`.
- **A period that cannot be settled blocks the next one** rather than being silently skipped, because compounding a gap changes what every subsequent position paid.

---

## Liquidation

`DIRECTION` §1 fixed the posture and it stands: **isolated margin only**, partial liquidation.

The ladder is already built and argued in `services/svc-bank/src/loans/risk.ts` — `assertPolicyCoherent`, the closed-form tranche sizing, `maxTrancheBps`, and the ordering guarantee that a margin call must exist and its grace expire before a liquidation may fire. **Futures adopts that shape.** Specifically:

- Sell only enough to restore target, never the whole position by default.
- A margin call must precede a liquidation, with grace, or _"the borrower's first notice of the loan would be its liquidation receipt"_ — and on a perp, the trader's first notice is the same.
- **A margin call that cannot be delivered is not a margin call.** `bankMarginCalled` was published into a void for weeks while `svc-notify`'s consumer sat complete and parked. Futures must not repeat it: if the notice has no transport, the grace clock does not start.

---

## Refuse cases

| Situation                                    | Correct answer                                                                    |
| -------------------------------------------- | --------------------------------------------------------------------------------- |
| Price supplied in a request body             | **Refuse the request.** Not ignore-and-substitute — refuse, so the caller learns. |
| No mark available                            | **Refuse to value.** Never zero, never last-known-forever.                        |
| Mark stale past the liquidation limit        | **Do not liquidate.** Margin call may still stand.                                |
| Mark quality is `last`                       | **Not a liquidation basis.** Position sits; operator looks.                       |
| Mark moved past the deviation breaker        | **Do not liquidate through it.**                                                  |
| Funding rate unavailable                     | **Skip and record the skip.** Never a zero-rate period.                           |
| Funding period unsettleable                  | **Block the next period.** Do not compound a gap.                                 |
| Margin call cannot be delivered              | **Grace does not start.**                                                         |
| Realised PnL would exceed the funding source | **Refuse.** See below.                                                            |

---

## The payout bound

`futuresRealizeProfit` pays from `houseFees` with no ceiling. A house account is not an insurance fund and a fee balance is not a risk budget.

**Profit is paid from a named account whose balance is the bound, and a payout that would exceed it refuses rather than overdrawing.** `bank.pool_underfunded` is the model — _"a pool that cannot pay its advertised rate is an operator problem today, not a shortfall discovered at maturity."_ The equivalent here is that an under-funded profit source is an operator problem at the moment of the trade, not an accounting surprise later.

Which account, and how it is funded, is an owner decision — it is a fee and revenue recipe, `DIRECTION` §8 item 6.

### PKT-B5 seal — 2026-08-15

**`TRADE_FUTURES_PROFIT_SOURCE` has no default.** This ADR does not name an account.

`futuresRealizeProfit` stays refuse-closed until the owner names the account that funds realised futures profit. Agents must not invent an account id and must not silently fall back to `houseFees`. A fee balance is not a named source.

Until that name exists, realised profit is not paid. The payout-bound mechanism (refuse rather than overdraw) remains implementable; the account choice does not.

---

## Done bar

1. No price that moves money is accepted from a caller. Proven by a test that supplies one and asserts a refusal.
2. Marks flow through the `prices.ts` gates, with futures-namespaced error codes of the same shape.
3. `last` cannot liquidate. Tested.
4. A missing mark refuses to value. Tested — and the test asserts no liquidation follows.
5. Funding skips are recorded as skips and are distinguishable from zero-rate periods.
6. A margin call with no transport does not start a grace clock.
7. Realised profit is bounded by a named source and refuses rather than overdrawing.
8. Isolated margin only; no cross-margin path exists, even disabled.

---

## What agents may implement without asking again

- Removing caller-supplied prices and reading from a source, with the refusals above.
- Applying the `prices.ts` gates to the futures mark path.
- Funding skip-recording and period-blocking.
- The payout bound and its refusal — **the mechanism, not the account choice**.

## What still needs the owner

- **Which account funds realised profit, and how it is capitalised.** PKT-B5 (2026-08-15): the variable stays unset; `futuresRealizeProfit` stays refuse-closed until the owner names it. No silent `houseFees` fallback. A fee and revenue recipe, and a `DIRECTION` §3 carve-out twice over.
- Any leverage or margin parameter beyond §1's stated defaults — `DIRECTION` §8 item 8.
- Cross-margin, which is a different product and needs its own spec.
- Turning funding on for a market at all.
