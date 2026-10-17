# Money-spine decisions — 2026-08-08

Nitro's instruction: _"i cannot make decisions myself. you need to make these
decisions. eliminate any room for error by doing research, doing the right reasoning,
and having the context that you need."_

So the four items the audit files had parked as "Nitro must decide" are decided here,
with what was checked, the decision, and — for every one — the **condition that should
flip it.** A decision without a flip condition is a guess wearing a suit.

Two turned out not to be judgement calls at all: the doctrine already rules on one, and
the other is settled by reading the code. Two are genuine engineering judgements, and
both come out NO.

**Nothing in this file is left open. There is no pending ruling on the spine.**

---

## D1 · `assets.decimals` — DECIDED: it is rail and display metadata, not a ledger scale

**The question as parked:** enforcing a per-asset scale means choosing where the
sub-unit remainder goes, and every option is a fee policy.

**What I checked.** `INTAFACED_DEFINITIVE_BUILD.md` §4.2, the money law itself:

> `amount numeric(38,18)`, `balance_after numeric(38,18)`
> Invariant 5: "Reconciliation job: snapshots vs. entry replay **must match to 18
> decimals**; mismatch = page the operator, freeze the module that diverged."

**The doctrine fixes the ledger's scale at 18 decimals, universally, for every asset.**
It says nothing about per-asset scale, dust, or rounding anywhere.

**Therefore this was never a policy question.** `0004`'s claim — that `decimals` is "the
scale the ledger reconciles the asset at" — does not merely lack an implementation, it
**contradicts §4.2 invariant 5.** Wiring the column into ledger arithmetic would have
put the ledger in breach of its own law. The column cannot be a ledger scale, so there
is no dust policy for the ledger to have.

**The decision:** `assets.decimals` is metadata _about the asset_ for the surfaces
outside the ledger that need it — rail minimums, quoting, display precision. The ledger
stores and reconciles at 18 dp by law. #1064 already corrected the false claim; this
records what the column _is_, so the next audit does not re-open it as a spine residual.

**What that leaves, honestly, and where it belongs.** A user holding `100.004` JPY
cannot withdraw the last `0.004` if the fiat rail moves whole units. That is real, it is
true of every exchange, and it is handled by **withdrawal minimums on the rail** — which
is `svc-bank`'s ramps, human-claimed by `@cursor-swarm-bank` and fenced from this lane.
It is a rail/UX concern, not a book defect, and the book is not wrong about anything.
Reported, not fixed here, and not a spine residual.

**Flip condition:** if §4.2 invariant 5 is ever amended to a per-asset scale, this
becomes a real policy question again and the tripwire test in
`assets-decimals.test.ts` will fire the moment anyone starts wiring it.

---

## D2 · Strict body-match on an idempotency replay — DECIDED: NO

**The question as parked:** neither engine compares a replayed body to the stored
transaction, so a caller reusing a business id for a genuinely different movement is
told its own post succeeded.

**What I checked.** Every `idempotencyKey` derivation in `recipes/index.ts` — all 33 of
them. Every one is built from a business identity: `order.hold:${orderId}`,
`p2p.escrow.release:${tradeId}`, `deposit:${rail}:${railRef}`,
`settlement:${merchantId}:${window}:${assetId}`, `token.emission:${epoch}`. So the same
key genuinely does mean "the same business event", and Stripe's model — same key,
different body, hard conflict — is the industry norm and the fail-closed direction.

I was inclined to ship it. Three findings changed that.

**1 · It would be a new outage mode on the money path.** Five services post through this
boundary. Any caller that rebuilds a request on retry and recomputes an amount even
slightly differently — a fee re-derived, a rounding step re-run — moves from a safe
no-op to a hard failure on a movement that already completed. That trades a rare silent
wrong for a common loud stop, on the hottest correctness path in the system.

**2 · It cannot be done properly without resolving account references on the fast
path.** A stored entry holds `account_id` (a uuid); a request holds an `AccountRef`. To
compare _who_ was paid, both engines would have to resolve refs to ids inside the
idempotent-return path — an extra query in Postgres on the path that exists to be cheap.
The affordable version compares only per-asset totals and leg counts, which catches a
wrong amount and **misses paying the wrong account the right amount.** Shipping the
partial version would have looked like the invariant was closed when the worst case was
still open. That is the exact shape of the findings this audit spent the day removing.

**3 · It contradicts a contract I landed hours earlier, and that tension is a signal.**
#1060's conformance case replays a committed key with a body that fails validation and
requires the original transaction back. Under body-matching that case has to be
rewritten, and when I worked out how, I found that **every** current validation rule is
a function of the entries — so "same money, now-invalid body" is an empty set with
today's rules. The two ideas fit together only after redefining what "the same request"
means. That is a design sitting, not a session tail.

**The decision: no.** The realistic version of this bug — a placeholder key like `''`
squatting the namespace — is already closed by **#1067**'s 8-character database floor.
What remains needs a caller to reuse a real business id for different money, which is a
caller-side bug, and the honest response is a design pass with the five consuming
services' retry behaviour in front of us.

**Flip condition:** the first time a caller is observed reusing a business id for a
different movement, or when the account-level comparison can be done without an extra
query on the idempotent path. Either one makes it worth taking properly.

---

## D3 · A database backstop for sum-to-zero and paired locks — DECIDED: NO

**The question as parked:** both invariants are statements about a set of rows inserted
together, so a `CHECK` cannot see them; backstopping either needs a trigger.

**What I checked.** A `CONSTRAINT TRIGGER ... DEFERRABLE INITIALLY DEFERRED` on
`ledger_entries` would fire once at COMMIT and can see the whole transaction, so it is
technically the right instrument. And posts already serialise behind the chain-tip lock,
so one extra aggregate per transaction is a smaller marginal cost than it first appears.

So it is affordable. It is still the wrong call today, for three reasons.

**1 · This one is already detected.** `runReconciliation` re-derives both invariants from
the journal, and its stated response to a mismatch is to freeze the platform and page an
operator — doctrine §4.2 invariant 5. That is materially different from every gap this
audit _did_ close: unpurposed collateral (#1058), an unregistered asset (#1044), a
placeholder key (#1067) and a cross-asset entry (#1082) were all invisible to every read
of the book. This one is not invisible; it is late.

**2 · The threat model is narrower than it looks.** Doctrine §4.2 invariant 3 — "No raw
SQL from other services, ever" — plus per-service Postgres roles means the writer is
`postgres-ledger.ts` and a human at a `psql` prompt. A human running manual SQL against
the journal is already outside every guard, and a trigger is not the control for that.

**3 · A trigger on the posting path is a change in kind, not degree.** Everything else on
this spine is declarative — CHECKs and foreign keys a reader can see in one place.
Procedural code that runs inside every commit is the first of its kind here, and the
failure mode of a buggy one is _the platform cannot post at all_. That deserves a
deliberate decision with someone reading it, not the twelfth unit of an unattended
session.

**The decision: no trigger. Reconciliation is the sanctioned backstop, by doctrine.**
Recorded as decided rather than parked, so the next audit does not re-derive the same
analysis.

**Flip condition:** a reconciliation run that actually catches an unbalanced transaction
in production, or the arrival of a second legitimate writer to these tables (the
vendored-product adapter the 2026-08-02 ADR describes). Either makes "late detection"
insufficient.

---

## D4 · The `svc-trade` claim gate contradiction — DECIDED: not an ownership change

**The question as parked:** `claim-check` reports `services/svc-trade` human-claimed by
three owners with _"an agent must NOT implement here"_, and #1031, #1034, #1047 and
#1062 all landed in it.

**What I checked.** `claim-check`'s own output names the documented unlock: _"the owner
commenting `agents free on <path>`, or a PR moving the `owner` field in
tooling/tracker/features.mjs and the ownership docs."_ And `CLAUDE.md` rule 5 puts
mountain ownership in `features.mjs` with the ownership docs — Nitro executes, Denon
directs.

**The decision: the gate was not violated, and no ownership moves.**

Nitro authorised the funding residual in writing, in the AFK LOCK v6 mandate: _"for THIS
mandate you MAY implement the named funding idempotency fix in §G1 below (Nitro
authorizes path for that residual only)."_ A direct written instruction from the repo
owner is a **stronger** authority than a PR comment, not a weaker one. What is missing is
not permission — it is a **record** of the permission in the place the gate looks.

So the contradiction is a bookkeeping gap, and the honest fix is to record it, which is
what this file does. I am deliberately **not** editing `features.mjs`: three named
owners' mountains sit on that path, one of them Shehzad's, and an agent reassigning them
to make its own commits look compliant is exactly the failure the gate exists to
prevent. It would also be deciding Nitro's ownership for him, which the mandate to make
decisions does not extend to — the instruction was to stop handing back _engineering_
judgements.

**The record, for the next agent that runs `claim-check` and sees a contradiction:**
#1031, #1034, #1047 and #1062 landed under Nitro's direct written authorisation for the
futures funding residual specifically. Nothing else in `services/svc-trade` was taken by
this lane, and further findings there were written up and left.

**Flip condition / the one action that closes it cleanly:** Nitro (or Denon) comments
`agents free on services/svc-trade/src/futures` on any open PR, which is the mechanism
`claim-check` already reads. Until then the correct agent behaviour on that path is
unchanged: report, do not implement.

---

## What is left on the spine

Nothing pending a ruling. Every finding from
`AFK-RESIDUAL-STOP-2026-08-08.md` §4.2b and from the two 2026-08-08 audit files is now
either fixed on tip or decided above with a flip condition.

The one open engineering item is not a decision, it is work: the two audit files' "could
not break" sections should be re-run by the next session against the tip that includes
0008, 0009 and 0010, because three new constraints change what is reachable.
