# packages/auth — promise audit 2026-08-08

Tip: `ea6e202a`

Imported by every service, so a finding here is a finding everywhere. 17
promises checked. The scope tables are genuinely tight and survived every
escalation attempt; the one real break was in token verification.

## Promises checked (17)

VERIFIED (14): all seven `AuthErrorCode` values are actually emitted — nothing
declared and dead, which is worth stating because that bug class has shipped
here twice. Each refusal keeps its own code end to end, asserted in tests and
consumed downstream by `svc-edge` and `svc-trade`. Expiry is checked **after**
signature verification. The expiry boundary is fail-closed — `exp <= now` with
zero tolerance, executed at the boundary, no off-by-one second. Refresh tokens
rotate on every use, and reuse detection burns every session (implemented
cross-boundary in `svc-identity`, with a genuinely non-obvious and correct
comment about committing the revocation outside the transaction). Only the hash
of a refresh token is stored — 48 bytes of CSPRNG, sha256. No scope implies an
admin- or treasury-class scope. No interactive-only scope is reachable by
implication. Interactive-only scopes never reach an API key even from a session
that holds them. Unknown scope strings are refused rather than skipped. A weak
signing secret is refused (unreachable in deployment — `config`'s env schema
already requires 32 chars).

BROKEN (1) · WEAK (2): below.

## Broken, fixed here

**An access token with no `exp` verified, and verified forever.** jose validates
the claim only when present; `verifyAccessToken` passed no `requiredClaims` and
`accessClaimsSchema` does not list `exp`. The next line was the tell —
`expiresAt: new Date((payload.exp ?? 0) * 1000)` manufactured a 1970 expiry for
a token it had just accepted.

It mattered unevenly, and the uneven part is why it is worth the fix: a token
arriving through the edge is re-checked against `expiresAt` in
`packages/contracts/src/edge.ts`, so an absent expiry failed closed there. The
two callers that use `verifyAccessToken` **directly** do not re-check —
`svc-ledger`'s operator HTTP (freeze, unfreeze, reconcile) and `svc-edge`'s
admin API (kill-switch, treasury). The two highest-value doors are the two with
no second check. → **PR #1078**

Honest severity: reaching it needs a token signed with `JWT_ACCESS_SECRET` but
not minted by `issueAccessToken`. Not a remote unauthenticated hole — defence in
depth where depth is the point.

## Broken, parked — and why

**A detected token theft does not stop an already-issued access token.**
Refresh-reuse detection revokes every session, and the docstring is emphatic:
_"Losing a login is a far better outcome than an undetected account takeover."_
But `verifyAccessToken` is fully stateless — no session lookup, no denylist. The
`sid` claim is present, required, and **read by nothing that authorises**; `jti`
is set with a fresh UUID and consumed by nothing in the entire repo. A `jti`
exists for exactly two purposes, replay detection and revocation, and neither
exists — it is a promise-shaped artifact that makes the token _look_
replay-protected.

So a thief keeps full authority — scopes, tier, `mfa: true` — for the remainder
of the TTL after the platform has concluded the account is compromised. 900
seconds by default, 3600 permitted.

**Parked because it is a policy call with three options at different costs, not
a patch:**

1. Accept it and say so in the docstring — at which point `sid` and `jti` are
   honest to delete rather than leave looking protective.
2. Shorten the window — drop the default TTL and narrow the permitted maximum.
3. Build a `sid` denylist checked in `verifyAccessToken` — which costs the
   stateless-authorisation property this package's opening docstring is built
   on.

A middle path worth considering: check the denylist **only** on the two
direct-verify treasury surfaces, where the round trip is affordable and the
blast radius is the whole platform. That is a design decision with a real
trade-off and it belongs to whoever owns §9.

## Latent — safe today, will break on the next edit

- **`expandScopes` is single-hop.** It adds `IMPLIED[s]` and never expands what
  it added. The author already hit this: `support:ops` hand-lists both
  `support:read` and `support:write` because the chain would not have resolved.
  The failure direction is under-granting, so it is safe — but the docstring's
  word "everything" is not literally true, and the next two-level chain will
  silently under-grant.
- **Implication is handled three different ways for the same question.**
  `requireScope` tests the _required_ scope against the interactive-only set;
  `assertKeyScopesAllowed` tests the _raw requested list_; `assertDelegatableScopes`
  uses the expanded list for the held-check and the raw list for the
  forbidden-check. Safe only because no interactive-only scope is currently
  implied by anything. **This is precisely the "two parsers, two answers" shape
  that produced the kill-switch bypass in #1071** — worth consolidating before
  it costs the same way.
- **The compiler guarantee at `scopes.ts:196` is half true.** The `Record<Exclude<…>>`
  does force every non-session scope to carry a written reason, but
  `SESSION_SCOPE_LIST` has no type annotation, so nothing constrains a session
  scope to be a real scope. A typo would be caught indirectly, by accident
  rather than by the annotation the comment credits. `satisfies readonly Scope[]`
  makes it real — one word.
- **`JWT_ACCESS_SECRET` rotation has no overlap window.** One secret, no key
  set, `kid` means the API-key id and not a signing key. A rotation invalidates
  every outstanding access token at once. Self-healing within one refresh cycle,
  so low severity — recorded for completeness, not as an alarm.

## Declared and never emitted

**None.** All seven codes are emitted, verified line by line. Stated as a
positive result because this is the bug class that has shipped here twice.

## Executed by nothing

- **`hasAllScopes`** and **`requireAllScopes`** — exported, no caller anywhere,
  no test. `requireAllScopes` loops `requireScope` so it inherits the MFA check
  correctly; they are dead, not wrong. Dead exported auth helpers get picked up
  by a future caller who assumes they were exercised.
- **`token.malformed`** — emitted in source and mapped downstream, but no test
  produces it. Reaching it needs a validly-signed token whose payload fails the
  schema, i.e. a version-skew path.

## Could NOT break, having tried

**Scope escalation via implication** — enumerated every value in `IMPLIED` and
cross-referenced against the interactive-only set and every `admin:*`. Nothing
weaker reaches `admin:read`, `admin:write`, `admin:treasury`,
`admin:compliance`, `trade:withdraw`, `bank:card` or `pay:payout`. Every scope
implied by a session scope is itself a session scope, so the withheld table
reads true.

**Delegation escalation** — tried minting an API key carrying `admin:compliance`
from a normal session, the exact hole the docstring says existed once. Refused
on the held-check.

**MFA bypass on withdrawal** — `requireScope` checks the interactive-only set
against the _required_ scope after the grant check, and there is no path to
`trade:withdraw` by implication, so the check cannot be routed around.

**The expiry boundary** — executed directly: `exp === now` is rejected,
`exp === now + 1` accepted. No one-second window.

**Bearer header parsing** — one regex, on a trimmed header, `.` excludes
newlines so no header-injection smuggling. Both direct consumers route through
the same helper: one parser, one answer.

**Note on constant-time comparison:** nothing in `packages/auth` compares a
secret. The one place it happens is `packages/contracts/src/edge.ts`, and it is
done correctly — length check first (because `timingSafeEqual` throws on
mismatch), hex-charset check (because `Buffer.from('zz','hex')` yields an empty
buffer and two empties compare equal), then the constant-time compare.

**Method note:** every negative above was re-run with a positive control. The
`sid`-is-read-by-nothing claim, for instance, was checked against a pattern
(`principal.tier`) known to match, so a silently-broken grep could not pass as a
clean result.
