# svc-identity

**One account, one verification, one rank — the key that opens every room (§4.1).**

Owns accounts, credentials, sessions, KYC state, and the rank graph. It is the **only writer to `rank_state`**; every other module emits XP and reads perks.

**What this service is not:** it does not decide what a rank is _worth_. It publishes a machine-readable perk table and each module applies what it cares about — svc-trade reads `feeDiscountBps`, svc-p2p reads `p2pLimitMultiplier`. That indirection is why the ladder can be re-tuned without touching a second service.

---

## API

| Procedure                                              | Scope                     | Notes                                                                                                                                                                                         |
| ------------------------------------------------------ | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.register`                                        | —                         | Creates user, profile, rank row; awards 50 XP; optional `referrerId`                                                                                                                          |
| `auth.login`                                           | —                         | Handle or email; requires TOTP once enrolled; recovery codes redeem once                                                                                                                      |
| `auth.refresh`                                         | —                         | Rotates the refresh token; reuse revokes **every** session                                                                                                                                    |
| `auth.logout` / `auth.logoutAll`                       | — / session               | Revokes one or all sessions                                                                                                                                                                   |
| `auth.stepUpOptions`                                   | session                   | WebAuthn challenge for withdraw step-up (kind `step-up`, not login)                                                                                                                           |
| `auth.stepUp`                                          | session                   | **TOTP, recovery code, or passkey → 5-minute `trade:withdraw` token**                                                                                                                         |
| `totp.enrol` / `totp.confirm`                          | session                   | Two-step; secret + recovery hashes persist only on confirm                                                                                                                                    |
| `webauthn.registerOptions` / `registerVerify`          | session                   | Enrol a passkey/security key; ES256, attestation `none`                                                                                                                                       |
| `webauthn.authOptions` / `authVerify`                  | —                         | Passwordless login; same session tokens, `mfa: true`                                                                                                                                          |
| `webauthn.list` / `remove`                             | session                   | Ids only; remove retires a lost/stolen authenticator                                                                                                                                          |
| `kyc.submit`                                           | `identity:write`          | Own record only; **grants nothing**; no client `providerRef`                                                                                                                                  |
| `kyc.status`                                           | `identity:read`           | Own records + effective tier; never `providerRef` / `reviewedBy`                                                                                                                              |
| `kyc.pending`                                          | `admin:compliance`        | Operator review queue, oldest first                                                                                                                                                           |
| `kyc.approve` / `kyc.reject`                           | `admin:compliance` + MFA  | **Approval grants custodial access**                                                                                                                                                          |
| `kyc.storeDocument`                                    | `admin:compliance` + MFA  | Encrypted vault put; **meta only** on wire; needs `IDENTITY_KYC_DOC_KEY`                                                                                                                      |
| `kyc.listDocuments`                                    | `admin:compliance`        | Meta list for one subject — **never bytes**                                                                                                                                                   |
| `kyc.bindDocument`                                     | `admin:compliance` + MFA  | Opaque vault id → pending `provider_ref` (same-user only)                                                                                                                                     |
| `rank.get`                                             | `identity:read`           | Rank, XP, XP to next tier                                                                                                                                                                     |
| `rank.perks`                                           | `identity:read`           | **The hot path** — every module calls this                                                                                                                                                    |
| `rank.awardXp`                                         | service                   | Modules award XP here, never by writing `rank_state`                                                                                                                                          |
| `apiKeys.exchange`                                     | public                    | Long-lived key → short JWT; non-empty `domain_whitelist` binds Origin                                                                                                                         |
| `apiKeys.create` / `list` / `revoke`                   | `identity:write` / `read` | Key returned once, never retrievable                                                                                                                                                          |
| `compliance.freezeIdentity`                            | `admin:compliance`        | Freeze user + revoke sessions + sub-accounts + API keys                                                                                                                                       |
| `compliance.unfreezeIdentity`                          | `admin:compliance`        | Thaw user only — does **not** un-revoke keys or books                                                                                                                                         |
| `subAccounts.create` / `list` / `revoke`               | `identity:write` / `read` | Soft-disable only (no balance sweep). Create refuses if `IDENTITY_MAX_SUB_ACCOUNTS` is blank (`auth.sub_account_cap_unset`); owner-explicit 25 is allowed.                                    |
| `subAccounts.assertTransferDoor`                       | `identity:write`          | Ownership-at-the-door for transfer (no default to primary)                                                                                                                                    |
| `createOrg`                                            | `identity:write`          | Named org; creator is admin. No balance.                                                                                                                                                      |
| `addOrgMember`                                         | `identity:write`          | Admin adds trader/auditor/risk-manager. Adding admin needs a second distinct admin (`secondApproverId`). Trader/risk-manager cannot add. Missing org/member/role refuses.                     |
| `grantOrgRole`                                         | `identity:write`          | Admin changes an existing member's role. Granting admin needs a second distinct admin. Self-approval refuses.                                                                                 |
| `assertOrgActor`                                       | `identity:write`          | Actor must belong to the named org. Member of A cannot act as B. Missing/unknown role refuses.                                                                                                |
| `assertOrgPlace`                                       | `identity:write`          | Admin and trader may place. Auditor and risk-manager cannot. Missing role refuses. Does not submit an order.                                                                                  |
| `assertOrgRisk`                                        | `identity:write`          | Admin and risk-manager may see risk. Trader and auditor cannot. Does not compute risk.                                                                                                        |
| `createDmaHierarchyProduct`                            | `identity:write`          | Names DMA broker / desk / shift on an existing org. Unpublished owner hierarchy law refuses (`identity.dma.hierarchy_law_unset`). Never invents a broker tree. Org roles unchanged.           |
| `affiliates.attribute`                                 | `identity:write`          | Referral edge; cycle/self/depth refused                                                                                                                                                       |
| `affiliates.myReferrer` / `myAncestors` / `myAccruals` | `identity:read`           | Self-only tree + durable accruals                                                                                                                                                             |
| `affiliates.freeze` / `unfreeze` / `freezes`           | `admin:write` / `read`    | Freeze ledger honesty (no pay)                                                                                                                                                                |
| `affiliates.treeStatus` / `node` / `members`           | `admin:read`              | Admin tree structure + roster; `treeStatus` adds rate-authority published flag (no rate invent)                                                                                               |
| `affiliates.accrueDryRun` / `accrue`                   | `admin:read` / `write`    | Accrual tree under rate authority (D26-P1-O2); **no ledger**; durable accrue = owner-published tiers only (per-call invent refused); dry-run may simulate; optional `sourceModule` (fee pool) |
| `affiliates.payout`                                    | `admin:write`             | Pays when §8 rates + ledger wired; refuse-closed otherwise; sweeps row `sourceModule` fee pool                                                                                                |
| `waitlist.enroll`                                      | —                         | Drop 0 email capture; optional `referralCode`. Flag off / unwired → named refuse, no silent enroll. **No rewards.**                                                                           |
| `waitlist.position`                                    | —                         | Place in FIFO line + referred count by code. Gated by `referral.queue`.                                                                                                                       |
| `waitlist.list`                                        | `admin:read`              | Operator FIFO list (includes email). Gated by `waitlist.enabled`.                                                                                                                             |

HTTP: `GET /health` · `GET /ready` (reports whether argon2id is active) · S2S sub-account ownership on internal HTTP.

### KYC — what it gates, and what it must never gate

**Zero-KYC follows custody (§22), and that is already code.** `checkAccess` short-circuits to `allowed.permissionless` whenever the plane is `protocol` and the module is `custodial: false`, **before any tier is read** (`packages/config/src/jurisdiction.ts`). Nothing in this service can gate such a surface, and nothing here should ever be made to.

These procedures exist for the **custodial** side only — the modules whose `JURISDICTION_MATRIX` rule carries a `minTier` because the platform holds the asset:

| Surface                                        | KYC?                  | Why                                                              |
| ---------------------------------------------- | --------------------- | ---------------------------------------------------------------- |
| Protocol Plane (`svc-protocol` smart accounts) | **None. Ever.**       | `custodial: false` — there is nothing held, so nothing to verify |
| Custodial spot venue (`svc-trade`)             | `basic`               | Holds user funds in ledger accounts                              |
| Ledger withdrawal (`svc-pay withdrawal.*`)     | `basic`               | Same balance, leaving                                            |
| Deposit (`svc-pay deposit.credit`)             | **None on the payee** | Value already at a rail must always be bookable                  |
| Merchant acquiring, bank, launch               | `full`                | Third-party money, card rails                                    |

**Submit and approve are separate procedures on separate scopes**, and that split is the point: a single "set my tier" would be a procedure whose caller grants themselves access to every custodial module. `kyc.submit` writes a `pending` row and nothing else. Only `admin:compliance` can approve, and the row records **which operator did it** in `reviewed_by` — because approving is granting, and a grant with no name on it is not auditable.

There is **no verification-provider integration** here. Approval is an operator action against `kyc_records`. A provider webhook can land later as one more way to move a record off `pending`, without changing what approval means.

**`provider_ref` is never client-written.** `kyc.submit` accepts only `tier` + `jurisdiction`. A free-text `providerRef` from the user was a PII side-channel into the pointer column (§10: pointer never holds name/DOB/docs). Opaque refs are minted by the encrypted document store (or operator tools) when that store lands; until then the column stays null and `kyc.status` never returns it.

**Encrypted document store (mechanism):** table `identity.kyc_documents` holds AES-256-GCM ciphertext under `IDENTITY_KYC_DOC_KEY`. Opaque ids are what `provider_ref` may point at. No user-facing procedure returns document bytes. Reads are **principal-bound** (`getFor` owner|compliance) — there is no free get-by-id (cross-user PII read is refused as not-found). Operator procedures: `kyc.storeDocument` / `listDocuments` / `bindDocument`. Boot without the key leaves the vault unwired and those procedures refuse closed. Live vendor webhook remains Class X.

**TOTP secret at rest:** `users.totp_secret` is AES-256-GCM sealed (`enc:v1:…`) under `IDENTITY_TOTP_SECRET_KEY` (32-byte base64 or 64-char hex). Enrol refuses without the key; prod boot refuses if missing. Dual-read still accepts legacy unprefixed plaintext until re-enrol.

### Step-up

`defaultScopes()` deliberately withholds `trade:withdraw` — "added only after a step-up challenge". `auth.stepUp` **is** that challenge, and before it existed no session in the OS could reach a withdrawal endpoint at all.

A live session plus a fresh TOTP code, a single-use recovery code, **or** a WebAuthn step-up assertion (after `auth.stepUpOptions`) buys an access token that is weaker than a normal one in three ways, all of which matter: it lasts **five minutes**, it is bound to the session that asked for it, and it is only issued to an account that actually has a second factor. An account with no second factor is refused with `auth.mfa_not_enrolled` — `FORBIDDEN`, not `UNAUTHORIZED`, because retrying with a code cannot help and the client needs to send the user to enrolment instead.

**TOTP anti-replay:** each successful TOTP use (enrol confirm, login, step-up) records the matched counter in `users.totp_last_step`. A second attempt with the same or earlier step is refused as `auth.mfa_invalid`, so a captured code cannot be replayed inside the ±1-step window.

---

## Events

**Publishes**

| Subject                           | When                      |
| --------------------------------- | ------------------------- |
| `intafaced.identity.user.created` | registration              |
| `intafaced.identity.kyc.approved` | verification tier granted |
| `intafaced.identity.rank.updated` | **rank changes only**     |

`rank.updated` fires on rank change, not on every XP award. Every module caches perks; an event per award would be a cache-invalidation storm for no benefit.

**Consumes** — `intafaced.blueprint.blueprint.created` / `.deleted` (the §7.2 profile-pointer cascade), and `intafaced.identity.xp.earned` from every module.

The XP consumer closes a hole rather than adding a feature. svc-p2p and svc-trade have published `xpEarned` since they shipped, both naming svc-identity in their own comments as the way into `rank_state`, and nothing subscribed — so XP earned by trading or by completing a P2P trade was retained by JetStream and read by nobody, and every rank shown to those users was wrong by exactly that much. The producers already shaped their idempotency keys to land in `xp_events.idempotency_key`, so the envelope's key goes through untranslated and `ON CONFLICT (idempotency_key) DO NOTHING` is the durable dedupe. See `src/events.ts`.

Modules may still call `rank.awardXp` directly — it is a `serviceProcedure` on the router. The bus is a fourth caller of the same method, not a second way of writing `rank_state`, and the two key namespaces (`p2p:*` / `trade.order.xp:*` versus `identity.*`) do not collide on the unique index.

---

## Ledger

**This service holds no balances of its own.** Sub-account revoke still soft-disables only — never posts, never sweeps (same rule as bank space archive). `sub_accounts.id` is what the ledger's `subaccount` owner type keys on.

**Affiliate payout is the one ledger write path.** When `LEDGER_URL` is set and the owner has published fee-share tiers (`IDENTITY_AFFILIATE_ACCRUAL_TIERS_JSON` — D26-P0-02 hops 0–2 at 0.10/0.05/0.02 in `.env.example`), `affiliates.payout` posts through existing ledger recipes (`sweepFeesToRewards` → `rewardPay`). No recipe is invented here. Without a ledger client the procedure refuse-closes (`affiliate.payout.ledger_unwired`) and moves nothing. Compose wires `LEDGER_URL: http://svc-ledger:4001` (same pattern as svc-market); the schema stays optional with no localhost default so a host that omits the URL still refuses up front.

**D26-P1-O2 accrual authority:** durable `affiliates.accrue` walks the referral tree only under owner-published law — unset → `affiliate.accrual.rates_unset`; per-call tiers → `affiliate.accrual.invent_refused`. Dry-run may simulate tiers. No second money book.

---

## Security decisions worth knowing

**Passwords — argon2id, scrypt fallback.** §9 specifies argon2id. `@node-rs/argon2` is a native module, and a failed native install must not stop a developer running tests — so scrypt is the fallback. Both are memory-hard; there is no path here that reaches a fast hash. In production `assertArgon2Available()` runs at boot and the process refuses to start without argon2id. A scrypt hash upgrades to argon2id silently on next login, so nobody needs a reset.

> scrypt at N=2¹⁵, r=8 needs exactly Node's 32 MiB default `maxmem` and therefore fails without raising it. Found by a test. Without it, every password hash on a machine lacking argon2 would throw.

**Password policy — length, not composition.** 12 characters minimum, no character-class rules. Composition requirements push people to `Password1!`; NIST dropped them for that reason.

**Login timing.** An unknown account is compared against a _real_ hash of a random string, so it costs the same time as a wrong password. A hand-written fake would return early and leak the difference — that is an account-enumeration oracle.

**TOTP — RFC 6238, implemented here.** ~60 lines of well-specified arithmetic, which lets the tests run the RFC's own published vectors. A dependency in the authentication path we cannot check against the spec is one we would be trusting blind. Constant-time comparison; ±1 step drift window.

**Enrolment is two-step.** The secret is not written to `users.totp_secret` until a valid code proves the user actually scanned it — otherwise abandoning enrolment halfway locks you out. Pending state (secret hash + recovery hashes, 15-minute TTL, single-use take) lives in Postgres (`identity.totp_pending_enrolments`) so multi-pod start/confirm works; the base32 secret is never stored pending.

**WebAuthn — ES256 only, attestation `none`, implemented here.** Same rationale as TOTP: the authentication path is not a place for an opaque dependency. Registration stores `{credentialId, publicKey, counter, transports}` in `users.webauthn_creds`. Assertion verifies the signature, advances the counter (cloned-authenticator detection), and issues a normal session with `mfa: true`. Challenges live in Postgres (`identity.webauthn_challenges`, five-minute TTL, single-use take) so multi-pod ceremonies complete when options were issued on another instance. In-memory `ChallengeStore` remains for pure unit tests without SQL.

Kill-switch: `WEBAUTHN_ENABLED=false`. Relying party: `WEBAUTHN_RP_ID`, `WEBAUTHN_RP_NAME`, `WEBAUTHN_ORIGIN` (comma-separated origins).

**Refresh rotation with reuse detection.** Every refresh issues a new token and revokes the old. If a rotated token is presented again, two parties hold it and we cannot tell which is the owner — so **every session for that user is revoked**. Losing a login beats an undetected takeover.

> The revocation is committed in a _separate_ statement, outside the transaction that detected it. Throwing from inside would roll it back, and the thief's replay would revoke nothing. There is a test for exactly this.

**API keys cannot withdraw.** `trade:withdraw`, `admin:treasury`, `bank:card`, and `pay:payout` are refused on key creation by the service **and** by a database CHECK constraint (`INTERACTIVE_ONLY_SCOPES`). A leaked bot key must not be able to move value off the platform (§9).

**Handles are citext.** `Handle` and `handle` are the same account. Impersonation by casing is a real attack.

---

## Concurrency

`awardXp` takes `FOR UPDATE` on the user's `rank_state` row **before** any write, then runs at READ COMMITTED. Same reasoning as svc-ledger's chain-tip lock: when a lock already establishes the ordering, SERIALIZABLE only adds aborts.

Ordering matters — inserting the XP event first created a read/write conflict that made concurrent awards abort each other. Locking per user is the right granularity: two users earning XP have nothing to do with one another.

---

## Kill-switch

`REGISTRATION_OPEN=false` closes registration; existing users are unaffected. §11 gates this behind the drop sequence (drop IV opens it fully).

---

## Running it

```bash
docker compose up -d
pnpm --filter @intafaced/svc-identity db:migrate
pnpm --filter @intafaced/svc-identity test
pnpm --filter @intafaced/svc-identity dev
```

## Tests

Unit + integration tests. TOTP is verified against **RFC 4226 Appendix D and RFC 6238 Appendix B** vectors. WebAuthn is verified with a soft authenticator (real P-256 keys, real CBOR/authData). The Postgres suite carries the **§4.4 Phase 1 exit criteria**:

- full auth lifecycle — register → TOTP enrol → login with 2FA → refresh → scoped API key call
- WebAuthn enrol → passwordless assertion → MFA session
- XP event → rank recalculation → perks visible to a second service
- a verified user passing the jurisdiction matrix that an unverified one fails

Skips cleanly when Postgres is unreachable.

## Founder identity controls

Apply `drizzle/0025_founder_controls.sql` before enabling controls. Set
`IDENTITY_FOUNDER_NITRO_USER_ID` and `IDENTITY_FOUNDER_PHANTOM_USER_ID` to two distinct
existing active platform user UUIDs with verified TOTP or registered WebAuthn
credentials. Missing/malformed IDs, missing migrations or unverified users leave
controls unconfigured. `/ready` reports `founderControls.configured`. The first
verified pair is pinned in Postgres; changing environment IDs cannot replace it,
and restarting cannot restore revoked operator entitlement.

`accountControls.change`, `compliance.freezeIdentity`, `compliance.unfreezeIdentity`
and `disableUser` require the shared strict identity command: `requestId`,
`target: {area: "identity", userId}`, `action`, `reason`, `expectedVersion`. The
legacy routes require their corresponding restrict/restore action. Old `{userId}`
bodies refuse. Either founder independently acts through their own active MFA
interactive session; generic admin scopes, API keys and service identities cannot
change accounts. The transaction rechecks current user, session and entitlement
before every action or replay. Identity status, version, credential revocation and
immutable audit commit together. Restore cannot reopen closed accounts or revive
sessions, keys or subaccounts. Concurrent credential minting rechecks active
status under the same user lock.

Protected queries `accountControls.operatorStatus({})`,
`accountControls.getState({target})` and `accountControls.history({target, limit})`
serve the admin UI. State/history accept only identity targets; history requires
an explicit limit from 1 to 200. Live founder authorization precedes target reads.
`accountControls.changeOperatorEntitlement` accepts `requestId`, `userId`,
`action: "revoke" | "restore"`, `reason` and `expectedVersion` for the original pair
only, with the same live checks and attributed immutable audit. Ordinary admins
cannot grant this role.

Delegated POST `/trpc/accountControls.operatorEntitlement` uses plain JSON
`{"userId":"..."}` and returns the raw tRPC `result.data` entitlement. Require an
original edge-signed user principal whose subject matches the input, plus a v2
service signature over the exact JSON body bytes. The query checks active user,
token expiry/MFA, current live DB session/MFA and revocable founder entitlement.
Its result describes authority at query time; it grants no account-change or
future admission authority. Callers must reject invalid/unavailable/timed-out
responses and must not cache enabled results.

Service-only POST `accountControls.currentAuthority` checks credential and optional
subaccount ownership against current identity state. Eligible snapshots expire no
later than five seconds after the database check, or sooner with the credential.
Consumers must enforce the returned expiry. This slice does not serialize
trade/payment admission; bounded private-read leases belong to svc-ws.

Configure separate `IDENTITY_WS_AUTHORITY_SECRET` and
`IDENTITY_EDGE_AUTHORITY_SECRET` keys, distinct from generic and admission keys
and each other. Each public process supplies its own key as
`IDENTITY_OWNERSHIP_SECRET`. Each authenticates only
`accountControls.currentAuthority` and GET `/internal/api-keys/:keyId`;
mixed batches, mutations and aliased keys refuse. Neither public process needs a
generic money credential. Other existing service readers keep their current
authentication. `/ready.operationAdmission` reports these read-key configuration
flags separately from the owner admission keys; configuration is not a live probe.

Apply `drizzle/0026_operation_identity_decisions.sql` for owner operation decisions.
Set independent `IDENTITY_TRADE_ADMISSION_SECRET` and
`IDENTITY_PAY_ADMISSION_SECRET` keys, each at least 32 characters and distinct from
the generic service-signing key and each other. The generic identity read key
cannot authorize `operationAdmission.decide`. `/ready.operationAdmission` reports
key configuration only. Missing keys refuse admission; database failures return
typed `authority.unavailable`.

Owner-only POST `/trpc/operationAdmission.decide` uses strict plain JSON,
body-bound v2 service authentication and no mixed procedure batch. The owning
service stores the original immutable business payload and pending identity
request before calling. Decisions bind the service, operation kind, business ID,
payload hash, actual user and credential or parent delegation. Fresh grants check
current active identity and actual credential ownership, revocation, expiry and
subaccount under the same guard as identity restrictions. Account-bound API keys
require the matching actual subaccount. Delegated children
recheck the original strategy credential. Merchant policy authority is vouched
for by svc-pay and still checks the actual active identity. PayFac authority
preserves svc-pay's explicit grant or root relationship and the original parent
credential. Identity checks both the child owner's active identity and the
parent's active identity, actual credential ownership, expiry and subaccount.
Resolving an existing grant recovers only its original payload after either
identity is restricted; it never grants a fresh delegated operation.

Every decision is immutable. `resolve_or_cancel` returns the prior decision or
records a cancellation tombstone that prevents a delayed first grant. The owning
service must hold its own restriction guard while finalizing admission and drain
all pending requests before committing a local restriction. An uncertain network
outcome retains the pending marker and cannot be reported as a completed local
restriction. An existing grant resolves only its original payload after freeze;
it grants no fresh child or changed business operation and proves no completed
ledger effect. Trading/payment enforcement belongs to their service consumers.
