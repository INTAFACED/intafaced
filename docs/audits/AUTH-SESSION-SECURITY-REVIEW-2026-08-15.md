# Auth / session security review (fiat plane) — D26-P3-06

> **Not current rules (2026-10-17).** This file stays only because tooling reads its path. Current rules: [`AGENTS.md`](../../AGENTS.md). Where this file disagrees with AGENTS.md or the code, AGENTS.md and the code win.

**Status:** Written review on tip. **Not** a certification, pentest, or “we are secure” claim.  
**Date:** 2026-08-15. **Tip at open:** `origin/main` `fb819742`.  
**Class:** N (judgment). **Scope:** Fiat-plane credential mint in `packages/auth` + `services/svc-identity`.  
**Out of scope:** Shehzad protocol/INTACHAIN passkeys, Vue shell, sanctions lists, Class X secret values, production origin invention (that is **D26-P3-07**), dual-edit of open identity money PR `#2032`.  
**Leverage:** Phase A **IN** — `S-ID` (`services/svc-identity`) + `@intafaced/auth`. No second auth stack.  
**Sibling:** Open PR `#2015` (`feat/d26-p3-06-auth-session-review`) is an earlier write-up on an older tip. This artefact is independent on current tip; merge one, close the other.

This document answers: for session mint, TOTP window, WebAuthn, step-up `trade:withdraw`, and API keys — **what the code on this tip proves**, versus **named residuals with paths that exist**.

---

## 0 · How this was read

Read (not edited): `packages/auth/src/{tokens,scopes,guards,auth.test}.ts`, `services/svc-identity/src/auth/{auth-service,totp,webauthn,api-key-origin,pending-totp-store}.ts`, `services/svc-identity/src/{router,index,env}.ts`, `packages/config/src/env.ts` (`authEnvSchema`). Tracker rows `identity.accounts` / `identity.step-up` / `identity.webauthn` / `identity.apikeys` were **not** flipped.

---

## 1 · Session mint — proven vs residual

### Proven on tip

| Claim                                                                                                           | Where                                                                                               |
| --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Access JWTs are HS256, require `exp`, carry `sub` / `sid` / `scopes` / `tier` / `mfa`                           | `packages/auth/src/tokens.ts` (`issueAccessToken`, `verifyAccessToken` + `requiredClaims: ['exp']`) |
| Signing secret shorter than 32 characters is refused                                                            | `tokens.ts` `key()`; `packages/config/src/env.ts` `JWT_ACCESS_SECRET` `min(32)`                     |
| Default access TTL is 900s (bounded 60–3600); refresh default 30d (bounded 1h–90d)                              | `authEnvSchema`                                                                                     |
| Refresh is opaque, stored hashed, rotated; reuse of a revoked refresh burns **all** live sessions for that user | `AuthService.refresh` in `services/svc-identity/src/auth/auth-service.ts`                           |
| Login compares password even when the account is missing (dummy hash)                                           | `AuthService.login`                                                                                 |
| Frozen/closed accounts cannot mint from a still-valid refresh                                                   | `refresh` outcome `frozen` (ID-P1-2)                                                                |
| Logout / logoutAll / freeze set `sessions.revoked = true`                                                       | `logout`, `logoutAll`, `freezeIdentity`                                                             |
| Interactive session scopes come from one table; `trade:withdraw` is withheld                                    | `packages/auth/src/scopes.ts` `SESSION_SCOPES` / `WITHHELD_FROM_SESSION`                            |
| Wire step-up binds `userId` + `sid` from the **edge principal**, not from the body                              | `services/svc-identity/src/router.ts` `auth.stepUp`                                                 |

### Residual (named)

**R-AUTH-01 — Access JWT still authorises after session revoke / freeze until `exp`.**  
`verifyAccessToken` (`packages/auth/src/tokens.ts`) checks signature, issuer, audience, algorithm, and `exp`. It does **not** load `sessions.revoked`. `AuthService.logout` / `freezeIdentity` (`auth-service.ts`) only flip the session (and key) rows. `freezeIdentity` comments that revoke happens “so freeze is not delayed until token expiry” — that is true for **refresh and step-up** (`stepUp` re-reads a live session row). It is **false** for every service that authorises from the bearer JWT alone. Default window: `JWT_ACCESS_TTL_SECONDS` = 900. Same shape after `revokeApiKey`: the already-exchanged JWT (`exchangeApiKey` sets `sessionId` = key id) is not re-checked against `api_keys.revoked`.

This is a judgment residual, not a CVE number. Closing it means a live-session (or live-key) check on the authorisation path, or a much shorter access TTL — owner call, not this PR.

---

## 2 · TOTP window — proven vs residual

### Proven on tip

| Claim                                                                                        | Where                                                                                            |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| RFC 6238 TOTP, ±1 step window, constant-time compare, returns the matched **counter**        | `services/svc-identity/src/auth/totp.ts` `matchTotpStep`                                         |
| Successful use burns the step under `FOR UPDATE`; same or earlier step → `auth.mfa_invalid`  | `AuthService.consumeTotpCode`; column `users.totp_last_step` (`drizzle/0008_totp_last_step.sql`) |
| Enrol confirm seeds `totp_last_step` so the QR-confirm code cannot immediately login/step-up | `confirmTotpEnrolment` comment + write in `auth-service.ts`                                      |
| Login / step-up prefer TOTP burn, then single-use recovery hash                              | `login`, `stepUp`                                                                                |
| Pending enrol is hashed secret + recovery hashes, SQL single-use take                        | `pending-totp-store.ts`                                                                          |
| Prod boot refuses missing `IDENTITY_TOTP_SECRET_KEY`                                         | `services/svc-identity/src/index.ts` (`APP_ENV === 'prod'`)                                      |
| Anti-replay is tested                                                                        | `identity.test.ts` “refuses a TOTP code that was already consumed in this window”                |

Tracker `identity.step-up` still carries the **stale** note that a TOTP code is “replayable inside its validity window.” That note is leftover honesty, **not** current mint behaviour. This review does **not** edit `features.mjs`.

### Residual

Window ±1 is still three valid codes per clock. Adjacent **unused** steps remain usable until consumed — that is RFC skew, not a hole. No extra ticket.

---

## 3 · WebAuthn — proven vs residual

### Proven on tip

| Claim                                                                                                | Where                                                                                   |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| ES256 only; `userVerification: 'required'`; attestation fmt `none` only                              | `services/svc-identity/src/auth/webauthn.ts`                                            |
| Challenges are single-use with TTL; kinds `registration` / `authentication` / `step-up` are distinct | `ChallengeKind`; `startWebauthnStepUp` comment — login assertion cannot satisfy step-up |
| Assertion counter is stored and updated                                                              | `verifyAuthenticationResponse` + `auth-service.ts` updates `webauthn_creds`             |
| Passwordless login issues a session; step-up uses a separate ceremony                                | `router.ts` `stepUpOptions` / `stepUp`                                                  |
| Kill-switch `WEBAUTHN_ENABLED`                                                                       | `env.ts` / router                                                                       |

### Residual (named)

**R-AUTH-02 — Prod boot does not refuse localhost relying-party defaults.**  
`services/svc-identity/src/env.ts` defaults `WEBAUTHN_RP_ID` to `localhost` and `WEBAUTHN_ORIGIN` to `http://localhost:3000`. `index.ts` prod boot asserts argon2 + TOTP wrap key; it does **not** refuse those defaults. A prod process that never sets the env vars will mint/verify passkeys against localhost / `http://localhost:3000`. Owner must set real rpId/origin (HTTPS). D26-P3-07 owns CORS/origin contract — do not invent production hosts here. Attestation `none` means no hardware attestation trust store; cloned authenticators are a counter residual, not a named CVE.

---

## 4 · Step-up `trade:withdraw` — proven vs residual

### Proven on tip

| Claim                                                                                                | Where                                                    |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Default session never carries `trade:withdraw`                                                       | `WITHHELD_FROM_SESSION`                                  |
| Elevation adds **only** `STEP_UP_SCOPES = ['trade:withdraw']` — not caller-supplied scopes           | `auth-service.ts`                                        |
| TTL capped at 300s (`STEP_UP_TTL_SECONDS`) even if access TTL is longer                              | `stepUp` `Math.min(..., 300)`                            |
| Session must still be unrevoked and unexpired                                                        | `stepUp` session SELECT                                  |
| Exactly one of TOTP/recovery or WebAuthn                                                             | router refine + service `hasTotp === hasWebauthn` refuse |
| Elevated token sets `mfa: true`; `requireScope` on `INTERACTIVE_ONLY_SCOPES` demands `principal.mfa` | `packages/auth/src/guards.ts`                            |
| API keys cannot be granted `trade:withdraw` / `pay:payout` / `admin:treasury` / `bank:card`          | `assertKeyScopesAllowed` / `assertDelegatableScopes`     |
| Key exchange always `mfa: false`                                                                     | `exchangeApiKey`                                         |

### Residual (named)

**R-AUTH-03 — `bank:card` is described as a step-up surface but step-up never issues it.**  
`packages/auth/src/scopes.ts` `WITHHELD_FROM_SESSION['bank:card']` says “interactive-only step-up surface (§9, §18)”. `INTERACTIVE_ONLY_SCOPES` includes `bank:card`. `AuthService.stepUp` only concatenates `STEP_UP_SCOPES` (`trade:withdraw`). There is no second elevation that mints `bank:card`. Consequence: card spend cannot be reached by a normal session **or** by the only step-up that exists. That is either an honest socket (card not live) or a withheld-comment lie. Do not invent a grant here.

---

## 5 · API keys — proven vs residual

### Proven on tip

| Claim                                                                                                           | Where                                                  |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Create runs `assertDelegatableScopes` (unknown scopes refused; cannot exceed grantor; interactive-only refused) | `createApiKey`                                         |
| Key returned once; stored hashed; prefix listed                                                                 | `createApiKey` / `listApiKeys`                         |
| Exchange is the public door to a short JWT; no refresh                                                          | `exchangeApiKey`; `router.ts` `apiKeys.exchange`       |
| Frozen user cannot exchange                                                                                     | status check in `exchangeApiKey`                       |
| Non-empty `domain_whitelist` + missing Origin fails closed                                                      | `api-key-origin.ts`; tests in `api-key-origin.test.ts` |
| Freeze bulk-revokes keys                                                                                        | `freezeIdentity`                                       |

### Residual (not a third primary ticket; leftover)

Empty whitelist = any origin (`apiKeyOriginAllowed` first line). Documented for server bots; a browser key created without a list is unrestricted at exchange. Suffix match `host.endsWith('.' + allowed)` allows any subdomain of a listed host (`api-key-origin.ts`). JWT-after-revoke is **R-AUTH-01**.

---

## 6 · Named residuals (must exist as files on this tip)

| ID            | Failure mode                                                                | File(s) that exist                                                                                                                                                   |
| ------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R-AUTH-01** | Logout/freeze/key-revoke do not kill already-minted access JWTs until `exp` | `packages/auth/src/tokens.ts` (`verifyAccessToken`); `services/svc-identity/src/auth/auth-service.ts` (`logout`, `freezeIdentity`, `exchangeApiKey`, `revokeApiKey`) |
| **R-AUTH-02** | `APP_ENV=prod` can boot WebAuthn with localhost rpId/origin                 | `services/svc-identity/src/env.ts` (`WEBAUTHN_RP_ID` / `WEBAUTHN_ORIGIN` defaults); `services/svc-identity/src/index.ts` (prod boot block)                           |
| **R-AUTH-03** | `bank:card` labelled step-up; only `trade:withdraw` is minted               | `packages/auth/src/scopes.ts` (`WITHHELD_FROM_SESSION`, `INTERACTIVE_ONLY_SCOPES`); `services/svc-identity/src/auth/auth-service.ts` (`STEP_UP_SCOPES`)              |

No invented CVE IDs. No production secrets. No claim that the plane is ready for go-live.

---

## 7 · What this review did **not** do

- Did not add a fail-closed test: no public door was found that **returns success while claiming refusal**. TOTP replay is already refused and tested. The freeze comment vs JWT lifetime is a comment mismatch, not a door that lies on the wire.
- Did not mark identity tracker rows done or undone.
- Did not edit `svc-trade`, `svc-edge`, `svc-agents`, `svc-p2p`, `svc-support`, or `#2032` identity money-door tests.
- Did not set production WebAuthn origins (D26-P3-07 / Class X host list).
- HS256 shared `JWT_ACCESS_SECRET` rotation readiness is **D26-P3-05**, not this mountain.

---

## 8 · Leftover (after this review ships)

1. Owner judgment on R-AUTH-01 (session/key liveness on every request vs shorter TTL).
2. Prod env contract for R-AUTH-02 (fail boot if rpId is `localhost` when `APP_ENV=prod`) — still no invented hostname.
3. Align R-AUTH-03: either a real `bank:card` step-up when §18 is live, or rewrite the withheld reason to “not issued; no elevation path”.
4. Stale `identity.step-up` tracker note (TOTP replay) — honesty PR, mountain event, not this file.
5. Duplicate write-up `#2015` — close or supersede when this lands.
6. CORS/production origin list remains **D26-P3-07**.
