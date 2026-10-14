# ADR: Connect, Execution, Quant and Predict — the invent ban, made specific

**Status:** accepted  
**Status note:** **Accepted — 2026-08-04.** Owner decision, stated and confirmed.
**Decision owner:** repo owner. **Written by:** Denon.
**Spec id:** D-S-18. The board qualifies this one _"(if in scope)"_ — so the first thing it decides is what is in scope.
**Ground truth:** `svc-connect`, `svc-execution`, `svc-quant` and `svc-predict` **do not exist.** None of the four appears under `services/`. §27–§32 are doctrine describing rooms nobody has entered.

---

## The decision

> **Three of the four are unbuildable today for a reason that is not effort, and saying which is which is the whole point of this ADR.**
>
> **§27 Connect is in scope and buildable now.** Everything else waits on it or on a chain that does not exist.

| Room              | Status                                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------- |
| **§27 Connect**   | **In scope.** `packages/venue-contracts` already exists as its seed. Buildable, incrementally, starting today.   |
| **§28 Execution** | **Blocked on §27.** A cross-venue router with one venue is a router with nothing to route between.               |
| **§29 Quant**     | **Blocked on §27's data lake**, which is blocked on §27's adapters. Also carries the hardest honesty rule below. |
| **§32 Predict**   | **Phase 5P. Not agent work, and not mine.** It is an INTACORE market type, and INTACORE does not exist.          |

This is settled. Agents and engineers implement it; they do not re-litigate it.

---

## §27 Connect — in scope, and already constrained

Doctrine §27 states its own hardest rule, and it is the same sentence that decided the Hyperswitch question in [`2026-08-04-pay-rails-and-psp-socket.md`](2026-08-04-pay-rails-and-psp-socket.md):

> "**No third-party connectivity library in the money path** — Doctrine 5 applies (own tech, narrow interfaces, Rust-portable hot paths)."

So CCXT and its class are excluded from the money path by doctrine, not by preference. `packages/venue-contracts` is the seed that already exists — including an errors module whose header states the principle this room lives or dies by:

> "an execution port that answers plausibly while doing nothing reports fills that never happened… A missing key is not a market condition. It is a deployment that is not finished, and it must read like one."

**The three adapter classes are built one venue at a time, and a venue that is not connected is absent, never empty.** One real venue honestly connected is worth more than five that answer plausibly.

**Latency grading is a measurement, never an estimate.** §27 wants every adapter continuously scored on round-trip, book staleness and reject rates, feeding routing weights live. A score for an adapter that has not run is not a low score — **it is no score**, and an unscored adapter must not receive routing weight. This is the same defect class as a scan that walks zero files and prints clean.

---

## §29 Quant — the honesty rule that must exist before the first line of code

Doctrine already states it:

> "honesty enforced — results display with overfitting warnings and out-of-sample verdicts, **no curve-fit marketing allowed on-platform**"

That is right, and it is not strong enough to be implemented from. The operative rule:

> **A backtest is a claim about the past. Every surface that displays one must make it impossible to read as a claim about the future.**

Because this is the room where our honesty doctrine is under the most pressure. Everywhere else, a fabricated number is a bug. Here, a _truthful_ number — a real return computed over real historical data — can still be the most misleading thing on the screen, and no `fabricated-money-scan` will ever catch it. **The dishonesty is in the framing, not the arithmetic.**

So, binding from line one:

- **Out-of-sample is not optional and not a toggle.** A result with no out-of-sample verdict does not render.
- **Fees, slippage and latency are modelled or the run is refused.** §27 supplies them per venue; a backtest that assumes zero cost is fiction with a chart.
- **The strategy count is displayed.** A user who tested four hundred variants and shows the best one has found noise, and the surface must say how many were tried.
- **No leaderboard ranked by historical return.** That is the mechanism by which a backtesting product becomes a marketing product, and §8's existing ban on returns-ranked leaderboards for copy trading applies here for the identical reason.
- **A live strategy's real P&L is never shown next to its backtest without both being labelled**, in the same visual weight.

`packages/exchange-contract`'s existing discipline applies too: **contract-only capabilities may not be specced against.** Building a Quant feed on a channel nothing publishes repeats a mistake we already made once.

---

## §32 Predict — not in scope, and the reason is structural

Prediction markets are an **INTACORE market type**. INTACORE does not exist — `git grep -il intacore` across `services/` and `packages/` returns nothing. §32 is Phase 5P, sovereign, zero-KYC by architecture, and it depends on a chain, smart accounts and a CLOB that are all Shehzad's board.

**It is out of my lane and out of the agent lane.** But two of its properties should be written down now, because they will otherwise be decided by whoever writes the first line of code:

- **Resolution is the product.** Not the order book — the engine already exists in spec form via [D-S-06](2026-08-04-matching-dual-target.md). A prediction market that cannot resolve honestly is a casino with extra steps, and the resolution stack (oracle adapters, designated reporter, staked dispute escalation with bond slashing) is where every real prediction platform has failed. **It is specced before the market type is built, not after.**
- **Bond and slashing numbers are owner-only**, by the same rule as every other economic number in [D-S-14](2026-08-04-token-economics-outcomes.md). "IFC-staked dispute escalation" names a mechanism and no magnitude.

---

## What this ADR is really for

The board's column reads _"Greenfield rooms — invent ban until you write law."_ The law is short:

> **In a room with no code, an agent may build the contract and the refusal. It may not build the claim.**

Concretely: adapters, typed schemas, error taxonomies, refusal paths and tests are all fair game and always have been. **What is banned is any surface that asserts a result** — a latency score, a backtest return, a routing decision, a resolution — before the thing that would make it true exists.

Every one of these four rooms is a machine for producing confident numbers. That is what makes them valuable, and it is exactly why they get the strictest reading of the honesty doctrine, not the loosest.

---

## Refuse cases

| Situation                                                        | Correct answer                                              |
| ---------------------------------------------------------------- | ----------------------------------------------------------- |
| Venue not connected                                              | **Absent, and named.** Never an empty book.                 |
| Adapter with no measurements                                     | **No score, and no routing weight.** Never a default score. |
| Backtest with no out-of-sample verdict                           | **Does not render.**                                        |
| Backtest with unmodelled fees or slippage                        | **Refuse the run.** Do not run it and caveat it.            |
| Strategy shown without its variant count                         | **Refuse.** The count is part of the result.                |
| Prediction market with no resolution source                      | **Do not list it.** Resolution precedes listing, always.    |
| Any of these rooms asked for a number the platform cannot source | **Say so.** The invent ban is at its sharpest here.         |

---

## Done bar

1. `svc-connect` ships one real venue end to end before a second is started.
2. No adapter receives routing weight without measurements.
3. No backtest surface exists before the out-of-sample and cost rules are enforced in code.
4. No returns-ranked leaderboard, in any room.
5. §32 stays unstarted until INTACORE exists. Resolution stack **spec**: [`2026-09-18-predict-resolution-stack.md`](2026-09-18-predict-resolution-stack.md). Code still waits on INTACORE.
6. Every room's absent state is stated, never rendered as empty.

---

## What agents may implement without asking again

- `venue-contracts` schema work, and one `MarketDataAdapter` against one real venue.
- Error taxonomies and refusal paths in any of the four rooms.
- Latency measurement plumbing — measurement only, no scoring of unmeasured adapters.

## What still needs the owner

- Which venues we connect, and in what order. Commercial before technical.
- Whether Quant ships to users at all, given the framing risk above.
- Every §32 decision, which is Shehzad's board and a live chain away.
- Any bond, slashing, or fee magnitude — [D-S-14](2026-08-04-token-economics-outcomes.md) applies.
