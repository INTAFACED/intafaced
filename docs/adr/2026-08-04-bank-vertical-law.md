# ADR: when a bank vertical may say Done, and when it is a §13 socket

**Status:** **Accepted — 2026-08-04.** Owner decision, stated and confirmed.
**Decision owner:** repo owner. **Written by:** Denon.
**Spec id:** D-S-09, **completing** it rather than opening it.
**Builds on:** `SPEC-OTC-RFQ-AND-EARN-2026-08-02.md` (removed) Part B, which already decided the Earn half ("yield must have a named source"), and `DIRECTION-2026-07-31.md` (removed) §7. Neither answered the board's other column — **cards/ramps sandbox bounds, and what is §13 forever**. That is what this adds. Part B stands unchanged.
**Supersedes in scope:** nothing. Sharpens the Phase 5 done-bar in `BOARD-CLEAR-CONSTITUTION-2026-08-01.md` (removed) §3.8 for `bank.*` specifically.

---

## The decision

> **A bank vertical is a §13 socket only when the missing piece is a counterparty the platform cannot become.**
>
> Everything else is engineering, and engineering does not get to call itself a socket.

An index price is not a socket — we own `svc-trade`. Order-book depth is not a socket — same reason. An issuing BIN is a socket. Money-transmission permission is a socket. The test is not "is this hard" or "is this unbuilt"; it is **"could this platform, with unlimited engineering time and no third party's signature, produce it?"** If yes, it is work. If no, it is §13.

This is settled. Agents and engineers implement it; they do not re-litigate it.

---

## The second decision, which is the one that unblocks the board

> **`bank.cards` and `bank.ramps` each contain a completable half and a §13-forever half. They are to be split, not resolved.**

The current tracker collapses each into one row with no `status`, which makes them indistinguishable from each other and from `bank.earn` — a vertical with four procedures, four recipes, three tables and roughly twenty tests already on main. A board on which shipped code and zero code render identically is not reporting anything.

The receiving rows already exist. `socket.live-issuer` and `socket.psp-partners` are both filed under the tracker's `§13 · DELIBERATELY NOT IN v1` block. The split has somewhere to land without inventing a row.

---

## The bar: `bank.loans` is the reference implementation

Nothing below asks for a new standard. `bank.loans` already meets it — 2,476 lines, 86 tests, seven recipes, seven tables — and the parts worth copying are specific:

**Seize, sell and repay is ONE posting.** [`recipes/loans.ts:296-313`](../../packages/ledger-client/src/recipes/loans.ts) argues why, and the argument generalises to every vertical here:

> "Between the release and the sale the borrower holds spendable collateral on a defaulting loan, and they are watching. One withdrawal in that window and the platform is unsecured... The window cannot be closed with a lock, because the lock is the thing being released."

**A missing counterparty is a refusal, not a default.** `bank.no_liquidation_counterparty` ([`loan-service.ts:1223-1230`](../../services/svc-bank/src/loans/loan-service.ts)) fires when no buyer exists, because booking one anyway "would post a fictional trade and hand the borrower's collateral to an account that never paid for it."

**A loss that cannot be named cannot be absorbed.** `loanBadDebt` fails when the insurance fund is empty, on purpose ([`recipes/loans.ts:394-412`](../../packages/ledger-client/src/recipes/loans.ts)):

> "A platform that cannot name where a loss came from should not be able to absorb it silently; an operator seeing this refuse is an operator who has learned something true on the day it became true."

**The gap is disclosed in the code, not hidden.** `marketMakerVenue` states what it is not: "a walk down a real order book... this is an atomic sale to a named counterparty at a marked price — honest, and less than the spec's sentence promises."

A vertical that does all four may claim its half of Done. A vertical that does three of them may not.

---

## Vertical by vertical

| Vertical                       | Missing in the WORLD                                           | Missing in CODE                                     | Verdict                                                                    |
| ------------------------------ | -------------------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------- |
| **`bank.loans`**               | Nothing. Index price and book depth belong to `svc-trade`.     | The `PriceSource` adapter; a book-walking venue.    | **Done, and the row is honest.** Both gaps are ports, both disclosed.      |
| **`bank.earn`**                | Nothing. Yield pays from `houseFees` — internal value.         | Revenue sweep; interest chunking. Both additive.    | **May claim Done now.** The code cleared the bar; the row is stale.        |
| **`bank.cards` — ledger half** | Nothing. Auth decision, balance check, decline, cashback.      | `CardIssuerAdapter` + `card-sim`. Zero lines exist. | **Buildable today** from the loans template.                               |
| **`bank.cards` — live rail**   | A card-scheme sponsor / issuing BIN. A licence and a contract. | Only the adapter — which is the socket.             | **§13 forever.** Lands on `socket.live-issuer`.                            |
| **`bank.ramps` — crypto leg**  | Nothing. `crypto-native` is already a real rail.               | A recipe and a router surface. Zero lines exist.    | **Buildable today.** Satisfies "one rail path".                            |
| **`bank.ramps` — fiat leg**    | A bank/PSP partner and money-transmission permission.          | Adapters only.                                      | **§13 forever.** Lands on `socket.psp-partners`.                           |
| **`bank.sovereign-card`**      | Custodial half: nothing. Contract half: a live chain.          | Depends on `bank.cards` existing at all.            | **Not agent-completable.** The JIT contract is Shehzad's protocol board.   |
| **`margin`**                   | —                                                              | Nothing. It is loan risk state inside `bank.loans`. | **Not a vertical. Do not create the row.** Perp margin is `trade.futures`. |

---

## Three distinctions that are not the same thing

Agents keep collapsing these. They have different owners and different remedies.

**§13 socket** — a counterparty we cannot become. Remedy: a commercial relationship. Nobody can code past it. Documented with a written reason, per §13.

**Class X gate** — the code exists and works; a human must decide to point it at real money. `bank.cards` carries "Class X issuer keys = Nitro human". This is a **decision**, not a missing rail, and it does not make the vertical a socket.

**Unbuilt** — nothing stands in the way but time. `bank.cards`' ledger half and `bank.ramps`' crypto leg are here. This is the largest category and the one most often mislabelled as §13, because "we have no card programme" sounds like one sentence when it is two.

---

## Corrections this ADR makes to the board

1. **`bank.earn` has no `status` field** and should carry `status: 'done'` on the evidence already on main, or a stated reason why not. The campaign bar is "at least one earn product path ledger-safe + API"; flexible **and** fixed pools exist, accrual is idempotent twice over, `bank.pool_underfunded` refuses, and reconciliation has two independent answers.

2. **`bank.earn`'s note says "Class X issuer keys = Nitro human".** Earn has no issuer keys — this is copy-paste from the `bank.cards` row. It should be struck. A false Class X marker on a shippable vertical is exactly the kind of thing that leaves working code sitting unclaimed.

3. **`bank.cards`, `bank.ramps` split** into a ledger half that can reach Done and a rail half that points at its existing socket row.

4. **`socket.live-issuer` carries no note.** §13 requires a written reason. It needs one sentence: a card-scheme sponsor and issuing BIN are a commercial relationship, not code.

---

## `prices.ts` is the refusal vocabulary — D-S-01 must reuse it, not respell it

`svc-bank`'s mark-acceptance layer already solved "when may a price move someone's money", and `trade.futures` faces the identical question. **The futures spec adopts these identifiers verbatim.** A second vocabulary meaning the same thing is how two subsystems come to disagree about what a stale price is.

Binding: the type `MarkQuality` (`'mid' | 'last' | 'index'`); the four-field `MarkPolicy`; the split gates `acceptableForMarking` / `acceptableForLiquidation`; the error codes `bank.mark_unusable` and `bank.mark_invalid`.

Three properties carry across, and each was argued once already:

- **The asymmetry.** Warnings tolerate a stale mark; seizures do not. "Refusing to warn a borrower because the feed is 40 seconds old leaves them uninformed; refusing to SELL on the same mark leaves them with their collateral."
- **`last` is not a liquidation basis.** `liquidationQualities: ['index', 'mid']`. A market with no two-sided quote cannot be liquidated at all — the position sits and an operator looks at it.
- **A missing mark is not a zero mark.** Omitted from the map, so the caller refuses to value the position rather than valuing it at nothing.

The deviation breaker is integer-only and rounds up, so a move exactly on the breaker trips it. No floats anywhere in this path.

---

## Done bar

A bank vertical may move to `done` when:

1. Every value movement goes through a `packages/ledger-client` recipe. No exceptions, no local balance.
2. Amounts are decimal strings on the wire and scaled bigint in memory. No `number` touches money.
3. Every refusal has a named error code and refuses rather than defaulting — no counterparty, no mark, no funds each produce a refusal a caller can distinguish.
4. Any half that depends on a §13 socket is **split out and named**, and the shipped half does not claim the socket's function.
5. Empty is rendered empty. Unavailable is stated. Nothing is invented.
6. The tracker row says what is true, including the residual.

---

## What agents may implement without asking again

- `CardIssuerAdapter` + `card-sim`, to the loans bar, against the ledger only.
- The crypto leg of `bank.ramps` over the existing `crypto-native` rail.
- Any additive socket already named in code — the earn revenue sweep, interest chunking.
- Tracker corrections 1–4 above.

## What still needs the owner

- Any live rail: a card programme, a sponsor bank, a PSP contract.
- Class X — pointing working code at real money.
- The `bank.sovereign-card` on-chain half, which is Shehzad's board.
- Changing this ADR's §13 test.
