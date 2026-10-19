# ADR: P2P escrow and disputes — a timer is not a moderator

**Status:** **Accepted — 2026-08-04.** Owner decision, stated and confirmed.
**Decision owner:** repo owner. **Written by:** Denon.
**Spec id:** D-S-08.
**Resolves:** an apparent conflict between doctrine §19/§23 and two accepted specs, plus a live contradiction between a spec and shipped behaviour.

---

## Decision 1 — there is no "escrow handoff to chain plane", because there are two products

The board's column reads _"escrow handoff to chain plane."_ That phrase appears **exactly once in the repo — in the board cell itself.** Nothing implements it, and two accepted specs appear to contradict the doctrine that inspired it:

- `SPEC-SOVEREIGN-ROUTING-AND-COPY-2026-08-01.md (removed):29,32` — _"OTC escrow | Fiat | escrow **is** custody, by definition"_ … _"A spec that claims escrow is non-custodial is lying about the word."_
- `SPEC-OTC-RFQ-AND-EARN-2026-08-02.md (removed):29` — _"**Escrow is custody.** Fiat Plane, no argument."_
- Doctrine §19 — _"the P2P escrow runs custodial (ledger) or sovereign (contract) at the user's choice."_

> **The specs are right and the doctrine is right, and the error is the word "the".**
>
> **Custodial escrow — value we hold — is Fiat Plane, permanently. Contract escrow, where the platform never touches either leg, is a DIFFERENT PRODUCT on the Protocol Plane. It is not a migration of this one, it does not inherit this spec, and no user's existing escrow ever "hands off" to it.**

Once separated, nothing conflicts. What we hold is custody, which is what the specs say. What a contract holds instead is a separate offering at phase 3P, tracked as `protocol.escrow` (owner `shehzad002`, currently ⛔, no escrow contract of any kind exists in `services/svc-protocol/contracts/`).

**So this ADR governs the custodial product only, and the custodial product has no chain-plane future.** Anyone building sovereign escrow starts from a new spec on Shehzad's board.

This is settled. Agents and engineers implement it; they do not re-litigate it.

---

## Decision 2 — a human adjudicates. The timer never does.

`SPEC-OTC-RFQ-AND-EARN-2026-08-02.md (removed):33` says:

> "**No automated resolution of a disputed release** — this is the one place in the platform where a human decision is the correct design, not a fallback."

The shipped system contradicts it: a disputed trade reaching its 7-day deadline is auto-resolved by `backstop_resolve`, defaulting to **refund**, attributed to `system:p2p-backstop`.

Removing the backstop is not available — `p2p_trades_live_has_deadline_ck` makes "a trade sits in escrow forever" unrepresentable by construction, and that constraint is correct.

> **A dispute outcome is a human decision, recorded and reviewable. The timer may warn and drive an SLA. It may never dispose of value.**

**Owner ruling, 2026-08-04.** My first draft of this ADR said the backstop stays, renamed to a timeout disposition, gated on the moderation path being reachable. The owner was stricter and is right: auto-refund as adjudicator contradicts SPEC-OTC, and a gate that merely _delays_ the timer still leaves a machine deciding who was telling the truth. **The timer is out of the adjudication business entirely.**

The apparent obstacle dissolves on inspection. `p2p_trades_live_has_deadline_ck` requires a **live trade to carry a deadline** — it does not require the deadline to **settle** anything. So at deadline a disputed trade **escalates and re-arms**: SLA breach, alert, priority in the queue. Value does not move. "A trade sits in escrow forever" stays unrepresentable, and no machine rules on a dispute.

The spec's principle then needs the real defect fixed, which is not the timer. **It is that a human cannot intervene even if they want to:**

- **No queue.** There is no `disputes.list`. A moderator can only call `.get({ tradeId })` — they must already know the id. The index that would serve the queue (`p2p_disputes_open_idx`) exists and **nothing queries it**.
- **Evidence is write-only.** It is accepted, stored in `p2p_disputes.evidence`, and **never appears in the output schema**. A moderator cannot read it through any API. Timeout-opened disputes carry no evidence at all.
- **No console.** `apps/admin` has no dispute page. The only frontend reference to disputes anywhere is the buyer/seller _open_ button.
- **No way in.** `admin:compliance` is a scope **no user session carries** — asserted by test.
- `p2p_trades.chat_thread_id` exists and is referenced by **zero lines of code**. There is no message thread and no attachment store.

**A timer that fires because nobody could have looked is not a fallback. It is the only path.** Under the ruling above it is not a fallback even when someone _could_ have looked — but the reachability gap is what made it the only path, and it has to be closed regardless.

---

## The rule

**No dispute outcome is produced by anything but a human decision, and that decision is recorded and reviewable.** The moderation path must therefore actually exist, which means all four of:

1. **`disputes.list`** — a queue ordered by deadline. "Must already know the `tradeId`" is not a queue.
2. **Evidence readable on `get` AND `list`** — not write-only.
3. **A scope a real session can hold.** `admin:compliance` with no possible holder is not a path; `packages/auth/src/auth.test.ts:148` currently asserts `SESSION_SCOPES` does not contain it. Note that changing this is close to `DIRECTION` §3's "grants or widens a scope" carve-out, so it is designed and tested by agents and **signed off by the owner** before merge.
4. **A record of the ruling** — who, when, on what evidence — reviewable afterwards.

**What the deadline does instead.** It escalates: SLA breach, alert, queue priority. It re-arms. It never settles.

**The default disposition question disappears with the timer.** The env default currently routes the loss off-platform, reasoning that _"refunding a buyer who did pay leaves them a fiat claim they can still pursue through their bank."_ Under this ruling there is no default to disclose, because there is no automatic outcome — which is a better answer than disclosing one.

---

## Decision 3 — `trades.take` is already the oracle, so the empty-`methods` question is not what it looked like

I previously deferred this as a choice between forbidding empty `methods` (breaking existing offers) and adding an endpoint that exposes a seller's method ids (a new fingerprinting surface). **Both framings were wrong: the surface is already open.**

`attachToTrade` throws with the method id echoed back — _"The seller has no active \"${methodId}\" destination for ${fiatCurrency}"_ — and the mapper returns `err.message` verbatim as a `BAD_REQUEST`. The throw is inside the reserve transaction, so the probe **rolls back cleanly**: no trade row, no inventory decrement, no escrow, no cost. And `logDenied` is not called on this path, so **it writes no access-log row**.

So each take attempt is a free, unlogged, self-describing confirm/deny for "does seller S hold an instrument for method M in currency C". `instruments.methods.list` hands any authenticated caller the complete candidate list to enumerate against.

> **Owner ruling, 2026-08-04: treat it as a product surface, not an accident. Either redesign it as an intentional, logged, non-abusive probe, OR close and remove the oracle. What may not stand is unlogged method-id fingerprinting.**

Both outcomes are acceptable and the implementer picks one with a justification. There is a genuine product argument for the probe: a taker does need to know a seller can receive their payment method, and today they learn it by accident. Designed deliberately it would be rate-limited, access-logged, and scoped to a real trade intent. Closed, the refusal simply stops distinguishing "no such instrument" from any other reason the take could not proceed.

What is not acceptable is the status quo — a free, unlogged, self-describing oracle that nobody chose.

This is the same rule as [`2026-08-04-authority-and-refusal-shape.md`](2026-08-04-authority-and-refusal-shape.md), arriving from a different direction: **a refusal may only describe objects the caller was entitled to see.** A seller's payment instruments are not among them.

Empty-`methods` offers then stop mattering as a security question and become an ordinary product one: an offer a taker cannot complete should not be takeable. Forbid empty `methods` on **new** offers; leave existing ones and let them refuse honestly.

---

## Decision 4 — the ReDoS mitigation is "the operator is trusted", and must be stated that way

All four claimed mitigations are true — pattern capped at 200 chars, compile-checked at registration, input bounded to 512, supplier is an `admin:compliance` operator — **and the caps do not bound runtime.** Measured: `(a+)+b` is six characters, compiles cleanly, and 29 characters of input blocked the event loop for **8.9 seconds**.

> **Owner ruling, 2026-08-04: a real fix is required.** "Length cap alone is not mitigation. **Operator trust is not the control.**"

My first draft said the caps are not the control, the operator boundary is, and that this should be written down where the caps are defined. **That is overruled, and rightly** — documenting a weak control does not make it a control, and "the only person who can trigger this is trusted" is an argument that ages badly the moment a scope widens or a migration writes the row directly.

An actual control means one of: a regex engine without catastrophic backtracking (RE2-class), a linearity/complexity check at registration, or a hard execution timeout. The implementer evaluates and justifies the choice.

Two real defects alongside it, both to fix:

- **The compile-checked regex is not the regex that runs.** Registration checks `new RegExp(pattern, 'u')`; validation runs `anchored(pattern)`, which strips a leading `^` and trailing `$` naively — so a pattern ending in an **escaped** `\$` (entirely plausible for a currency field) passes registration and throws a raw `SyntaxError` → 500 on every user's first save. This is precisely the failure the compile check exists to prevent: _"A bad schema is worse than no schema: it is accepted once and then rejects every instrument a real user tries to register."_
- **The DB does not back the caps.** `toSchema` casts `row.fields` with no re-validation, and the only column constraint checks "non-empty JSON array". Any migration or direct SQL bypasses both the cap and the compile check.

---

## Decision 5 — P2P has no erase path, and that is a gap, not a socket

`blueprint.export` / `blueprint.erase` are real, self-only, and a genuine hard delete — **and every statement in them is prefixed `blueprint.`**. No p2p table is covered. There is no platform-wide erasure orchestrator, no per-service erase convention, and **svc-p2p subscribes to no events at all**, so it could not hear an account-deletion signal if one existed.

Today `instruments.reveal` is the de facto export and `instruments.remove` the de facto erase, both one instrument at a time and only while active. **A trade's frozen snapshot cannot be erased on request at all** — only by the 90-day clock, and only after the trade resolves. Reputation, trades, offers and disputes have no erase path whatsoever.

> **Owner ruling, 2026-08-04: P2P erase is REQUIRED. "Stage if needed; not 'never / only blueprint.'"**

My first draft tracked this as a defect. The owner requires it built. **Staging is explicitly permitted** — so the first stage lands properly and the remainder is named and ordered, rather than the whole thing becoming a design document.

It is not a §13 socket in any part: nothing is missing from the world, only code. And note what the current position actually is — `instruments.reveal` is the de facto export and `instruments.remove` the de facto erase, both one instrument at a time and only while active, while a trade's frozen snapshot cannot be erased on request at all. That is not a staged plan; it is an absence that happens to have two adjacent procedures near it.

---

## What Done means for `p2p.*`

Three rows currently overclaim, measured against the tracker's own three-part test:

- **`p2p.disputes` = `done` is the clearest overclaim.** The word doing the work in the title is _"moderated"_, and the shipped behaviour is **timer-adjudicated**. Fails "not propped up".
- **`p2p.escrow` = `done`** — contradicted by #428's own note: escrow locked, released and refunded while _"at the moment the buyer had to pay, there was no account to pay to."_
- **`p2p.merchants` = `ready` with no note**, while both its research packs say the substrate does not exist.

All four `done` notes assert existence only — _"Escrow flows in svc-p2p"_ — and rest on `requires: ['services/svc-p2p']`, a bare directory, which `features.mjs` itself says proves none of the three criteria.

---

## Refuse cases

| Situation                                      | Correct answer                                                                                                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dispute hits deadline, moderation unreachable  | **Escalate and hold.** Do not dispose of value.                                                                                                               |
| Take against a method the seller does not hold | **Refuse without distinguishing why**, and access-log it.                                                                                                     |
| Offer with empty `methods` (new)               | **Refuse at creation.** Existing offers refuse at take, honestly.                                                                                             |
| Settlement ledger post fails permanently       | **Surface it.** Today the error is discarded by a bare `catch` and the trade sits `resolved` but unsettled forever, and `escrowIntegrity()` will not flag it. |
| Erase requested for P2P data                   | **Say it is not built.** Never imply blueprint's erase covered it.                                                                                            |
| Schema pattern that compiles but cannot anchor | **Reject at registration**, checking the anchored form.                                                                                                       |

---

## What agents may implement without asking again

- `disputes.list`, backed by the index that already exists.
- Serialising evidence to the moderator, and an append-evidence path.
- Gating the backstop on moderation reachability.
- Closing the `trades.take` oracle and access-logging it.
- The anchored-regex registration check, and the operator-boundary comment.
- Surfacing permanently-failed settlements instead of discarding the error.
- Correcting the three tracker rows above.

## What still needs the owner

- **Sign-off on making `admin:compliance` holdable** — designed and tested by agents, but it widens a scope, which is a `DIRECTION` §3 carve-out.
- The P2P erase path's **scope and staging order** — a legal question before a technical one. Building it is no longer optional.
- Sovereign escrow, which is a new product on Shehzad's board and not this spec.
