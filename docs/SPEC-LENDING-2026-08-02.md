# Spec — lending (M2)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Read §1 before designing anything.** Lending is the most-exploited product category in this industry, the exploits are well documented, and almost all of them reduce to the same root cause. A lending market that is elegant everywhere else and wrong in §1 loses every deposit in it.

This spec is deliberately conservative. Every constraint below has a named failure it exists to prevent.

---

## 0 · Scope — decided

**Over-collateralised only.** A borrower posts collateral worth more than they borrow, and if it falls too far it is liquidated.

**Under-collateralised and credit lending are OUT**, and not on a "later" list. They require underwriting, credit-risk capital and — in most jurisdictions — a lending licence. That is a different company, not a later sprint.

**No rehypothecation.** Deposited collateral is never lent out again, never used as protocol working capital, never posted anywhere else. If a user's collateral can be gone when they come to withdraw, we have built something we cannot honestly describe.

**Isolated risk by default.** A new or thin asset is listed in **isolated mode** — it can be borrowed against only within its own market, and bad debt there cannot reach the main pool. Cross-collateral is a promotion an asset earns, not a default it receives.

---

## 1 · The oracle — this is the whole security model

**Almost every lending exploit is an oracle exploit.** The attacker does not break the maths; they change the price the maths reads. Borrow against collateral you have made look expensive, or liquidate someone by making theirs look cheap. Everything else in this document is secondary.

### Hard rules

**1 · Never price collateral from our own AMM spot price. Not once, not for one asset.**
Our AMM pool is manipulable by anyone with capital for one transaction — that is what an AMM is. Reading a price from a pool that the borrower can move, inside the same transaction they borrow in, is the single most reliable way to lose a lending market. **This is the rule most likely to be broken by accident**, because our own pool is the most convenient price source in the building.

**2 · Multiple independent sources, with disagreement as a first-class state.**
At least two sources that do not share an upstream. If they disagree beyond a threshold, the market **pauses borrowing and liquidation for that asset** — it does not average them and continue. An averaged price across a live disagreement is a number nobody vouches for.

**3 · Time-weighted, not instantaneous.**
A TWAP over a window long enough that moving it costs more than the exploit yields. Short windows are cheap to manipulate; state the window and the cost to move it, per asset.

**4 · Staleness is a refusal, never a fallback.**
If the latest price is older than the asset's staleness bound, borrowing and new liquidations **refuse**. They do not fall back to the last known price. A stale price during a crash is precisely when it is most wrong and most consequential.

**5 · Deviation circuit breaker.**
A move beyond a per-asset threshold in one update pauses the market pending review. False positives cost us an hour; a false negative costs the pool.

### Done bar for the oracle

Not "it returns a price". **An adversarial test must attempt to move the price via our own AMM in the same transaction as a borrow, and fail** — with the failure asserted, not assumed.

---

## 2 · Risk parameters — per asset, never global

| parameter               | meaning                                | note                                                        |
| ----------------------- | -------------------------------------- | ----------------------------------------------------------- |
| max LTV                 | most you can borrow against it         | conservative; raise only on evidence                        |
| liquidation threshold   | where liquidation becomes possible     | **strictly above** max LTV — the gap is the borrower's room |
| liquidation bonus       | discount paid to the liquidator        | must exceed gas + slippage or nobody liquidates             |
| supply cap / borrow cap | maximum exposure                       | the blast radius of any single asset                        |
| reserve factor          | share of interest retained as backstop | §5                                                          |
| staleness bound         | how old a price may be                 | §1.4                                                        |

**The gap between max LTV and liquidation threshold is a product decision, not a constant.** Too tight and ordinary volatility liquidates healthy borrowers; too loose and positions go underwater before anyone can act.

**Caps are the single most effective control here.** An asset that cannot exceed a bounded exposure cannot cause unbounded loss, whatever else goes wrong with it. Set them low and raise deliberately.

All of these are **owner-gated** (`DIRECTION-2026-07-31.md` §8) — they are risk appetite expressed as numbers, and they are not agent-settable.

---

## 3 · Liquidation

- **Partial before full.** Liquidate the minimum that restores health, bounded by a close factor. Full liquidation is a failure mode, not a policy — same rule as futures.
- **Anyone may liquidate.** A permissioned liquidator set means positions go unliquidated exactly when our own infrastructure is struggling, which is the same moment the market is moving.
- **The bonus must actually clear costs**, or liquidation is theoretical. Model it against realistic gas and slippage, not ideal conditions.
- **Cascades are the systemic risk.** Liquidations sell collateral, which lowers the price, which triggers more liquidations. Mitigations: close factors, caps, isolated mode, and the deviation breaker in §1.5. **Test the cascade explicitly** — a liquidation engine that has only seen one position liquidate has not been tested.
- **Self-liquidation must be permitted.** A borrower repairing their own position is the cheapest possible outcome for everyone.

---

## 4 · Interest

- **Utilisation-curve model** with a kink: gentle below the target, steep above it. The steep zone is what makes lenders' withdrawals possible — it prices the last of the liquidity honestly.
- **Index-based accrual.** One global index per market updated on interaction; per-user balances derive from it. **Never loop over positions to accrue** — that is unbounded work that fails exactly when the market is busiest.
- **Accrue before every state-changing read.** A borrow, repay or liquidation against a stale index is arithmetically wrong in someone's favour.
- **Rates are a §0.6 recipe.** Interest paid to suppliers and interest taken as reserve both move value and both go through `ledger-client`.

---

## 5 · Bad debt — decide who eats it now

**A position can go underwater faster than it can be liquidated.** Not a hypothetical: a gap, a chain halt, or an illiquid market all produce it. Systems that fail to answer this in advance answer it during the incident, badly.

- **A reserve fund, accrued from the reserve factor, absorbs it first.** It must exist and be funded before the market opens — same rule as the futures insurance fund. **If it is empty, the market does not list.**
- **When the reserve is exhausted, socialisation is the fallback, and it must be disclosed in advance.** Suppliers of that asset take a proportional haircut. Nobody may discover this during the event.
- **Bad debt is recognised immediately, not hidden.** A market carrying unrecognised bad debt is reporting a supply balance that cannot be redeemed, which is a lie with a delay on it.
- **Isolated mode is what stops one asset's bad debt reaching everything else** — §0.

---

## 6 · Implementation constraints

- **Checks-effects-interactions everywhere, plus reentrancy guards.** Every classic drain in this category is a reentrancy on an external call.
- **No callback into an untrusted token during a state transition.** Fee-on-transfer and rebasing tokens break accounting silently; either handle them explicitly or refuse to list them.
- **Flash-loan awareness:** any position that can be opened and closed in one transaction must not be able to extract value. **Write the test that tries.**
- **Per-market pause and global pause**, reachable from the kill-switch board, failing closed.
- **§0.6** — value moves only through `ledger-client`. **No money in a `number`:** decimal strings on the wire, scaled bigint in memory, `numeric(38,18)` in Postgres, `uint256` on chain.
- **Rounding always favours the protocol**, never the user, and it must be _consistently_ so. Inconsistent rounding is drainable by repetition.

---

## 7 · What `done` means — hard list

Not "you can borrow and repay". All of these, or the tracker says `ready`:

1. A borrow against a **manipulated AMM price fails**, asserted adversarially (§1).
2. **Oracle disagreement pauses** the market; staleness **refuses**.
3. **Partial liquidation** restores health and the liquidator profits after realistic costs.
4. A **cascade** is simulated and bounded by close factor and caps.
5. Bad debt hits the **reserve**, and the reserve balance moves by exactly the shortfall.
6. Interest accrues correctly across **many positions with no per-position loop**.
7. **Reentrancy and flash-loan** attempts fail, asserted.
8. Every parameter is **per-asset** and settable only by the owner path.
9. Deployed to a **persistent public testnet with verified source** (`DIRECTION` §5 — a dev-chain deploy is never `done`).
10. **An adversarial audit package exists** — M2's own bar is _proof and audit packages, not "code exists"_.

**Unaudited means it does not take real deposits.** `launch.status` already returns `audited: false` honestly; the same applies here and it is not a formality.

---

## 8 · Order

1. Oracle, with the adversarial tests — **nothing else starts first**
2. Risk-parameter model, per asset, caps low
3. Supply and borrow, isolated mode only
4. Interest index
5. Liquidation, partial, with cascade tests
6. Reserve and bad-debt path
7. Cross-collateral promotion — **last, and only for assets that have earned it**

**The oracle is not step one because it is foundational. It is step one because if it is wrong, everything built on top of it is a liability rather than an asset.**

---

## 9 · Owner-gated

Per `DIRECTION-2026-07-31.md` §8: every risk parameter in §2, which assets list at all, the reserve factor, whether socialisation is acceptable, prod RPC and signing custody, and any claim that this is audited or insured.
