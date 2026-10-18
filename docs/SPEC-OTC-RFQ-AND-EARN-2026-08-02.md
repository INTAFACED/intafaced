# Spec — OTC / RFQ (M4) and Earn (M6)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

Completes the product law for the mountains. Both are products where the dangerous thing is not the mechanism but **what the user is told is happening**.

---

# Part A · OTC and RFQ (M4)

## A0 · The two products, and they are different

**OTC (P2P)** — two users trade directly, we hold escrow. The vendored exchange already has this shape (advert, order, appeal), and it is what `pay.p2p` addresses.

**RFQ** — a user requests a quote for size, one or more makers respond, the user accepts one. There is no book; the price is quoted, not discovered.

They share escrow and dispute machinery. They differ in **who sets the price and who bears execution risk**, so the honesty requirements differ.

## A1 · RFQ — the rules

**We quote or we route. We do not pretend to do one while doing the other.**

- **If we are the counterparty**, say so on the quote. A user accepting a quote from "the platform" is trading against us, and that is a conflict of interest they are entitled to know about. It is legitimate; concealing it is not.
- **If we are routing to makers**, the user must be able to see that the price came from a maker, and **the spread we add must be disclosed** — not embedded silently in a worse price. An undisclosed markup presented as "the price" is a lie about the market.
- **A quote has an explicit expiry and is honoured until it expires.** Requoting on acceptance — "last look" — is the standard abuse in this product, and it systematically transfers value from the taker to the maker precisely when the market has moved in the taker's favour. **Not permitted.** If the maker cannot honour a quote, the quote should not have been given.
- **Refuse rather than skew.** No maker, stale price, or size beyond what can be honestly filled → **refuse with a reason.** Never widen the spread silently to make an unfillable request fillable.
- **Size is quoted or it is not a quote.** A price without the size it is good for is marketing.

## A2 · OTC escrow — the rules

**Escrow is custody.** Fiat Plane, no argument — see the pay verticals spec §0.

- **Funds are held by us the moment escrow opens**, and the ledger must say so. A held balance is not the seller's spendable balance and must not be presented as one.
- **Release is on evidence, not on elapsed time.** A timer that auto-releases to the buyer is a robbery mechanism for a patient attacker; a timer that auto-releases to the seller strands buyers who paid.
- **Dispute is a first-class state with a human in it.** Both sides see the same evidence set. **No automated resolution of a disputed release** — this is the one place in the platform where a human decision is the correct design, not a fallback.
- **Appeal outcomes are recorded and reviewable.** An escrow desk whose decisions cannot be audited is a desk nobody should use.
- **Cancellation before funding is free; after funding it is a dispute.** There is no third path.

## A3 · Algo — restating the boundary

Per `DIRECTION-2026-07-31.md` §1, revised: **TWAP, VWAP and POV are in. Icebergs remain out.**

- An algo is **execution scheduling, not discretion**. It slices an order the user already decided to place. It never decides _whether_ to trade.
- **Slippage limits are the user's**, and a slice that would breach them is skipped and reported — never executed "close enough".
- **A cancelled algo cancels its unplaced remainder immediately**, and reports exactly what filled.
- Icebergs stay out because a hidden order that leaks through matching-engine timing is worse than no hidden order, and proving it does not leak is its own project.

## A4 · `done` for M4

1. An RFQ quote states counterparty, size, expiry and any spread we add.
2. **Last look is impossible** — an accepted unexpired quote fills at the quoted price, asserted.
3. Unfillable requests **refuse with a reason**; no silent skew.
4. Escrow balances show as held, not spendable, everywhere they appear.
5. A disputed release **cannot be resolved without a human decision**, asserted.
6. Algo slices respect user slippage limits and report skips.
7. Copy trading follows [`SPEC-SOVEREIGN-ROUTING-AND-COPY-2026-08-01.md`](SPEC-SOVEREIGN-ROUTING-AND-COPY-2026-08-01.md) — nothing else.

---

# Part B · Earn (M6)

## B0 · The one rule

**Yield must have a named source, and the user must be able to see it.**

`DIRECTION-2026-07-31.md` §7 states it; this makes it operational. Every earn product answers, in-product and not only in terms:

> **Who is paying this yield, and why are they paying it?**

If the answer is "the treasury", it is **not yield — it is marketing spend**, and it must never be described as yield, APY, or interest anywhere a user can see. Calling a promotional payment "APY" trains users to expect it to continue, and stopping it then reads as a rate cut on something that was never a rate.

## B1 · What is buildable, in order

**1 · Lending yield** — the supply side of M2. Source: borrowers paying interest. **Honest, self-funding, and the only one that needs no external counterparty.** This is the earn product to build first, and it should probably be the only one for a long time.

**2 · Staking pass-through** — source: the underlying protocol. We custody and pass through, minus a disclosed fee. Requires the chain, validator or provider relationship to be real, and the **slashing risk disclosed** — a user who can lose principal to a slashing event must be told before depositing, not after.

**3 · Promotional boost** — source: us. Buildable and legitimate, but it is **labelled a reward or bonus, never yield**, and it has a stated end date.

**Not buildable without a licence conversation:** anything where user deposits fund an undisclosed strategy, anything with a fixed guaranteed return, and anything where the yield source is another user's deposit. **That last one is the shape of a Ponzi**, whatever it is called internally, and it must be structurally impossible rather than merely against policy.

## B2 · Hard requirements

- **Principal risk stated before deposit**, in the deposit flow. "Capital at risk" where it applies, plainly.
- **Advertised rate is variable and shown as such** unless it is genuinely fixed and funded. A headline APY that quietly depends on utilisation must show that it does.
- **Withdrawal terms are stated up front** — lock-ups, unbonding periods, notice. **A user who cannot withdraw must have been told exactly when they can**, before they deposited.
- **No rehypothecation** of earn deposits beyond the disclosed strategy. Same rule as lending.
- **Every accrual is a §0.6 ledger recipe.** No module accrues yield into its own balance.
- **Yield accrues on an index**, not a per-user loop — same reasoning as lending interest.
- **Killable per product**, from the kill-switch board.

## B3 · The failure to design against

**A user cannot distinguish "earn" from "deposit" unless we make the difference obvious.** The word sits next to their balance and looks like a savings account. It is not one: there is no deposit insurance, and in most of these products principal is genuinely at risk.

So the disclosure is **at the point of deposit, in the flow, in plain words** — not in a linked document. This is not legal cover. It is the difference between a product and a trap.

## B4 · `done` for M6

1. Every earn product **names its yield source in-product**.
2. A treasury-funded promotion is **labelled a reward, never yield**, with an end date.
3. Principal risk and withdrawal terms are shown **in the deposit flow**.
4. Accrual is index-based and posts via `ledger-client`.
5. **No product exists whose yield source is another user's deposit** — structurally, not by policy.
6. Slashing or strategy risk is disclosed **before** deposit where it applies.

---

## Owner-gated (both parts)

Per `DIRECTION-2026-07-31.md` §8: RFQ spreads and whether we act as principal, escrow dispute policy and who adjudicates, every earn rate and promotion budget, which staking providers, and any claim of guaranteed or insured return.
