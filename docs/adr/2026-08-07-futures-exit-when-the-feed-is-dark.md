# ADR: futures exit when the feed is dark — refusing to price is not refusing to release

**Status:** accepted  
**Status note:** **Accepted — 2026-08-07.** Amends [`2026-08-05-futures-risk-and-mark-law.md`](2026-08-05-futures-risk-and-mark-law.md) (D-S-01 / D-S-07 futures half). Everything in that ADR stands except the one row named below.
**Decision owner:** repo owner. **Written by:** Denon.
**Reason this exists:** the earlier ADR's refuse table has a hole I put there, and the code implements the hole faithfully.

---

## What I got wrong

The refuse table in the futures risk ADR says:

| Situation         | Correct answer                                             |
| ----------------- | ---------------------------------------------------------- |
| No mark available | **Refuse to value.** Never zero, never last-known-forever. |

That row is right, and I applied it to a case it does not cover.

I wrote it thinking about **liquidation and payout** — the platform reaching into a position. It is now also governing **voluntary exit** — the trader asking to stop being exposed. Those are not the same act and they do not deserve the same answer.

`services/svc-trade/src/futures/position-service.ts` `markFor()` throws `trade.mark_missing` **before** any profit/loss branch is reached. So when the feed goes dark:

- a profitable close is refused — correct, and the ADR argued it,
- a **losing** close is refused too — never argued by anyone,
- the collateral stays locked, and the position keeps riding whatever the market does next.

The file's own comment on `requirePayoutGrade` says:

> "A losing or flat close is deliberately NOT held to that bar … refusing it because the book is one-sided would trap them in a position they asked to leave, and this repo has already decided that a control which traps funds is not a safety control (`TRADE_SPOT_ENABLED`)."

**That comment is true about the bar it is attached to and false about the outcome.** `requirePayoutGrade` does exempt losing closes. `markFor` already threw two calls earlier, so the exemption never runs. This is the same shape as the deviation breaker being dead at every call site and the same shape as the `#883` refusal with one legal answer: a guard that is correct in isolation and unreachable in place. It is worth naming that this repo has now produced that defect three times in one subsystem.

---

## The decision

> **A trader may always stop being exposed. Refusing to price a position is not a reason to refuse to release it.**
>
> When no usable mark exists, a close request does not fail and does not settle. It **freezes the position**: exposure stops accruing, the position becomes ineligible for liquidation, and it settles at the first usable mark.

The distinction the earlier ADR missed, stated once so it is not missed again:

- **Valuing** a position is something the platform does _to_ a trader. With no mark, refuse — the ADR's row stands unamended for this.
- **Releasing** a position is something a trader asks for. With no mark, the platform may not price it, but it also may not use its own inability to price as a reason to keep the trader in the trade. **The platform's outage is not the trader's risk.**

`TRADE_SPOT_ENABLED` already decided the general form of this: a control that traps funds is not a safety control. This applies it to the one path where the trap was invisible because the comment said it had been handled.

---

## What freezing means, precisely

**A fourth position state.** `status` today is `'open' | 'closed' | 'liquidated'` — three values, no way to express "the trader asked to leave and we could not price it". That is why the code has only two options and picks the wrong one. Add **`closing`**, with these properties:

1. **Entered only by a trader's close request that found no usable mark.** Never entered by the platform, never by a tick, never by an operator convenience path.
2. **Terminal in the trader's favour on direction:** a `closing` position accrues no further funding and takes no further mark-driven loss. Whatever the market does while the feed is dark is not charged to someone who already asked to leave.
3. **Not liquidatable.** The liquidation tick skips `closing` rows outright. A position the trader tried to exit must not be seized because our feed came back at a bad moment.
4. **Settles at the first usable mark**, through the ordinary close path with the ordinary payout bound and the ordinary deviation breaker — including the breaker being armed against the last mark the position was accepted against, which is the point of arming it.
5. **Idempotent.** A trader who retries the close while dark gets the same `closing` position, not a second one and not an error.
6. **Visible.** The position reports as `closing` with the reason, not as `open`. Honesty doctrine: a position in limbo must not render as a normal open position, because the trader's next decision depends on knowing they are already out.

**A `closing` position that never settles is an operator problem, surfaced as one.** If a market's feed stays dark past a stated horizon, that is an alert, not a silently accumulating pile of frozen positions. `bank.pool_underfunded`'s framing again — an operator problem today, not a discovered shortfall later.

---

## What this does not change

- **Profit still cannot be paid on an unusable mark.** A `closing` position that turns out to be in profit settles when a payout-grade mark exists, not before. Freezing is not a payout channel.
- **Marks are still never accepted from the caller.** Freezing removes the _pressure_ to accept a caller-supplied price when the feed is down; it does not create an exception. If anything it removes the last plausible argument for one.
- **A missing mark is still not a zero mark**, everywhere else in the system.
- **Isolated margin only.** Unchanged.

---

## Done bar

1. A close with no usable mark returns a `closing` position, not a 503. Tested.
2. A **losing** close with no usable mark does not fail. Tested — this is the specific case that was broken and the test should say so.
3. The liquidation tick skips `closing` rows. Tested, by running a tick that would otherwise liquidate the row.
4. A `closing` position accrues no funding. Tested across a funding period.
5. Retrying a close while dark yields the same position. Tested.
6. Settlement at mark return goes through the normal bound and the armed breaker. Tested by asserting **balances**, not status codes.
7. A `closing` position renders as `closing` with its reason, never as `open`.
8. The stale comment on `requirePayoutGrade` is corrected or deleted. A comment that claims a property the code lacks is worse than no comment, and this one cost us the finding.

---

## What agents may implement without asking again

- The `closing` state, its migration, and all eight done-bar items.
- Skipping `closing` rows in the liquidation and funding ticks.
- The idempotent retry and the honest rendering.
- Correcting the false comment.

## What still needs the owner

- **The dark-feed horizon hours** — still **unset**. See the PKT-C7 addendum: unset means no auto-alert timing invent. Do not reuse `liquidationMaxAgeSeconds` (or any other existing clock) as that horizon.
- **Which account funds realised profit**, unchanged and still open from the parent ADR. Freezing does not resolve it; it defers the moment it is asked.
- Operator settlement of a `closing` position at an adjudicated price: **sealed in the PKT-C7 addendum** (human-only; price + author on the row). The 2026-08-07 “until decided, no” sentence is superseded for that question only.

---

## Addendum — PKT-C7 (2026-08-15): human-only frozen settlement; horizon hours unset

**Status:** **Accepted — 2026-08-15.** Seals packet PKT-C7. Does not rewrite the freeze / `closing` decision above. **Decision owner:** repo owner. **Written by:** Denon.
**Supersedes:** the PKT-C7 paragraph in [`2026-08-14-remaining-p0-money-law.md`](2026-08-14-remaining-p0-money-law.md) insofar as it reused `MarkPolicy.liquidationMaxAgeSeconds` as the dark-feed horizon or as a gate before operator adjudication. That reuse invented a duration the owner never named.

### The two rules (operator settlement)

A `closing` / frozen position **may** be settled by an operator at an adjudicated price if a feed never returns (`DIRECTION` §3 carve-out), and **only** under both of these:

1. **A human adjudicates. Never a job.** Ticks, schedulers, and workers must not settle frozen positions. Ordinary settlement at the first **usable feed mark** (parent ADR item 4) is unchanged; that is a mark return, not an adjudicated price.
2. **The adjudicated price and its author are recorded on the row.** Missing either field is a refuse. Price on the wire is a decimal string, never a `number`. A caller-supplied mark on the close request is still forbidden; this is operator-authored, not trader-authored.

### Horizon hours remain unset

**How many hours a market may sit dark before frozen positions become an auto-timed operator alert is unset.** Unset means **no auto-alert timing invent.** Agents must not pick an N-hour constant, a default, a silent timer, or an existing policy clock (`liquidationMaxAgeSeconds` included) as that horizon. Alert posture: **refuse** auto-alert scheduling until an owner names the hours. Frozen positions remaining after a dark feed stay an operator problem the parent ADR already named — they do not become a timed job because nobody wrote a number.

### What this still does not change

- The freeze decision, the `closing` state, and the eight parent done-bar items.
- Profit still cannot be paid on an unusable mark.
- No `svc-trade` craft in this seal. Implementation follows these rules; it does not invent the horizon.
