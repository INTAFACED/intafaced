# ADR: who may be named in a refusal

**Status:** **Accepted — 2026-08-04.** Owner decision, stated and confirmed.
**Decision owner:** repo owner. **Written by:** Denon.
**Spec id:** none — this is **not** D-S-11. That slot is already satisfied by `SPEC-SUBACCOUNTS-2026-08-02.md` (removed), which decided sub-account ownership, the cross-leak ban and trade ownership gates. This ADR is adjacent and narrower: the subaccounts spec governs value crossing between **partitions of one identity**; this one governs what a service may **say** to a caller about **another identity's** objects. Both are needed and neither replaces the other.
**Occasioned by:** a live defect in `svc-bank`, described below.

---

## The decision

> **A refusal may only describe objects the caller was already entitled to see. Where it cannot, it says `NOT_FOUND` and names nothing.**
>
> And: **an authorisation check on one side of a two-sided operation is not an authorisation check.**

This is settled. Agents and engineers implement it; they do not re-litigate it.

---

## The defect that made this necessary

`svc-bank`'s `transfers.create` takes `fromSpaceId` and `toSpaceId`. It checks one of them ([`router.ts:214-235`](../../services/svc-bank/src/router.ts)):

```ts
const from = await bank.spaces.get(input.fromSpaceId);
assertSelf(ctx.principal.userId, from.userId); // only the FROM side
```

The destination is never checked, and it does not need to be for **safety** — the debit side is owner-checked, so this is **not theft**, and cross-user transfer is deliberate: `bank-service.test.ts:308` pins that a transfer "moves value between two different users spaces". That behaviour stays.

The leak is in what happens next. `space-service.ts:198,210` throws with the space's own name:

```ts
throw new BankError(`Space "${space.name}" is archived`, 'bank.space_archived');
```

and the error mapper's `default:` branch returns `err.message` verbatim to the caller ([`router.ts:35`](../../services/svc-bank/src/router.ts)).

So by transferring a trivial amount into a guessed `toSpaceId`, a caller learns whether that space exists, its **user-chosen name**, and its asset — for a space belonging to someone else. The transfer need not even succeed. An existence-and-name oracle over other users' accounts, reachable by anyone with `bank:write`.

**It leaks because a message written for the owner is delivered to a stranger.** Every part of it is correct in the context it was authored in.

---

## The rule

A response may name an object only if the caller could already have read it.

| Caller's relationship to the object | Refusal may say                                                                                                   |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Owns it                             | Everything. Name it, state the precondition, help.                                                                |
| Holds an admin scope covering it    | Everything, and the read is audited.                                                                              |
| Neither                             | **`NOT_FOUND`, and nothing else.** No name, no asset, no status, no distinction between "absent" and "not yours". |

The third row is the whole ADR. **"Exists but you may not touch it" and "does not exist" must be indistinguishable to a caller who is entitled to neither.** A `FORBIDDEN` where a stranger should see `NOT_FOUND` is itself the disclosure — it confirms the id.

### Corollary: check both sides, or state why one is exempt

Any operation naming two objects authorises against both, or carries a written reason at the call site for why one side needs no check. `transfers.create` has a genuine reason — cross-user transfer is the product — and that reason belongs in the code as a sentence, not as an absence.

### Corollary: a message is a wire format

An error string that interpolates a value crosses a trust boundary the moment a mapper passes it through. `err.message` reaching a client is a **serialisation decision**, not a debugging convenience. Domain errors carry structured fields; the mapper decides what a caller may see.

---

## The tension this ADR resolves

The honesty doctrine says empty must look empty and unavailable must be stated. That is about **the caller's own data**, and it is not weakened here.

Where they meet — a caller asking about something that is not theirs — **the honest answer is that they have no such object**. It is not a lie: relative to that caller, no such space exists in any sense they are entitled to. Vagueness toward a stranger is not dishonesty; it is the absence of a claim.

The failure mode to avoid is the opposite one: a service so cautious that it returns `NOT_FOUND` to the **owner** and leaves them unable to act. Owners get the full message, including the name and the precondition that failed.

---

## Applying it to the found defect

1. `transfers.create` resolves the destination and, when it is not the caller's, refuses with `NOT_FOUND` naming nothing. The cross-user transfer product behaviour is unchanged — what changes is that a **failed** transfer to a stranger's space stops describing it.
2. `bank.space_archived` and its sibling messages keep the name for the owner and drop it for everyone else.
3. The mapper's `default:` stops returning `err.message` verbatim. Unmapped errors get a generic message; the detail goes to the log with a correlation id.
4. `assertSelf`'s one-sidedness gets a comment stating the reason, so the next reader does not have to decide whether it is intentional.

---

## Done bar

1. No refusal names an object the caller could not have read.
2. Absent and not-yours are indistinguishable to an unentitled caller — proven by a test that asserts the two responses are **byte-identical**, not merely both errors.
3. No mapper returns a raw domain message to a client by default.
4. Every two-sided operation checks both sides or states why not, at the call site.
5. Owners still receive the specific, actionable message. A test pins that too.
6. Timing and status codes do not reintroduce the oracle — same code, same shape, both paths.

---

## What agents may implement without asking again

- Applying the table above to any service surface, with tests.
- Replacing verbatim `err.message` passthrough with structured mapping.
- Adding the missing side-checks and their written reasons.

## What still needs the owner

- Any change to who may see what — the table itself.
- Whether an admin scope's read is audited, and where that audit lives.
- Removing cross-user transfer, which is product, not security.
