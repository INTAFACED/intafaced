# ADR: when a hold binds — Class M merge authority

**Status:** **Accepted — 2026-08-04.** Owner decision, stated and confirmed.
**Decision owner:** repo owner. **Written by:** Denon.
**Spec id:** D-S-16, **completing** it.
**Builds on:** `DIRECTION-2026-07-31.md` (removed) §3, which decided the merge rule and its four carve-outs. That stands verbatim. This defines **when a hold binds**, which is the part the board's column asked for and §3 does not say.

---

## The rule, unchanged

> **Agents may merge Class M on green + self-audit + adversarial review**, with four carve-outs that stay the owner's:
>
> - anything that **moves value to an external counterparty**
> - anything that **grants or widens a scope**
> - anything that **adds or changes a ledger recipe**
> - anything that **touches a posture gate, kill-switch, or custody scan**
>
> "Those four are not about trust — they are the places where a mistake is silent and reconciliation finds it days later. Everything else in Class M: ship it."

---

## The decision this adds

> **A hold binds when it is written where the work is, names what it covers, and says what lifts it. A hold that fails any of those three does not bind, and an agent may proceed.**

The failure this prevents is not agents ignoring holds. It is **holds that nobody can act on**: a sentence in a document nobody reads at merge time, covering a scope nobody can determine, with no stated condition for release. Those accumulate, they are never lifted because nobody knows who could lift them, and they eventually get ignored wholesale — which destroys the ones that mattered.

This is settled. Agents and engineers implement it; they do not re-litigate it.

---

## The three requirements

**1 · Written where the work is.** A hold binds if it is on the tracker row, in `CODEOWNERS`, in the file's own header, or on the PR. A hold that exists only in a coordination document does **not** bind a merge, because the merge does not pass through that document.

The carve-outs above are the exception and are permanently binding, because they are stated in doctrine and mechanically checkable: does this PR move value externally, widen a scope, change a recipe, or touch a gate? Those questions can be answered from a diff.

**2 · Names what it covers.** A path, a module, a tracker row, or a named capability. "Don't touch the money stuff" does not bind — nobody can tell whether their PR is inside it. **The scope must be answerable from a diff**, by someone who was not present when the hold was written.

**3 · Says what lifts it.** A condition, a decision, or a person. A hold with no stated release condition is not a hold, it is an obstruction — and it is the reason a board fills with rows nobody dares touch.

---

## What is NOT a hold

- **A tracker row with no `status`.** That means unstarted, not held. `bank.earn` sat statusless with four procedures and thirty tests on main; reading that as a hold is how shipped work stays unclaimed.
- **A `⛔` in a generated view.** `docs/TRACKER.md` is generated from `features.mjs`. The row is the authority; the render is not.
- **A stale claim on a session board.** `LIVE-LANES.md` is _session_ who-codes-what. A lane row referencing a PR that has merged is expired, not binding.
- **Another agent's open PR** — that is a **dual-edit** rule, which is different and stricter: do not edit the same files, regardless of holds.
- **A law document naming a branch or a gate.** Two such instructions in `DIRECTION` have been found stale today — §2's resume of `feat/multi-asset-instruments` and §4's direction to extend `custody-scan` to Java. Both were correct when written. **An instruction that has been overtaken by the code does not bind**; report it and proceed.

---

## What binds absolutely, regardless of anything else

The four carve-outs. Plus:

- **Class X** — real money, production go-live, live keys. Never an agent decision, and distinct from §13: a socket is a missing counterparty, Class X is a decision about working code.
- **Shehzad's chain mountains** — protocol / INTACHAIN / bridge / launch contracts. Consume freely; implement never.
- **§13 sockets** — a socket may not be closed by inventing the missing counterparty.
- **The invent ban.** Where no law exists, agents research and propose; they do not decide. That is what the D-S spec factory exists to resolve, and it resolves by a spec landing, not by a deadline passing.

---

## The corollary that matters most right now

**A hold that turns out to be wrong is reported and lifted, not worked around.**

Seven D-S slots were labelled "blocked on Denon" while the specs had been on `main` for three days. Nobody was defying the label — everyone was respecting a hold that had already been satisfied. **The cost of a stale hold is not that it gets broken. It is that it gets obeyed.**

So: an agent that finds a hold it believes is satisfied or stale **says so, with evidence, and proceeds** — rather than waiting for someone to notice. The evidence requirement is what keeps this from becoming a loophole.

---

## Done bar

1. Every binding hold names its scope in a way answerable from a diff, and states what lifts it.
2. Holds live where merges pass: tracker row, CODEOWNERS, file header, or PR.
3. No hold exists only in a coordination document, except the four doctrinal carve-outs.
4. A statusless tracker row is never read as a hold.
5. Stale holds are reported and lifted, with evidence, rather than silently obeyed or silently broken.

---

## What agents may implement without asking again

- Merging Class M on green + self-audit + adversarial review, outside the four carve-outs.
- Lifting a hold they can demonstrate is satisfied, stating the evidence.
- Correcting a stale instruction in a law document, at the point of correction.

## What still needs the owner

- The four carve-outs, every time.
- Class X, every time.
- Adding a new binding hold, or changing this rule.
