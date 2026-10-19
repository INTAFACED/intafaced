# ADR: the house desk and the market-making engine — what may be built before the owner rules

**Status:** **Accepted — 2026-08-12 (D26-P0-01 sealed).** The five mechanism rules below remain Accepted. The three owner questions are now **ruled** (external-only v1 · existence-disclosure deferred · hard mark exclusion). Source packet: `docs/OWNER-DECISION-PACKET-2026-08-09.md` (removed) §A1 — recommendations sealed as owner decisions this session.
**Decision owner:** repo owner (Denon). **Written by:** Denon.
**Law:** [`INTAFACED_DEFINITIVE_BUILD.md`](../../INTAFACED_DEFINITIVE_BUILD.md) §28 (`:770`–`:777`), the Throne Law at `:777`.
**Board:** `execution.sor`, `execution.arbitrage`, `execution.market-making`, `execution.house-tenant` — boarded 2026-08-08 (#1127). D26-P0-01 fairness gate sealed here.
**Binds:** [`adr/2026-08-05-futures-risk-and-mark-law.md`](2026-08-05-futures-risk-and-mark-law.md), [`adr/2026-08-04-matching-dual-target.md`](2026-08-04-matching-dual-target.md) (D-S-06).

---

## Why this ADR exists before any code

§28 says two things that are, as written, in tension with law we already Accepted.

**The Throne Law (`:777`):**

> "svc-execution is multi-tenant. The **house desk** runs as a sealed private tenant: separate keys, separate deployment namespace, strategies never in the product repo, never listed, never disclosed. The platform sells the rails, never the alpha."

**The HFT posture (`:774`):**

> "true microsecond HFT exists only where we own the venue: INTACORE and svc-matching, where our engine has structural first-class access."

**And the market-making engine (`:773`):**

> "the same engine seeds our books and works the street"

Put together: **a sealed, undisclosed house desk with structural first-class access to the venue our customers trade on, quoting both sides of the book we settle their trades against.**

Against that, this repo already decided:

> **A price that moves money is never supplied by the party it pays.**

That sentence was not abstract. It cost five findings in `svc-trade` in a single week, and one of them is exactly this shape at small scale: `futures/mark-from-depth.ts` discarded order size, so **two dust orders minted a payout-grade mark and moved 2,000 USDT** against a book worth femto-cents. An internal market maker is that same actor, institutionalised, funded, and running continuously.

**None of this means the house desk is wrong.** Every serious venue runs one, and §28's separation-of-keys posture is stronger than most. It means the fairness boundary is a product decision with money and reputation attached, and it must be made deliberately rather than discovered in an implementation.

---

## What is settled, and binds regardless of later internal rulings

Agents implement these now. They are not open.

**1. Internal quotes may seed liquidity. They may never become a mark.**
This follows from law already Accepted and needs no new ruling. A mark that moves money is subject to the `prices.ts` gates — `MarkQuality`, staleness, the deviation breaker armed against a stored basis, and `bestLevelIsQuotable`'s minimum resting notional. **A quote posted by the platform cannot be an input to a price the platform then pays out on**, whatever the tenancy arrangement. If the internal MM is the only resting size, the book is not payout-grade and the mark refuses — exactly as it does today for a dust book.

**2. No structural queue advantage may be implemented.**
§28`:774`'s "structural first-class access" describes owning the venue — colocation-by-construction, no network hop. It is **not** authority to give the house tenant earlier order visibility, priority in the matching sequence, cancel privileges customers lack, or a lower latency path _inside_ the engine. Those are different things and only the first is settled. **Matching treats the house tenant as an ordinary participant.** An agent that finds itself writing a branch on tenant identity inside the matching path has left the settled zone and must stop.

**3. D-S-06 stands: one book, and the router may not favour us structurally.**
`packages/venue-adapter/src/router.ts`'s bounded, tested **5 bps** internal tie-break is the whole of the permitted preference. The SOR extends the _cost model_ with §28`:770`'s missing terms — fees, expected impact, latency grade, transfer cost — it does not add a second preference rule. No second book, no second ranking.

**4. Sealed does not mean unaudited.**
"Strategies never in the product repo, never listed, never disclosed" is about **alpha**, not about **money**. The house desk's positions and fills move value, so they are ledger movements under Doctrine §0.6 like everyone else's: `packages/ledger-client` recipes, the same invariants, the same reconciliation. **A tenant whose fills do not reconcile is a second book**, which D-S-06 forbids by name. Secrecy of strategy is compatible with full accounting; secrecy of balances is not.

**5. Kill-switches and risk spine apply to the house tenant first.**
§28`:775` requires pre-trade checks, exposure caps, drawdown halts and a global admin kill-switch. §14.6 already requires every route killable and failing closed. **The sealed tenant is not exempt from the kill-switch**, and the admin console must be able to halt it. A tenant that cannot be stopped from the console is not a tenant, it is a second platform.

---

## Owner rulings (D26-P0-01 — sealed 2026-08-12)

These were reserved; they are now **Accepted owner decisions**, not recommendations.

### Q1 — House desk v1 is EXTERNAL-ONLY — **Accepted**

**Ruling:** The house desk for v1 trades **external venues only**. Internal venue trading (house desk on our own book / pointing `execution.house-tenant` at our matching book) stays **blocked** until a later explicit owner ruling.

**Unblocks:** `execution.sor`, `execution.arbitrage`, and the **external-venue** half of `execution.market-making` — ordinary engineering against external venues, with no fairness surface from trading our own users.

**Keeps blocked:** `execution.house-tenant` **internal half** (house on own venue) and the **internal** half of `execution.market-making`. Multi-tenancy as a **mechanism** (separate keys, namespace, audit) may still be built; pointing that tenant at our book may not.

### Q2 — Existence disclosure — **Deferred**

**Ruling:** Existence-disclosure is **not decided** in this seal, because it only applies if/when internal trading is ruled in. With Q1 external-only for v1, there is no house counterparty on our venue to disclose or hide. A later ruling that permits internal trading **must** answer existence-disclosure before that half ships — this ADR does not invent that answer now.

### Q3 — HARD EXCLUSION from mark derivation — **Accepted**

**Ruling:** Internal quotes are **never counted** in mark derivation. No percentage cap of resting notional is invented. This ties the residual influence question to the same refuse/dust posture as `DEFAULT_MIN_BEST_LEVEL_*` on the futures mark path — thinner marks on young markets are accepted over inventing an N% figure.

Mechanism rule 1 already forbade internal quotes becoming a mark; Q3 seals the stronger form: they are excluded from the derivation inputs entirely, not merely forbidden from being the sole supplier.

---

## What agents may implement without asking again

- `execution.sor` — the router, cost model and execution reports, **against external venues**, extending D-S-06's existing tie-break rather than replacing it.
- `execution.arbitrage` — the opportunity scanner, risk-checked sizing, leg execution and per-class PnL attribution, **on external venues**.
- The **external-venue** half of `execution.market-making` — quoting models, cross-venue hedging, kill-switches on volatility and inventory breach.
- The risk spine, pre-trade checks, exposure caps, drawdown halts and the admin kill-switch — for every tenant including the house one.
- Multi-tenancy as a **mechanism** — separate keys, separate namespace, per-tenant scoping and audit — with **no tenant granted any matching-path privilege**, and with the house tenant **not pointed at our own book** until a later internal-trading ruling.

## What remains blocked until a later explicit ruling

- `execution.house-tenant` **on our own venue**. The tenancy mechanism may be built; pointing it at our book may not.
- The **internal** half of `execution.market-making` (seeding / quoting our books as the house).
- Existence-disclosure copy or product posture for an on-venue house desk (Q2 — deferred until internal trading is in scope).
- Any mark-derivation change that **counts** internal quotes (forbidden by Q3 hard exclusion).
- Any branch on tenant identity inside `svc-matching`'s ordering or visibility.
- Any invented percentage cap on internal resting size for mark purposes.

---

## Done bar for the parts that are Accepted

1. The SOR ranks on the D-S-06 cost model with no internal preference beyond the tested 5 bps. Proven by a test that puts our book at a worse price and asserts it loses.
2. Internal quotes are excluded from any payout-grade mark (Q3 hard exclusion). Tested with an internal quote as the only resting size, asserting the mark **refuses**.
3. The house tenant's fills reconcile through `packages/ledger-client` like any other participant. Tested by `reconcile()`, not by inspection.
4. The admin kill-switch halts the house tenant. Tested by halting it, not by asserting the button exists.
5. No code path branches on tenant identity inside matching. **Asserted by a test, not by a comment** — this repo produced five guards this week that were correct in isolation and unreachable in place, each with a comment claiming the property the code lacked.
6. No path points the house tenant at our own matching book until a later owner ruling re-opens Q1 for internal trading (and answers Q2).
