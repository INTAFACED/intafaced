# ADR: Money sent to another person needs a fresh passkey or authenticator approval bound to that exact payment

- **Status:** accepted (phased).
  - Phase 1 (this PR): same-person approvals in svc-identity, and svc-bank enforcement behind `BANK_STEP_UP_MONEY_OUT` (`off` | `required`, default `off`).
  - Phase 2: the customer-app step-up sheet, in the same release train. The flag flips to `required` when it ships.
  - Phase 3: par-asset low-value and trusted-payee lanes, with a 24 h delay.
  - Separate PR, chat 2 3: identity factor-gate hardening. After 2 3 exposes `enrolledAt`, bank adds the refusal for factors younger than 24 h.
- **Date:** 2026-10-14
- **Deciders:** agents (Opus), reviewed by chat 2 2 and a fresh refutation pass. Nitro owns the flag flip.
- **Area / owner:** svc-bank money-out doors and svc-identity action approvals (money-core, chat 2 2). Closes the bank half of GitHub #4707.
- **Reversibility:** two-way (see below).

## Context and problem

How step-up works today (origin/main `f511beff2`):

- `auth.stepUpOptions` / `auth.stepUp` accept one TOTP code, one recovery code or one WebAuthn assertion. They mint an access token with the normal session scopes plus `trade:withdraw`, `mfa: true`, and a lifetime of at most 300 s.
- **That token is a plain bearer.** For five minutes it authorises any number of `trade:withdraw` calls for any amount or destination. It carries no amount, no payee and no single-use marker. Injected script (XSS) or malware can wait for the user's tap and then spend the token on its own transfer.
- Since #4655 only `ramps.setWithdrawDestination` and `ramps.offramp` require `trade:withdraw`. A new off-ramp destination also waits out `BANK_OFFRAMP_COOLING_HOURS`, which has no default.

These svc-bank doors still run on plain `bank:write`, so any session or leaked token can use them:

- `transfers.toUser`, `transfers.create` (when the destination space belongs to someone else), `transfers.scheduleToUser`, `transfers.schedule` (same condition). Paying somebody else is the product, so these cannot simply be locked.
- `business.proposeTransfer` (below the account's threshold it posts at once), `business.approve`, `business.runPayroll`, `business.addMember` (a stolen admin session can add an accomplice as checker). `business.proposeTransfer` debits only the maker's own space, so gating `addMember` is defence in depth.
- `cards.setStatus` to `active` (unfreeze) and `cards.issue` (sets the per-authorisation limit).

Two doors in svc-pay are the same class of gap and are **outside this PR** (see Scope below): `pay.merchant.setPayoutDestination` (`router.ts:343`) and `withdrawals.create` (`router.ts:1531`).

There is no payee table. Standing-order amounts and payees are immutable after insert and run from `runDueTransfers` with no user session.

## Decision drivers

- **Stolen session or token (XSS, infostealer, shared device).** The most likely attack. Any fresh second factor stops it.
- **Malware or real-time phishing that rides a genuine tap.** Only binding the approval to the exact payment, plus single use, limits what one tap can buy.
- **Social engineering** (the user is persuaded to pay a scammer). Step-up does not stop it.
- **Insider.** Operator money doors are already on `admin:treasury` plus dual control. Out of scope.
- **Friction.** Peer-to-peer and repeat payments are the core habit.
- **Fail closed.** A missing or unreadable approval must mean no payment.
- **No new bearer.** A token that unlocks money-out in general is the thing being removed, not refined.

## Considered options

1. **Bound approval on every send to another person (chosen for phase 1).** A same-person approval, created with a fresh passkey or TOTP, bound to the exact payload, single use, five minutes.
2. **Exemption lanes (trusted payees, low value) from day one.** Closer to the PSD2 RTS exemption set, but needs a trusted-payee table, a velocity log and a trustworthy valuation. Deferred to phase 3.
3. **Risk-scored / adaptive.** Needs fraud data, device signals and monitoring that do not exist. Rejected for now.
4. **Cooling-off for new payees.** Fits external irreversible exits, where the off-ramp destination already has it. A 24 h wait to pay a friend for the first time would kill internal peer-to-peer.
5. **A new bound `trade:withdraw` JWT** (claims `txh` and `jti`). Rejected by the refutation pass: svc-bank `setWithdrawDestination` / `offramp` and svc-pay `withdrawals.create` would still accept it without the binding, and a stolen bound token is still a general money-out token.

Option 1 is the originally fail-closed mode "always step up". It is not a stepping stone to be embarrassed by: it adds security over a lane-based design, because the lanes also let a stolen session reach payees it already trusts.

## Decision outcome

**Reuse svc-identity's existing action approval (single use, payload-hash bound, compare-and-swap consume, HMAC service-to-service consume) with a same-person variant. No token is minted.**

### svc-identity

- New door `actionApproval.createSamePerson` (signed-in session). In one request the user proves a fresh factor: a **six-digit TOTP code** or a **WebAuthn assertion** (challenge from `auth.stepUpOptions`). It calls the same verification as `auth.stepUp`, with the same attempt lockout and single-use passkey challenge, and discards the token it mints. **Recovery codes are excluded.** API keys and sub-accounts are refused. A session alone is not enough.
- The row is born `APPROVED` with `kind = 'same_person'`, approver = requester, bound to the user id and the session id, `targetService = svc-bank`, TTL 300 s (fixed, not env). Its `operationId` is its `approvalId`, so the client only holds one id.
- Only action types in `SAME_PERSON_ACTION_TYPES` (`bank.step_up.<door>`) can be created this way, and four-eyes `propose` refuses them. The four-eyes behaviour for every other type is unchanged: the requester still cannot approve their own action (`action_approval.same_person`), and the database check "approver is not requester" still holds for every `four_eyes` row.
- Consume takes the consumer's `principalUserId` and `principalSessionId`. A `same_person` row is consumed only when both match, inside the compare-and-swap. A four-eyes row is never consumed with them. Migration `identity/0029_action_approval_same_person`.
- **Same change, #4724 (identity half):** propose, approve and reject of an _operator_ action type (`matching.open`, `edge.kill`, `ledger.freeze`, `bank.fund_pool` and every other type) now require an operator principal (founder, an `admin:*`, `market:ops` or `support:ops` scope; never an API key). The audience registry (`auth/action-approval-audience.ts`) lists only the same-person types as `self`; **everything else is `operator`**, so a new or unknown type is protected by default. Before this, any two self-registered users with a TOTP could propose and approve `matching.open`.

### svc-bank

- With `BANK_STEP_UP_MONEY_OUT=required`, these doors take `stepUpApprovalId`:
  - `transfers.toUser`, `transfers.scheduleToUser` (unless `toUserId` is the caller),
  - `transfers.create`, `transfers.schedule` (unless the destination space is confirmed to be the caller's own; an unknown id counts as foreign, so the door cannot be used to probe which ids exist),
  - `business.runPayroll`, `business.proposeTransfer`, `business.approve`, `business.addMember`,
  - `cards.setStatus` to `active` on a card that is not active, and `cards.issue`.
- **Never needs it:** moves between the user's own spaces, and protective actions (freeze, close, cancel, pause, resume, reject, remove).
- Bank **recomputes the payload hash from its own validated input** (`bankActionPayloadHash(actionType, fields)`: sha256 of JSON `{actionType, fields}` with keys sorted). The fields are action, actor, from space, payee (user id or space id), the from space's asset, amount as sent (decimal string), cadence and dates for schedules, every payroll line (sorted), and the idempotency id (`transferId`, `scheduleId`, `payrollId`, `clientId`, `cardId`). The exact field sets are in `step-up/money-out-fields.ts` and pinned in tests.
- It then consumes the approval at identity and records `(approval, transferId)` in `bank.step_up_uses` (migration `bank/0033_step_up_uses`). The same approval with the same id replays idempotently (identity is not asked again, within the original five minutes). A different id is a mismatch. State flips (unfreeze) never replay.
- **Fails closed:** identity unreachable or unwired, an unreadable answer, a missing, spent, expired, foreign, wrong-session or mismatched approval all refuse and post nothing. Codes: `bank.step_up_required`, `bank.step_up_mismatch`, `bank.step_up_used` (412) and `bank.step_up_unavailable` (503).
- `ramps.setWithdrawDestination` and `ramps.offramp` are untouched: they keep requiring `trade:withdraw` and never look at an approval. A `trade:withdraw` token is not accepted instead of an approval on the new doors. Both are tested.
- The flag defaults to `off`, which leaves every door exactly as it was (no extra lookups either). Any value other than `off` or `required`, including a blank, refuses boot.

### Scope notes

- **#4707:** svc-pay `withdrawals.create` and `pay.merchant.setPayoutDestination` remain on plain scopes. They are a follow-up, not part of this PR (svc-pay is not changed here).
- No low-value lane and no trusted-payee lane in phase 1. Business `approve` binds the business approval id and the actor, not its amount, because bank has no single-approval read; the maker's amount is fixed by that id.
- An API-key principal cannot obtain an approval, so with the flag `required` an API key that sends to other users is refused. That is intended (a leaked key must not move money out), but integrations that rely on it must be found before the flip.

## Evidence

Only claims that survived the refutation pass are used.

| Source                                                                                                                                                                                                                                            | What it supports                                                                                                                                                                                  | Confidence                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| OWASP ASVS 5.0, 7.5.3 (L3): "requires further authentication with at least one factor or secondary verification before performing highly sensitive transactions" (https://github.com/OWASP/ASVS/blob/v5.0.0/5.0/en/0x16-V7-Session-Management.md) | Fresh factor before a sensitive transaction, not just a session.                                                                                                                                  | high                                                                             |
| OWASP ASVS 5.0, 7.5.1 (L2) (same file)                                                                                                                                                                                                            | Re-authentication before changes to MFA configuration. This is about factor changes, not transactions, and is why the factor-gate hardening is load-bearing.                                      | high                                                                             |
| NIST SP 800-63B-4, session management (https://pages.nist.gov/800-63-4/sp800-63b/session/)                                                                                                                                                        | "A session SHALL NOT be considered at a higher AAL than the authentication event"; the session secret is tied to an authentication event. A session alone does not carry a second factor forward. | high                                                                             |
| EBA Q&A 2018_4040 and 2018_4338                                                                                                                                                                                                                   | Cited as read in the refutation pass. This ADR relies on no specific wording from them.                                                                                                           | not re-read for this ADR                                                         |
| Starling mobile security page (https://www.starlingbank.com/mobile-banking-security/)                                                                                                                                                             | Asks for a "personal password" "to set up payees and authorise payments". An example of a bank requiring a credential for payee setup and payment.                                                | medium (fetch summary)                                                           |
| W3C Secure Payment Confirmation (Candidate Recommendation Draft, 13 Oct 2026)                                                                                                                                                                     | A browser-mediated confirmation that shows the payee and amount to the user. Browser support is unverified.                                                                                       | spec read, support unverified                                                    |
| PSD2 RTS (EU) 2018/389: Art. 5 dynamic linking, Art. 13 trusted beneficiaries, Art. 14/15 recurring and own-account, Art. 16 low value                                                                                                            | The structure the phase-3 lanes would follow.                                                                                                                                                     | **secondary sources only (EUR-Lex not retrievable)**; wording is not quoted here |

Whether PSD2 legally applies to INTAFACED depends on licensing, which is not decided here. It is a benchmark, not a requirement claimed.

Competitor behaviour (Monzo, Wise, N26, Revolut, Coinbase, Kraken, Binance, Gemini) was dropped: the pages could not be read in full or were search snippets only. The earlier draft's statement that neobanks do not prompt for repeat payees had no source and is withdrawn.

## What this does and does not buy (honesty points)

- **Binding gives single use and no reuse for a different payload. It does not protect against a compromised page.** A passkey assertion is not computed over the payload: the authenticator shows no amount or payee. Binding the hash to the WebAuthn challenge would be a server-side association exactly as strong as for TOTP. A page that controls the sheet can ask the user to tap for a payment the user did not intend. The hash is only as honest as the screen that shows the payment.
- **The real difference between passkey and TOTP is phishing resistance** (the assertion is scoped to the origin). TOTP replay is already blocked by `totp_last_step`.
- **Not stopped:** social engineering, and a user who approves what a hostile page shows them.
- Optional later hardening: derive the passkey challenge as H(nonce ‖ payloadHash) so the signed assertion covers the payload. Revisit trigger below.

## Consequences

Good:

- A stolen session or token can no longer move money to other people, create standing orders, change business membership or unfreeze or issue a card without a fresh factor.
- One tap buys one operation. It cannot be redirected to another payee or amount, and cannot be reused.
- No new bearer token and no new scope. The existing `trade:withdraw` doors are unchanged.
- The same PR stops two ordinary users approving each other's operator actions (#4724, identity half).

Bad:

- **Every send to another person costs a tap or a code** once the flag is `required`. TOTP-only users pay more than passkey users. Users with no second factor cannot send to other people; the app must nudge them to enrol.
- The customer app has no step-up client yet. Flipping the flag before the sheet ships makes every peer-to-peer send fail. The flag therefore stays `off` until the sheet is merged.
- One new table in each service (`bank.step_up_uses`, new columns on `identity.action_approvals`).
- Identity becomes a hard dependency of these bank doors when the flag is `required`.

Risks and gaps:

- **Factor-gate hole (identity, chat 2 3, separate PR):** a step-up token must not be able to enrol factors, and a factor added less than 24 h ago must not satisfy money step-up. This is load-bearing: a freshly added attacker factor would otherwise pass this gate. Bank's matching refusal follows once `enrolledAt` is exposed.
- Out-of-band notices (email or push) on sends to new recipients, trust additions and factor additions are the cheapest detection control and are not in this PR.
- A race where two requests spend one approval: the first writer to `bank.step_up_uses` wins; the other is refused as used and can retry. A crash between identity's consume and bank's record burns the approval (safe: the user confirms again).
- Local tooling (`tooling/scripts/local-test-gates.mjs`, `twoPerson`) proposes with plain session tokens; with the new operator gate it needs operator-scoped tokens.

## Reversibility

Two-way. The flag returns every door to today's behaviour instantly. Both migrations have down files (`identity/0029` removes `kind` and `session_id`; `bank/0033` drops `step_up_uses`; neither holds balances). Dropping the operator gate means removing one check in the router. The only sticky part is user expectation once the sheet exists.

## Revisit when

- W3C Secure Payment Confirmation has real browser support, or an out-of-band app confirmation exists: then derive the challenge from the payload hash so the authenticator signs what the user sees.
- Prompt abandonment is high enough to justify the phase-3 lanes. When added: **par assets only** (USDT, USDC, USD; every non-par send steps up, because our own last-price valuation can be wash-traded down; round USD cents up); **trusted payee default off, effective only after a 24 h delay, an out-of-band notice on every trust addition, and none while a factor-change hold is active**; a low-value lane (USD 30 / 100 / 5, converted so as not to exceed the EUR values) as a lifetime lane for users without a factor, with enrol-a-passkey copy. USD 1 000 / 2 500 style caps are judgement; RTS Art. 13 sets no cap. Velocity state needs `pg_advisory_xact_lock(hashtext(user_id))` or a `bank.p2p_risk_state(user_id)` row, reserved before the ledger post, and a decision on whether lane sends count toward the 24 h cap.
- Any confirmed account takeover.
- Real (non-simulated) cards or fiat rails go live.
- A licensing decision puts PSD2, the UK PSR or MAS rules formally in scope.
- At the latest, 2027-04-14.

## Rollout

1. Merge phase 1 with `BANK_STEP_UP_MONEY_OUT=off` (default).
2. Ship the customer-app step-up sheet (phase 2): `auth.stepUpOptions` for a passkey, then `actionApproval.createSamePerson` with the hash of the fields in `money-out-fields.ts`, then the normal door call with `stepUpApprovalId`.
3. Merge chat 2 3's factor-gate hardening and the `enrolledAt` refusal.
4. Flip the flag to `required` in staging, then production. Nitro decides the production flip.
