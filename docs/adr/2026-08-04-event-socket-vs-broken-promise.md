# ADR: an unconsumed event is a socket only when nothing was promised

**Status:** accepted  
**Status note:** **Accepted — 2026-08-04.** Owner decision, stated and confirmed.
**Decision owner:** repo owner. **Written by:** Denon.
**Spec id:** D-S-13.
**Ground truth (as written, 2026-08-04):** `event-wiring` reported **32 declared events: 14 wired end to end, 18 recorded sockets with a written reason.** The gate is good and the reasons in `packages/events/src/catalog.ts` are unusually honest. This ADR does not ask for more discipline — it asks for the eighteen to be **sorted**, because they are not all the same thing.

**Ground truth (current, 2026-08-06):** **32 declared events: 16 wired end to end, 16 recorded sockets — A 15 · B 1 · C 0.** Two of the original eighteen closed for real (`bankMarginCalled`, `xpEarned`); the count then drifted through a false close and back. Where this document says "the eighteen", read "the socket set" — the argument is about the sorting, and it does not depend on the number. **The live number is whatever `pnpm gates` prints; it is not maintained here.** See the second correction below for why that sentence is now in this file.

---

## The decision

> **An unconsumed event is a §13 socket when nothing depends on the consumer existing. It is a defect when a user already believes something the missing consumer would have to be true for.**
>
> The test is not "is there a consumer". It is: **does anyone — user or operator — currently hold a belief that the missing wiring would have to deliver?** If yes, the feature is broken and the socket entry is concealing it.

This is settled. Agents and engineers implement it; they do not re-litigate it.

---

## Why the current record is not enough

Every one of the eighteen carries a written reason, and the reasons are candid to the point of shouting — "PUBLISHED INTO THE VOID", "and NEITHER EXISTS". That is the honesty doctrine working.

But `event-wiring` counts them identically, so the gate's clean line covers both **"the stream is a durable record ahead of its first reader"** and **"a borrower is never told their loan is being margin-called."** Those are not the same fact, and a check that reports them with one number is a check that will let the second one sit forever.

**A written reason proves someone thought about it. It does not prove the answer was yes.**

---

## The three classes

### Class A — record ahead of its reader. A true socket. Fine indefinitely.

The event exists, is durable, and **nothing anywhere claims it does more**. Building the consumer later is additive.

By the catalog's own reasoning, these qualify:

- `ledgerTxPosted` — "THE money event... the stream retains 90 days and carries the hash chain, so an audit or read-model consumer can be built later and replay from the start. **Nothing today derives state from it, and nothing claims to.**" That last clause is the whole test, passed.
- `ledgerFreezeUpdated` — "Freeze state is DURABLE, not a process signal: every replica reads the same row, **which is precisely why nothing has to subscribe to stay correct.**"
- `orderAccepted` — "acceptance moves no money and releases no hold, and svc-trade already knows it submitted the order... **Genuinely nothing to do with it today.**"
- `userCreated` — every module resolves users through `packages/contracts` instead, "so **nothing is missing a fact it needs**".
- `buybackExecuted` — settled through the ledger before publication, "so **no consumer is load-bearing**".
- `ledgerReconciliationFailed` — the freeze is performed in-process; "the event is the external announcement, not the mechanism", and "**the freeze does not depend on that path existing.**"

Each states, in its own words, that no behaviour depends on the gap. That is what a socket looks like.

### Class B — a promise with no delivery. Not a socket. A defect.

Something a user or operator can observe is already premised on the missing consumer. The reason field describes a **bug**, accurately, in the register of a design note.

> **Status, 2026-08-06.** Of the three below, **`bankMarginCalled` and `xpEarned` are CLOSED** — genuinely, with the missing end mounted and running (`services/svc-bank/src/loans/margin-call-publisher.ts`, `subscribeXpEvents` in `services/svc-identity/src/events.ts`). **`crewMemberCreated` is the one remaining Class B**, and it is pinned. It was briefly recorded as closed and was not; see the second correction below. The analysis of all three stays as written — it is the reasoning that dates well, not the status.

- **`bankMarginCalled`** — "svc-bank raises the call durably... **svc-notify's consumer is complete and parks on it at every boot.**" A margin call is raised, a grace clock starts gating liquidation, and the borrower is never told. `risk.ts` argues at length that liquidating without prior notice means "the borrower's first notice of the loan would be its liquidation receipt" — **and that is the current behaviour**, because the notice has no transport. The consumer is finished and waiting. This is not deferred work; it is a broken safety property with the fix already half-built.
- **`xpEarned`** — "**PUBLISHED INTO THE VOID.** svc-p2p and svc-trade both publish... svc-identity subscribes only to blueprintCreated/blueprintDeleted... P2P and trade XP is retained by JetStream and read by nobody. **The idempotency keys are even shaped to match `identity.xp_events.idempotency_key`, a handshake with a consumer that does not exist.**" Users earn XP that never counts. If any surface shows a rank or an XP total, it is wrong for everyone who earned it through P2P or trading.
- **`crewMemberCreated`** — "The description above names two consumers — 'svc-academy routes the lobby, svc-agents opens the crew channel' — and **NEITHER EXISTS.**" The catalog is explicit that it kept the description _as the specification those services owe_ rather than softening it. Correct instinct, wrong register: an owed specification is a work item, not a socket.

### Class C — owned and unbuilt. A socket with a name on it.

The consumer belongs to a service that is claimed, human-locked, or not yet started, and **the gap is disclosed wherever a user could otherwise be misled**. `bankMarginCalled` would be Class C rather than B if the loan surface said "notifications unavailable" — it does not, so it is B.

---

## The rule

**Class A and C may be sockets. Class B may not.**

A Class B entry is a defect and is tracked as one, with the reason field kept verbatim — it is already a better bug report than most. Reclassifying does not require fixing it today; it requires it to stop counting as clean.

### The consequence for the gate

`event-wiring` must report the three classes separately. Its clean line read, when this was written:

```
32 declared event(s): 14 wired end to end, 18 recorded socket(s) with a written reason
```

It now reads (2026-08-06) — one line per class, and the mounted-file basis of the word "wired":

```
32 declared event(s) read against 681 source file(s), 343 of them mounted from 18 service entrypoint(s):
16 wired end to end, 16 recorded socket(s), each with a written reason and a class (A 15 · B 1 · C 0)
```

A socket declaration is a claim that nothing is broken, and **that claim needs to be checkable** — not merely accompanied by prose.

**The pre-existing Class B entries are pinned by a hand-written list, not failed unconditionally.** The gate goes red when a **new** Class B appears, when a pinned entry is silently reclassified or resolved, or when the list is edited without the entry changing. The pinned entries themselves print on every run and do not fail the build.

See the correction below for why. This is the same defect class the repo has closed four times already: a check that reports on something real, in a shape that gets read as evidence for something it never examined.

---

### Correction — 2026-08-04, same day. And it is the second time.

This ADR first said the gate _"must not be able to print a clean line while any Class B entry exists"_, flatly. An agent implemented it faithfully, and the result was `event-wiring` **red on main with no path to green** — because this same ADR puts `crewMemberCreated`'s consumers on the owner. No agent could ever clear it, and it would block every unrelated merge until a human ruled.

**I made the identical mistake in [D-S-14](2026-08-04-token-economics-outcomes.md) the same afternoon**, and the repetition is the useful part. The general rule I should have written both times:

> **A gate that freezes a pre-existing finding pins it by an explicit hand-written list. It does not fail unconditionally.**

This is not a new idea — **it is what this repo already does everywhere**. `fabricated-money-scan` froze 12 findings. `vendor-java-money-scan` froze 63, now 55. `wallet-rpc-mainnet-scan` froze 38. **Not one of them fails on its pre-existing set.** Each pins it and fails on deviation, and that is precisely why they are still in the build rather than disabled.

The reason the ratchet is right and the flat failure is wrong: a red that must be routed around to get any work done is a red that gets deleted, and it takes the honest part with it. The pin achieves the actual requirement — the finding cannot be shipped further, resolved silently, or forgotten — without holding the repo hostage to a decision that is not the gate's to make.

**Two ADRs, one mistake, one afternoon.** Recorded here rather than quietly fixed, because an author who states a rule twice and gets it wrong twice should say so where the rule lives.

---

### Second correction — 2026-08-06. The gate went green on code that never ran.

`crewMemberCreated` was pinned Class B: the catalog said "svc-academy routes the lobby, svc-agents opens the crew channel" and **neither existed**. Commit `e1b95844` added a `crew-events.ts` to each service, each exporting a `subscribeCrewMemberCreated` that calls `bus.subscribe`, and **deleted the socket entry**. The gate detected wiring by scanning source text for a `.subscribe('…')` call. It found two. Class B count went to zero and the build went green, with a PR that reported "event-wiring: Class B count **0**".

**Neither subscriber had ever run.** Nothing imported either file outside its own unit test. `svc-academy/src/index.ts` states in its own header that the service has **no bus connection at all**, so mounting the import would not have been enough either. `svc-agents/src/index.ts` connects to NATS and never calls the function. Both handlers write to a process-local `Map`. Meanwhile `docs/TRACKER.md` never stopped saying the event "has no consumer yet" — **the docs and the runtime agreed the whole time; only the catalog and the gate disagreed.**

For two days the event was **neither wired nor recorded**: invisible to the check built to see it, with the honest entry that preceded it deleted. That is strictly worse than the socket it replaced, and it is this ADR's own sentence coming true inside the gate the ADR asked for — _"a check that reports on something real, in a shape that gets read as evidence for something it never examined."_

Three things are worth separating, because only one of them is about this event:

1. **A textual scan cannot tell a defined handler from a running one.** The gate now decides "wired" by **reachability from the service entrypoint** — derived from each service's own `package.json`, walked transitively, with `import type` excluded because a type-only edge mounts nothing — **and** by whether the reaching service constructs a bus at all. svc-academy fails both conditions, which is why one boolean would not have described it. Sites that do not count print under **DEFINED BUT NEVER MOUNTED** rather than vanishing.
2. **The honest record was deleted to make the gate green.** The gate's own header says "DELETING AN EVENT IS NEVER HOW YOU MAKE THIS PASS", and the pinned-list note says a row is never added to go green — but nothing said the inverse: a row is never _removed_ to go green either. The reason-fingerprint pin caught softening; it could not catch deletion, because a deleted entry has no reason left to fingerprint. The `STALE PIN` check now carries that weight, and it is the check that would have caught this on the day.
3. **A green gate is a claim, and this one was recirculated as evidence.** "Class B count 0" appeared in a PR body as proof of a close. The number was true and the claim was false.

The entry is restored, Class B, pinned, with the reason rewritten to describe **what is actually broken now** — that the handlers exist and do not run — which is a harder finding than the original, not a softer one. Restoring it is not "pinning a defect introduced today": the defect is unchanged and three months old, and the only thing that ever changed was the gate's ability to see it.

**The recurring shape, now five times:** a check that reports on something real, in a shape that reads as evidence for something it never examined. It has never once been caught by reading the gate. It has been caught every time by asking what the gate would do if the thing it measures were faked — which is why the mounted-vs-defined rule ships with a mutation proof in both directions, and why an empty reachability walk exits 1 instead of reporting a clean world.

---

## Non-goals

- **This does not require every event to have a consumer.** Class A is legitimate and permanent. An event bus whose every subject must be consumed is an event bus nobody will declare into.
- **This does not soften any description.** The catalog's choice to keep `crewMemberCreated`'s description as an owed spec is right and stays. Descriptions state what the system is for; sockets state what is not built. Neither is edited to match the other.
- **This does not decide which Class B item is fixed first.** `bankMarginCalled` is the obvious candidate — the consumer is complete, and the missing half is a publish in a service whose ownership is settled.

---

## Done bar

**Amended 2026-08-06** — items 1–3 restated. Item 2 still read _"reports the classes separately and **fails on any Class B**"_, which the Correction below had already replaced with pin-and-ratchet, and which the code has never implemented. A Done bar that contradicts its own Correction is not a leftover: it is a live instruction, and an agent following it faithfully would rebuild the always-red gate the Correction exists to prevent — which is how this ADR got its first correction. Item 3's "zero Class B entries" was the same demand wearing a different sentence. Item 1's "18" is now 16 and will keep moving.

1. Every socket carries an explicit class: A, B or C. (16 sockets as of 2026-08-06; the count is the gate's to report, not this document's to hold.)
2. `event-wiring` reports the classes separately, **prints every Class B in full on every run, and ratchets**: pre-existing Class B is pinned by the hand-written `CLASS_B_AWAITING_A_DECISION` list with a named decider and a written release condition, and does **not** fail the build. A **new** Class B fails, as does a pinned entry that is silently reclassified, resolved, or has its reason reworded. **Not "fails on any Class B"** — see the Correction.
3. Zero **unpinned** Class B entries. Every pinned one is fixed, or reclassified to C with the gap disclosed at every surface a user could read, or names the human who owes the decision and what would clear it.
4. No surface displays a value derived from an event nobody consumes. Specifically: no XP total or rank is shown while `xpEarned` is unconsumed.
5. A new socket declaration must state its class; the gate rejects one that does not.
6. Reclassifying B to C requires the disclosure to exist in code, not in the reason field.
7. **"Wired" means mounted, not defined.** A subscriber the service never reaches from its entrypoint, or that no bus is constructed for, does not close a socket — and deleting the socket entry on the strength of one is the failure recorded in the second correction.

---

## What agents may implement without asking again

- ~~Classifying all 18 entries and extending `event-wiring` to enforce it.~~ **Done.** Every socket carries a class and the gate rejects one that does not.
- ~~The `bankMarginCalled` publisher in `svc-bank`~~ **Done** — `services/svc-bank/src/loans/margin-call-publisher.ts`, mounted from `index.ts`.
- ~~The `svc-identity` `xpEarned` consumer~~ **Done** — `subscribeXpEvents`, called from `services/svc-identity/src/index.ts`.
- Disclosing any Class C gap at the surface.
- Strengthening the gate's own detection — including anything that makes "wired" harder to fake. That is not a product decision and does not wait on the owner.

## What still needs the owner

- Whether XP surfaces are hidden or shown-as-incomplete while `xpEarned` is unconsumed. That is a product call.
- Any new event subject that moves money.
- The `crewMemberCreated` consumers, which belong to services with their own scope questions. **Still open** — and note what does _not_ clear it: a `crew-events.ts` that nothing imports. Closing it means svc-agents calling its subscriber from `index.ts`, and svc-academy either growing the bus connection it deliberately does not have or the owner ruling that the two named consumers are not owed and the description being rewritten to match.
