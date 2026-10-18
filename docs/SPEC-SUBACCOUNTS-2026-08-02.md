# Spec — sub-accounts and the identity money graph (M5)

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

M5 asks for "sub-accounts with zero money cross-leak". **"Zero cross-leak" is the entire feature**, and it is easy to state and easy to get subtly wrong, so this defines it precisely rather than aspirationally.

---

## 0 · What a sub-account is — decided

A sub-account is a **named partition of one identity's holdings**. It is not a second user.

- **One identity, many sub-accounts.** The identity is the KYC subject, the legal person, the sanctions subject.
- **A sub-account has its own balances, orders, positions and fills.**
- **A sub-account has no independent identity, tier, or jurisdiction.** It inherits every one of those from its parent, always, with no override anywhere.

**That last line is the most important sentence in this document.** A sub-account that can hold its own tier is a KYC bypass; a sub-account that can hold its own jurisdiction is a sanctions bypass. Neither may be representable in the data model — not merely disallowed by policy, but **impossible to express**. If the column exists, someone eventually sets it.

---

## 1 · Zero cross-leak — the precise definition

Given sub-accounts `A` and `B` under the same identity, and no explicit action by the user:

1. **No balance of `A` may fund an obligation of `B`.** Not a hold, not a fee, not a margin call, not a liquidation, not a shortfall.
2. **No order, position or fill of `A` is visible when acting as `B`.**
3. **No operation addressed to `B` may act on a row belonging to `A`** — even when the caller legitimately owns both.
4. **Insufficient funds in `B` is a refusal, never a silent reach into `A`.**
5. **A liquidation in `B` may never touch `A`'s collateral.**

**Rule 5 is where this gets violated in practice.** Risk engines want to see the whole customer relationship — cross-margin is a real product and a legitimate one. **It is not this feature.** If cross-margin is wanted, it is a separate, explicitly-consented product with its own spec, not an emergent property of a risk engine that was allowed to look one level up.

### The one exception, and it is explicit

**Transfer between sub-accounts** — the user's own deliberate act. It is a §0.6 ledger recipe, it is logged, and it is the _only_ path by which value crosses the boundary. Anything else that moves value between two sub-accounts is a bug, by definition.

---

## 2 · Ownership gates — the failure mode we already had

**#58 fixed exactly this class of bug: "check the caller owns the row, not just the scope."** Sub-accounts multiply the surface for it, because now the same user legitimately owns many rows and the naive check passes.

**The rule:** every money operation resolves the target sub-account and asserts that **this principal owns this specific sub-account**, before anything else happens.

- A valid scope (`trade:write`) says _what_ the caller may do. It says nothing about _whose_ sub-account they may do it to.
- The check is **ownership of the row**, not membership of a set. `sub_account.identity_id == principal.identity_id`, verified against the database — not inferred from a claim in a token that the client supplied.
- **Fail closed.** An unresolvable or absent sub-account is a refusal, never a fallback to a default. **"No sub-account specified, so use the primary" is how funds move out of the wrong partition** — and it will read as reasonable to whoever writes it.

**Enforce it at the door, not in each handler.** A gate that must be remembered in every new endpoint will eventually not be. This belongs where the principal is resolved.

---

## 3 · Freeze, sanctions and compliance — cascade always

**A sub-account is not a compliance boundary. It is a bookkeeping boundary.**

- **Freezing an identity freezes every sub-account under it.** Immediately, atomically, with no partial state.
- **Screening runs at the identity level.** A sub-account cannot be screened independently because it is not a legal person.
- **Tier gates read the identity's tier.** Never a per-sub-account value, because that value must not exist (§0).
- **A sub-account may never be used to hold value the parent identity is not permitted to hold.**

**If freeze does not cascade, sub-accounts become the most convenient sanctions bypass in the platform** — and it would be entirely accidental, which is why it is stated here rather than assumed.

---

## 4 · Lifecycle

- **Creation** is cheap and needs no new KYC — the identity is already known. Bound the count per identity; unbounded partitions are an abuse and an operational burden.
- **Naming is user-controlled and must not be trusted.** It reaches other surfaces; treat it as untrusted input everywhere it renders.
- **Closure requires a zero balance and no open positions or orders.** A sub-account cannot be closed with value in it, and it cannot be closed to escape an obligation. **Closing is not a way to abandon a debt.**
- **Deletion is a soft close.** History is retained — the ledger is append-only and a closed partition's journal must remain readable.
- **The primary sub-account cannot be closed.** Every identity retains a destination for inbound value.

---

## 5 · API shape — so the UI can be wired later

M5 explicitly asks for APIs that agents can wire a UI onto. Two design rules make that possible without leaks:

- **Sub-account is an explicit parameter on every money operation, never implicit context.** No ambient "current sub-account" on the server. Ambient state is how an operation lands in the wrong partition after a refactor nobody thought was risky.
- **List endpoints are scoped to one sub-account by default**, with aggregation as a deliberate, separate call. The aggregate view is a _read_, and it must never become a path through which a write reaches a sibling.

Aggregate reads are fine and expected — a user seeing all their balances at once is the point. **Reads may aggregate; writes never may.**

---

## 6 · Interaction with the other mountains

- **Futures (M3):** a position lives in one sub-account. Margin, liquidation and the insurance-fund shortfall path all stay inside it. See §1.5.
- **Lending (M2):** collateral in `A` never backs a borrow in `B`. Isolated mode is per sub-account **and** per asset.
- **Pay (M1):** a merchant's settlement destination is a specific sub-account, and it must be verified as owned before a payout instruction is built.
- **Copy trading (M4):** the sovereign spec's session keys are scoped to **one** sub-account. Copying with a session key that can reach a sibling defeats the follower's caps entirely.

---

## 7 · What `done` means

1. A transfer is the **only** path value crosses between sub-accounts, asserted by a test that tries the others.
2. **Insufficient funds in `B` refuses** rather than reaching into `A` — including under margin call and liquidation.
3. An operation naming `B` **cannot act on `A`'s rows**, even for a caller who owns both.
4. **Freeze cascades atomically**, proven.
5. **No per-sub-account tier or jurisdiction column exists** — verified structurally, not by convention.
6. **A missing sub-account parameter refuses**; it never defaults to primary.
7. **Closure with a non-zero balance or an open position is refused.**
8. Aggregate reads work; **no aggregate path permits a write.**

---

## 8 · Owner-gated

Max sub-accounts per identity, whether cross-margin is ever offered as a distinct consented product, and any change to freeze-cascade behaviour (`DIRECTION-2026-07-31.md` §8).
