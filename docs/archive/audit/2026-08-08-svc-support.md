# services/svc-support — promise audit 2026-08-08

Tip: `32efec96`

The README carries one promise, so the promises live in the code. 18 checked.

## Scope correction, recorded because the brief was wrong

**PR #1026 is not in this service.** It landed entirely in
`services/svc-agents/src/support-agent/`. And its tools **query nothing** — the
ticket row and account projection are fields in the caller's own request body.
The self-only guarantee holds, vacuously: there is no id to guess because there
is no lookup. `svc-support` itself is an in-memory `Map` with no database, so
none of its guards have a backstop; when Postgres arrives they must all be
re-derived.

That matters for whoever wires a real repository read behind it: the ownership
check as written is a **post-fetch filter**, which is the shape that leaks.

## Promises checked (18)

VERIFIED (14): the requester is the principal and never an input field; the
account projection has no balance field to leak (a test asserts the exact key
set); money tools refuse by name before any other work, all nine tested;
granting the identity module did not open the identity module; refusals leave
audit rows; no ledger dependency; no events published; the exclusive claim is
atomic — there is no `await` between the read and the write; only open/pending
are queued; KB keys are i18n catalog ids and all ten exist in the catalog; the
README's 11-procedure scope table matches the router.

Self-only across all 11 procedures: `create` writes the principal's own id;
`listMine` filters on the principal; `get` is owner-or-ops; `comment` and
`listComments` route through `getTicket` and inherit the check; `listAll`,
`setStatus`, `listQueue`, `next` and `claim` are ops-only and three are
re-guarded inside the handler; `listKb` carries no user data. No admin route, no
export, no analytics read, no service-to-service path exists.

## Broken, fixed here

**A foreign ticket was distinguishable from a missing one.** Answering a foreign
ticket with `not_found` rather than a forbidden only works if the two are
identical. They were not — the missing case interpolated the id, the foreign
case did not, and `mapError` puts `err.message` on the wire. A caller could ask
about any id and read its existence off whether the id came back. **→ #1072**

Severity low and not inflated: UUIDv4 entropy makes enumeration impractical. It
is on the list because the code visibly tried to be indistinguishable and was
not.

**The operator bypass was executed by nothing.** `asOperator` is the flag that
decides whether a caller may read another user's ticket, and the router handlers
that compute it are invoked by no test — the `get` and `comment` stubs are bare
`vi.fn()`, and `listComments` is only called anonymously, so middleware rejects
it before the handler body runs. Covered now, including that a falsy
`asOperator` is not a bypass and that the bypass skips ownership, not existence.
**→ #1072**

## Broken, parked

**Four of ten service methods emit no span** while `tracing.ts` claims §14 DoD
coverage of ticket ops. `getTicket`, `comment`, `listComments` and `setStatus` —
the three operator-visible actions plus the read — are invisible in tracing.
**Parked:** a separate promise from the one this PR fixes, and worth its own
pass rather than being smuggled into a security fix.

**Two operators calling `next` concurrently are handed the same ticket.**
`assignNext` takes `excludeTicketIds` and `peekNext` never passes it.
**Parked:** `claim` is atomic and refuses the second operator, so the race
resolves safely — whether `next` should pre-exclude is a product call about
operator experience, not a correctness bug.

## Declared and never emitted

- **`support.claim.invalid_operator`** — declared, given its own
  `PRECONDITION_FAILED` mapping, and emitted only when `operatorId` is blank.
  The sole production call site passes `ctx.principal.userId`, a validated UUID.
  Unreachable through every route, asserted by no test. Same shape as the
  refusal code closed in #1035.
- **`SupportSpanAttributes.ticketId`** — no call site ever passes it.

## Executed by nothing

`requireSupportWrite` — exported, zero callers repo-wide, zero tests; a dead
guard, since `scopedProcedure('support:write')` does the work. `searchKb` and
`getKbById` — only callers are their own tests; the agent's KB tool reads caller
fixtures instead, so the service's own KB search is unwired. `CATEGORY_WEIGHT`
is exported with an invitation to retune and nothing outside the file reads it.
The vendor-name scan runs only against the five hardcoded articles and guards an
ingestion path that does not exist.

## Could NOT break, having tried

Principal forgery — HMAC-SHA256 over raw bytes with the region bound in,
constant-time compare behind a length guard, and a boot refusal on a secret
under 32 chars. Empty, null, array-typed and non-UUID `userId` all fail closed.
A scope-expansion mismatch between the router's raw `.includes` and
`requireScope` — nothing in the repo implies `support:ops`, so the two are
equivalent. Reaching ticket or account data through any non-self route. A claim
race between read and write. Whitespace confusion on the ownership compare
(asymmetric, but fails closed). Prototype pollution against the ticket and
account fixtures — they are `z.object`, not `z.record`.

**Out of lane, surfaced for whoever owns `svc-agents`:** the refuse-closed tier
gate at `support-agent/tier-gate.ts:56` does an unguarded index into a
caller-supplied `z.record` — `matrix["constructor"]` resolves through
`Object.prototype`, so the `tier_not_granted` refusal never fires and the gate
returns ok. Blast radius today is a 500 rather than a grant, because no
prototype property is an array. The gate is also fed a caller-supplied matrix,
so it protects nothing at the route yet.
