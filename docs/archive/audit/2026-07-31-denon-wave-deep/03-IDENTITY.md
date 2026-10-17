# 03-IDENTITY — svc-identity deep audit (backend only)

**Scope:** `services/svc-identity` — auth fail-closed, S2S, `ifc_` bearer, WebAuthn, sub-account revoke, KYC queue poison residual.  
**Worktree:** `.worktrees/fix-token-params-bank-s2s`  
**Out of scope:** frontend, apps, vendor, edge product polish (edge `ifc_` path noted only where identity depends on it).  
**Mode:** read-only judgment · file:line evidence · no runtime re-proof this pass.

---

## Verdict

**PASS with residuals — no open agent P0 on audited identity auth surfaces.**

Fail-closed edge principal, S2S HMAC on internal + `serviceProcedure`, `ifc_` key mint/exchange with scope delegation + interactive-only refusal, WebAuthn ceremony (UV, counter, origin/rpID), sub-account soft-revoke + ownership S2S, and KYC queue isolation are **sound in code**. Prior L2 P0s (awardXp on every session; unauth `/internal/*`) remain fixed.

**Agent-fixable P0:** none.  
**Agent-fixable P1:** two (recovery-code theatre; freeze incomplete on refresh).  
**P2/info residuals:** domain whitelist dead control; ChallengeStore single-instance; DB CHECK missing `pay:payout`; optional HTTP 401 inject tests.

---

## Answers (required)

### 1. Auth fail-closed?

**YES on every private tRPC path and at edge-trust boot.**

| Control                                  | Behaviour                                           | Evidence                                                                                             |
| ---------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Edge secret                              | Boot throws if `EDGE_PRINCIPAL_SECRET` &lt; 32      | `packages/contracts/src/edge.ts:176-181`; `packages/config/src/env.ts:66-68`; wired `index.ts:73-77` |
| Bad/missing principal                    | `principal: null` — never partial trust             | `edge.ts:95-128` (`verifyForwardedPrincipal`)                                                        |
| `protectedProcedure` / `scopedProcedure` | No principal → UNAUTHORIZED; scope miss → FORBIDDEN | `packages/contracts/src/trpc.ts:87-143`                                                              |
| `serviceProcedure`                       | No service caller → UNAUTHORIZED                    | `trpc.ts:157-160`; `requireServiceCaller`                                                            |
| JWT / internal secrets                   | No default; min 32 at load                          | `config/src/env.ts:78-79`, `103-105`                                                                 |
| Prod argon2                              | Process refuses to start without argon2id           | `index.ts:21`                                                                                        |

Anonymous only on intentional public surfaces: register/login/refresh/logout, WebAuthn auth ceremony, `apiKeys.exchange`, health.

### 2. S2S?

**YES — dual surface; both credential-gated.**

| Surface                                    | Guard                                | Evidence                            |
| ------------------------------------------ | ------------------------------------ | ----------------------------------- |
| `GET /internal/rank/:userId/perks`         | `verifyServiceHeaders` → 401 if null | `index.ts:89-94`                    |
| `GET /internal/sub-accounts/:subAccountId` | same → 401; unknown id → 404         | `index.ts:101-109`                  |
| `rank.awardXp`                             | `serviceProcedure` (not user scopes) | `router.ts:478-511`                 |
| tRPC context service field                 | `internalSecret` required for verify | `index.ts:73-77`; `edge.ts:201-204` |

GET S2S uses **v1** headers (no body digest) — same pattern as trade client / prior #246 residual A246-R1. Not a bypass without `INTERNAL_SERVICE_SECRET`.

Ownership snapshot returns **revoked rows** so callers distinguish foreign vs retired (`auth-service.ts:992-1008`). Caller binds parent to **edge principal** (trade side; re-audited in `03A-AUTH-246-227.md`).

### 3. `ifc_` bearer / API keys?

**YES — mint once, hash-only store, public exchange → short JWT, fail-closed on bad/revoked/expired/frozen.**

| Step             | Guard                                                        | Evidence                                              |
| ---------------- | ------------------------------------------------------------ | ----------------------------------------------------- |
| Format           | `ifc_` + 24-byte base64url                                   | `passwords.ts:188-190`                                |
| Store            | SHA-256 hash + prefix only                                   | `auth-service.ts:600-611`; schema `api_keys`          |
| Create           | `assertDelegatableScopes(grantorScopes from principal)`      | `auth-service.ts:588-598`; `router.ts:555-562`        |
| Interactive-only | Service assert + DB CHECK                                    | `scopes.ts:146-155`; `0000_identity_init.sql:144-146` |
| Exchange         | Public; `verifyApiKey` + user `active` + `mfa: false`        | `auth-service.ts:642-680`; `router.ts:519-543`        |
| Edge             | `looksLikeApiKey` → call identity exchange; fail → anonymous | `svc-edge/.../principal-exchange.ts:94-170`           |
| Revoke           | Self-only `user_id` + `revoked=false`                        | `auth-service.ts:683-687`                             |
| Step-up from key | **Blocked** — `sid` is key id, not a sessions row            | `stepUp` session SELECT `auth-service.ts:924-928`     |

DB CHECK omits `pay:payout` (in `INTERACTIVE_ONLY` in code) — defense-in-depth hole only if create assert is bypassed (P2).

`domain_whitelist` is accepted and stored; **never read on verify/exchange** (P2 dead control).

### 4. WebAuthn?

**YES for ceremony crypto + MFA marking; residual ops/product gaps.**

| Property                        | Status                                                                  | Evidence                                    |
| ------------------------------- | ----------------------------------------------------------------------- | ------------------------------------------- |
| ES256 only, attestation `none`  | Enforced                                                                | `webauthn.ts:88`, `355-357`, `311`          |
| UV required (register + assert) | Enforced                                                                | `webauthn.ts:189-192`, `212-214`, `275-277` |
| Origin + rpIdHash               | Enforced                                                                | `webauthn.ts:249-250`, `363-366`, `416-418` |
| Counter clone                   | Decrease refused (0→0 allowed)                                          | `webauthn.ts:423-428`                       |
| Challenge single-use / TTL      | `ChallengeStore.take`                                                   | `webauthn.ts:136-144`                       |
| Challenge ↔ user bind           | Registration + authentication                                           | `auth-service.ts:445-447`, `528-530`        |
| Passwordless → `mfa: true`      | Yes                                                                     | `auth-service.ts:558`                       |
| Kill-switch                     | `WEBAUTHN_ENABLED`                                                      | `env.ts:30-31`; router gates                |
| Challenge store                 | **In-process only** — multi-pod breaks ceremony (fail closed, not open) | `webauthn.ts:114-120`; README:103           |

Step-up remains **TOTP-only** (`auth.stepUp`). WebAuthn-only users cannot elevate to `trade:withdraw` without TOTP enrolment (documented product rule in README step-up section; intentional until WebAuthn step-up lands).

### 5. Sub-account revoke?

**YES — soft-disable, self-only, no money movement, S2S-visible.**

| Claim | Evidence |
| ------------------------------ | -------------------------------------------------------------------- | ---------------------------------------------- |
| Soft `revoked=true` only | `auth-service.ts:981-989`; migration `0002_sub_accounts_revoke.sql` |
| Parent gate (no cross-user) | `WHERE parent_user_id = ${userId}`; tests `identity.test.ts:553-560` |
| Row survives (ledger owner id) | schema comment `schema.ts:198-206`; list still returns revoked |
| No ledger post | Explicit `auth-service.ts:975-978`; doctrine hold |
| S2S ownership after revoke | Returns `{…, revoked: true}` | `identity.test.ts:563-577`; `index.ts:101-109` |

Trade fail-closed before hold was prior #246 PASS — not re-litigated here.

### 6. KYC queue poison residual?

**CLOSED in test design; production queue is simple FIFO.**

| Risk                                                 | Mitigation                                                             | Evidence                                       |
| ---------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------------- |
| Parallel worktrees TRUNCATE / shared pending backlog | Per-suite schema via `createTestDb` + all migrations from disk         | `identity.test.ts:23-54`, header comment 30-33 |
| Absolute index FIFO flake                            | Assert relative order of _this_ suite’s two records                    | `identity.test.ts:751-765`                     |
| Double pending spam                                  | User row `FOR UPDATE` + return existing pending/approved               | `auth-service.ts:726-748`                      |
| Operator queue                                       | `status='pending' ORDER BY created_at ASC`                             | `auth-service.ts:769-776`                      |
| Self-grant                                           | submit grants nothing; approve needs `admin:compliance` + `requireMfa` | `router.ts:350-425`                            |
| Direct `approveKyc`                                  | Seed/test only — **no route**                                          | `auth-service.ts:849-857`                      |

No residual poison that weakens production auth. Test isolation is the fix; do not re-open as open P0.

---

## Findings table

| id      | severity | surface                  | claim                                                                                                                                      | evidence                                                       | fix-owner                                                                                              |
| ------- | -------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| ID-01   | **PASS** | Edge + procedures        | Fail-closed principal; bad sig → anonymous                                                                                                 | `edge.ts:95-128`; `trpc.ts:87-95`                              | —                                                                                                      |
| ID-02   | **PASS** | S2S internal + awardXp   | Credentials required; user scopes cannot mint XP                                                                                           | `index.ts:89-109`; `router.ts:491`; `router.test.ts:178-211`   | —                                                                                                      |
| ID-03   | **PASS** | `ifc_` keys              | Hash-only; delegation ceiling; no withdraw scopes; exchange frozen/revoked closed                                                          | `auth-service.ts:588-687`; SQL CHECK                           | —                                                                                                      |
| ID-04   | **PASS** | WebAuthn                 | UV/origin/rpID/counter/challenge bind                                                                                                      | `webauthn.ts` + `auth-service.ts:408-558`                      | —                                                                                                      |
| ID-05   | **PASS** | Sub-account revoke + S2S | Soft revoke; parent-only; ownership for trade                                                                                              | `auth-service.ts:969-1008`; `index.ts:101-109`                 | —                                                                                                      |
| ID-06   | **PASS** | KYC queue / poison       | Isolated tests; FIFO relative; submit idempotent; approve MFA                                                                              | `identity.test.ts:30-33,751-768`; `router.ts:404-425`          | —                                                                                                      |
| ID-07   | **PASS** | Refresh reuse            | Reuse burns all sessions **outside** detecting txn                                                                                         | `auth-service.ts:300-355`; test `:410-418`                     | —                                                                                                      |
| ID-08   | **PASS** | Step-up                  | TOTP + live session; no grantor-supplied scopes; API-key sid cannot elevate                                                                | `auth-service.ts:901-938`; router stepUp input                 | —                                                                                                      |
| ID-P1-1 | **P1**   | TOTP recovery codes      | **Theatre:** codes generated and returned; **never stored**; no redeem path; comments claim “Stored hashed”                                | `auth-service.ts:383-388`; `totp.ts:137-147`; no schema column | **Agent-fixable** — implement hashed store + redeem **or** remove from enrol response until ready      |
| ID-P1-2 | **P1**   | Freeze / status          | Login, WebAuthn, exchange, stepUp check `active`; **`refresh` does not** — frozen user keeps rotating access until refresh TTL / logoutAll | `auth-service.ts:286-360` vs `:233`, `:657`                    | **Agent-fixable** — status check on refresh (+ prefer revoke sessions on freeze when freeze API lands) |
| ID-P2-1 | **P2**   | `domain_whitelist`       | Accepted on create; ignored on verify/exchange                                                                                             | schema + `createApiKey` insert; no read in `verifyApiKey`      | Agent: enforce or drop from API                                                                        |
| ID-P2-2 | **P2**   | WebAuthn challenges      | In-process map — multi-instance fail-closed availability                                                                                   | `webauthn.ts:114-120`                                          | Ops / later Redis                                                                                      |
| ID-P2-3 | **P2**   | API key DB CHECK         | Missing `pay:payout` vs `INTERACTIVE_ONLY_SCOPES`                                                                                          | `0000_identity_init.sql:146` vs `scopes.ts:146`                | Agent: align CHECK migration                                                                           |
| ID-P2-4 | **P2**   | TOTP window replay       | Documented; no last-used counter                                                                                                           | README:61                                                      | Separate PR                                                                                            |
| ID-I-1  | **info** | register IP              | `ip: ctx.requestId` — not client IP                                                                                                        | `router.ts:129`                                                | Hygiene                                                                                                |
| ID-I-2  | **info** | Internal HTTP 401        | No inject test on `/internal/sub-accounts`                                                                                                 | Prior A246-R2                                                  | Optional test                                                                                          |
| ID-I-3  | **info** | No freeze operator API   | Status enum exists; freeze only via SQL in tests                                                                                           | schema `user_status`                                           | Product when compliance ops lands                                                                      |

---

## Surface map (complete for this audit)

| Area                | Files                                                                |
| ------------------- | -------------------------------------------------------------------- |
| Mount + S2S HTTP    | `src/index.ts`                                                       |
| tRPC API            | `src/router.ts`                                                      |
| Auth core           | `src/auth/auth-service.ts`                                           |
| Passwords / `ifc_`  | `src/auth/passwords.ts`                                              |
| TOTP                | `src/auth/totp.ts`                                                   |
| WebAuthn            | `src/auth/webauthn.ts`, `cbor.ts`                                    |
| Schema / migrations | `src/db/schema.ts`, `drizzle/0000*`, `0001*`, `0002*`                |
| Env                 | `src/env.ts`                                                         |
| Blueprint cascade   | `src/events.ts`, `blueprint-profile.ts`                              |
| Rank                | `src/rank/*`                                                         |
| Shared edge/S2S     | `packages/contracts/src/edge.ts`, `service-auth.ts`, `trpc.ts`       |
| Scopes / tokens     | `packages/auth/src/scopes.ts`, `tokens.ts`                           |
| Edge `ifc_` join    | `services/svc-edge/src/principal-exchange.ts` (dependency note only) |

---

## What was **not** verified this pass

- Live HTTP against a running identity container / Actions green.
- JetStream ACL for identity-owned events in deployed NATS.
- Multi-pod WebAuthn challenge behaviour (documented residual only).
- Rate limiting on login/exchange (none in identity; none grepped in edge for this path).
- Operator freeze product flow (no procedure).

---

## Agent-fixable P0/P1 (action list)

### P0

**None.**

### P1

1. **ID-P1-1 — Recovery codes:** stop shipping non-functional codes (remove from wire **or** persist hashed + redeem on login/step-up). Comment in `totp.ts` currently lies.
2. **ID-P1-2 — Freeze vs refresh:** `refresh()` must refuse non-`active` users (mirror login/exchange). When freeze API exists, revoke all sessions in the same transaction.

### P2 (optional same wave)

- Enforce or remove `domain_whitelist`.
- Add `pay:payout` to `api_keys_no_withdraw_ck`.
- Shared WebAuthn challenge store before multi-replica identity.

---

## Closing

**svc-identity auth spine holds.** Fail-closed edge + S2S + scoped procedures; `ifc_` keys cannot withdraw or step-up; WebAuthn crypto checks are real; sub-account revoke is soft and ownership-visible; KYC queue poison residual is test isolation, not production auth debt. Ship P1 recovery-code honesty and freeze-on-refresh before treating account freeze as an ops control.

## Fix follow-up

**ID-P1-2 closed** in this PR: `refresh` refuses non-active users and revokes the presented session.
