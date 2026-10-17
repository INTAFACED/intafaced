# 03 — #207 notify fan-out honesty · edge private REST (preservePath money APIs)

**Scope:** Backend only. Multi-channel notify (#207 / `ops.notifications`); edge principal exchange + `packages/auth` guard patterns; CCXT private REST under `/api/v1` (`preservePath` → trade).  
**Worktree:** `.worktrees/audit-denon-wave-deep`  
**Method:** CODE-REVIEWED (deep-read). **Not** live gateway re-run; **not** multi-replica JetStream re-run this pass.  
**UTC:** 2026-07-31

---

## VERDICT

**PASS on both binding questions.**

| #   | Question                                                                                | Answer                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Can notify claim **delivered** falsely (esp. unconfigured / refused / failed channels)? | **No on the product surface.** Unconfigured, disabled, no-target, and transport failures settle as `refused` / `failed` / `abandoned` with `delivered_at` NULL. DB CHECK enforces `delivered_at` iff `status = 'delivered'`. In-app is the only always-available channel and is honestly the inbox row. Tracker residual stands: out-of-app cannot actually deliver until owner supplies gateway credentials — refusals are on the record. |
| 2   | Private REST money APIs fail closed without a real edge principal?                      | **Yes.** Every private `/api/v1/*` money/read route calls `requirePrincipal` → missing / forged / unsigned / expired edge principal → **401** before `placeOrder` / ledger balance / cancel / fills. Same HMAC edge boundary as tRPC (`createEdgeContext`). Edge `preservePath` does **not** weaken auth: same `exchangePrincipal` strip+sign on every `/api/*` hop; `/api/v1` is module `trade` for kill-switch.                          |

No P0. No P1. Residuals are P2/info (gateway-trust semantics; crash-window double-send if gateway ignores idempotency; bus subjects still skipped without principal ids).

---

## Question map (binding)

### Q1 — Notify “delivered” honesty (#207)

| Failure mode                                      | Outcome in code                                                                                                                   | False “delivered”?                                         |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Channel not wired (no URL/token)                  | `UnconfiguredChannel` throws `ChannelRefusal(channel.not_configured)` → settle `refused`, `attempted: false`, `delivered_at` null | **No**                                                     |
| Out-of-app kill switch                            | `channel.disabled` refuse when target exists                                                                                      | **No**                                                     |
| No confirmed address (info/action)                | Skip out-of-app; only in-app                                                                                                      | **No** (nothing promised)                                  |
| No confirmed address (critical, e.g. margin call) | Refuse each out-of-app with `channel.no_target`                                                                                   | **No** — silence is recorded                               |
| Unverified address on file                        | Not in `targets.verified()`; not sent                                                                                             | **No**                                                     |
| Gateway 5xx / network timeout                     | `failed` + `retryable`, `delivered_at` null; bus naks                                                                             | **No**                                                     |
| Gateway 4xx permanent                             | `abandoned`, `delivered_at` null; no nak                                                                                          | **No**                                                     |
| Max attempts exhausted                            | `abandoned` + `channel.attempts_exhausted`                                                                                        | **No**                                                     |
| Bus redelivery after success                      | Claim returns `already_delivered`; no second send                                                                                 | **No** double-claim as new delivery                        |
| Fan-out killed (`NOTIFY_FANOUT_ENABLED`)          | No insert, no dispatch, bus acks                                                                                                  | **No** green delivery claim                                |
| Register target while channel unconfigured        | `{ status: 'refused', code: 'channel.not_configured' }`; target stays unverified                                                  | **No** success without transport accept                    |
| In-app                                            | Delivery after inbox insert; `delivered` = row exists, not “read”                                                                 | **Honest** (documented; `read_at` separate)                |
| Gateway returns HTTP 2xx                          | Settle `delivered` = “transport accepted” (not proof of user inbox open)                                                          | **By design** — not a lie about unconfigured/refused paths |

**“Delivered” meaning (explicit):** adapter handed message to transport and transport accepted (2xx). Not “user opened email.” That is stated in `channels/channel.ts` and is the only status that may read as “the user was told.”

### Q2 — Private REST without principal

| Attack / gap                                                                       | Outcome                                                                                                                                         |
| ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| No `Authorization` / no edge principal headers                                     | Service principal null → **401** `AuthenticationError`; handlers never call trade/ledger deps                                                   |
| Client-forged `x-intafaced-principal` (full scopes, mfa, admin) without valid HMAC | `verifyForwardedPrincipal` → null → **401**; placeOrder/cancel/balance never called                                                             |
| Valid JWT at edge                                                                  | Edge strips client `x-intafaced-*`, verifies JWT via `@intafaced/auth` `verifyAccessToken`, re-signs principal with region-bound HMAC, forwards |
| Bypass edge (hit trade port with forged header)                                    | Same service-side HMAC fail-closed — network placement is not the only gate                                                                     |
| Bad/expired token at edge                                                          | Forwarded **anonymous**; private REST still 401 (public REST still works)                                                                       |
| `/api/v1` preservePath                                                             | Path kept as `/api/v1/...` on trade; **auth path identical** to other proxies                                                                   |
| Kill trade module                                                                  | Both `/api/trade` and `/api/v1` share `module: 'trade'` — REST money not left unkilled                                                          |

---

## Findings

| id                         | layer        | file:line (approx)                                       | claim                                                                                                | severity | evidence                                                                           | status                                                        |
| -------------------------- | ------------ | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **N207-THREE-OUTCOMES**    | L4 notify    | `channels/channel.ts:10-25`, `dispatch.ts:19-22`         | delivered / refused / failed are distinct; void success forbidden                                    | —        | Design + types; settle paths only write `delivered` after adapter receipt          | **HOLDS**                                                     |
| **N207-UNCONFIG-REFUSE**   | L4 notify    | `gateway.ts:108-131`, `registry.ts:94-107`               | Unconfigured never accepts; always registered                                                        | —        | `UnconfiguredChannel.deliver` throws; missing channel throws at construct          | **HOLDS**                                                     |
| **N207-DELIVERED-CK**      | L4 notify    | `drizzle/0001_notify_channels.sql:76-83`                 | DB refuses delivered_at without delivered status (and inverse)                                       | —        | CHECK `(status = 'delivered') = (delivered_at IS NOT NULL)`                        | **HOLDS**                                                     |
| **N207-CLAIM-IDEMP**       | L4 notify    | `channel-store.ts:287-332`, memory claim                 | Atomic claim per (notification, channel); redelivery no double-send                                  | —        | PG upsert WHERE pending/failed and attempts < max; unique index                    | **HOLDS**                                                     |
| **N207-CRITICAL-RECORD**   | L4 notify    | `dispatch.ts:97-104`, `events.ts:294-331`                | Critical with no target still writes refuse rows                                                     | —        | margin call `severity: 'critical'`; tests in `channels.test.ts`                    | **HOLDS**                                                     |
| **N207-INAPP-FALLBACK**    | L4 notify    | `dispatch.ts:84-87`, `gateway.ts:145-151`                | Inbox always tried; honest fallback when gateways dark                                               | —        | Tracker + tests: unreadCount 1 with all out-of-app refused                         | **HOLDS**                                                     |
| **N207-VERIFY-HONEST**     | L4 notify    | `notify-service.ts:175-222`                              | Register never reports `sent` without transport accept                                               | —        | Refusal/failure outcomes; no inbox leak of verify code                             | **HOLDS**                                                     |
| **N207-SKIP-NO-PRINCIPAL** | L4 notify    | `events.ts:40-43`                                        | No invented fan-out to missing counterparties                                                        | —        | `p2pDisputeResolved` / `p2pTradeExpired` skipped; dispute → `openedBy` only        | **HOLDS** (honest gap)                                        |
| **N207-HONESTY-TESTS**     | L6 test      | `channels.test.ts`                                       | Lies pinned: unconfigured success, double-send, false delivered_at, silent critical                  | —        | Explicit suite header + cases                                                      | **HOLDS** CODE-REVIEWED                                       |
| **RES-GATEWAY-TRUST**      | L4 notify    | `gateway.ts:96-104`                                      | 2xx from owner gateway ⇒ delivered                                                                   | **P2**   | Owner-run gateway can accept then drop; platform records transport accept honestly | **OPEN residual** (ops trust; not false unconfigured success) |
| **RES-CRASH-AFTER-2XX**    | L4 notify    | `dispatch.ts:157-158` + claim                            | Die after gateway 2xx before settle → redelivery may send twice if gateway ignores `idempotency-key` | **P2**   | Claim allows re-attempt on pending/failed; idempotency is header + gateway duty    | **OPEN residual**                                             |
| **L2-EDGE-STRIP**          | L2 edge      | `principal-exchange.ts:65-79,147-155`                    | Client `x-intafaced-*` stripped before any success/fail branch                                       | —        | Tests: forged principal dropped anonymous                                          | **HOLDS**                                                     |
| **L2-AUTH-JWT**            | L2 auth      | `packages/auth` tokens + `principal-exchange.ts:174-192` | Edge only place JWT → principal; services verify HMAC                                                | —        | `verifyAccessToken` then `encodePrincipal` + `signPrincipalHeader`                 | **HOLDS**                                                     |
| **L2-EDGE-VERIFY**         | L2 contracts | `packages/contracts/src/edge.ts:95-132,176-214`          | Fail-closed verify; boot refuses weak EDGE secret                                                    | —        | bad-sig / malformed / expired → null; MIN 32                                       | **HOLDS**                                                     |
| **L2-TRPC-PATTERN**        | L2 contracts | `packages/contracts/src/trpc.ts:87-144`                  | `protectedProcedure` / `scopedProcedure` require principal + scope                                   | —        | Same principal model private REST mirrors                                          | **HOLDS**                                                     |
| **L2-GUARDS**              | L2 auth      | `packages/auth/src/guards.ts`                            | requireScope / MFA / ownership throw, never bool                                                     | —        | Used by TradeService + private-rest scope checks                                   | **HOLDS**                                                     |
| **L5-PRESERVE-PATH**       | L5 edge      | `routes.ts:52-69,102-114`                                | `/api/v1` → trade, path preserved, module trade                                                      | —        | resolve returns full pathname; kill map uses module field                          | **HOLDS**                                                     |
| **L5-PROXY-AUTH**          | L5 edge      | `index.ts:98-164`                                        | All `/api/*` go through exchangePrincipal                                                            | —        | No special-case skip for preservePath                                              | **HOLDS**                                                     |
| **L5-PRIVATE-REST-GATE**   | L5 trade     | `private-rest.ts:383-401,431+`                           | requirePrincipal on every private route                                                              | —        | Anonymous + forged tests per money endpoint                                        | **HOLDS**                                                     |
| **L5-BALANCE-SELF**        | L5 trade     | `private-rest.ts:570-581`                                | Balance only `principal.userId`                                                                      | —        | Comment + call site; forged never reaches ledger                                   | **HOLDS**                                                     |
| **L5-PRIVATE-REST-TESTS**  | L6 test      | `private-rest.test.ts:346-401,494+,…`                    | Mount boundary: unsigned never placeOrder/openOrders/cancel/balance                                  | —        | Explicit “THE ONE THAT MATTERS” + per-route forged cases                           | **HOLDS** CODE-REVIEWED                                       |
| **DOC-TRACKER-207**        | tracker      | `features.mjs` `ops.notifications`                       | ready not done; credentials socket honest                                                            | —        | Aligns with code refusals                                                          | **HOLDS**                                                     |

---

## Layer detail

### #207 — Multi-channel fan-out honesty

**Architecture**

1. Bus handler → `NotifyService.create` → inbox insert (idempotent on source key) → `NotificationDispatcher.dispatch`.
2. Dispatcher always attempts `inapp` (row already written).
3. Out-of-app only if `outOfAppEnabled` and a **verified** target exists; critical severity also records `channel.no_target` when no target.
4. Per channel: `claim` → adapter.deliver → `settle`. Outcomes never silent-drop.

**Why false delivery is hard**

- Application: only `settle({ status: 'delivered' })` after successful `deliver()`.
- Refusal path sets `attempted: false` so attempted_at stays null (provider-down ≠ no-address).
- Schema CHECK binds delivered_at to status.
- Unconfigured adapters throw; they do not return empty success.
- Registry refuses construction if any CHANNEL_IDS missing (absent channel cannot refuse → silent drop).

**Bus honesty**

- Retryable channel failures nak the message; permanent failures do not burn budget for other channels.
- Redelivery re-dispatches; claim stops second email; insert ON CONFLICT keeps one inbox row.
- Crash between insert and send: redelivery recovers row via `findBySource` and fans out again (explicit anti-loss).

**What #207 deliberately does not claim**

- Email/SMS/push **actually** reach a carrier without owner gateway credentials — adapters refuse with `channel.not_configured`.
- End-user open/read of out-of-app messages — only transport accept.
- Counterparty notify on dispute-resolved payloads that lack user ids — skipped rather than invented.

### packages/auth + edge private-route pattern

**Split of duties (this is the pattern)**

| Layer                   | Package / service                  | Job                                                                             |
| ----------------------- | ---------------------------------- | ------------------------------------------------------------------------------- |
| Issue / verify JWT      | `@intafaced/auth` (`tokens.ts`)    | Access claims, exp, iss/aud                                                     |
| Scope / MFA / ownership | `@intafaced/auth` (`guards.ts`)    | Throw AuthError codes                                                           |
| Strip + exchange        | `svc-edge` `principal-exchange.ts` | Drop client `x-intafaced-*`; verify JWT; sign principal                         |
| Service trust           | `@intafaced/contracts` `edge.ts`   | HMAC verify → `ctx.principal` or null                                           |
| tRPC                    | `@intafaced/contracts` `trpc.ts`   | `protectedProcedure` / `scopedProcedure`                                        |
| Private REST            | `svc-trade` `private-rest.ts`      | Same edge context; `requirePrincipal` + `requireScope` + jurisdiction on writes |

**Fail-closed rule (both surfaces):** no valid edge signature ⇒ `principal === null` ⇒ procedure/route refuses. There is no “half-trusted” principal (bad signature does not keep scopes).

### svc-edge `preservePath` + money APIs

- Sole `preservePath: true` upstream: `/api/v1` → `TRADE_URL`, `module: 'trade'`.
- Rationale: CCXT clients expect absolute `/api/v1/orders`, not stripped `/orders`.
- Historical footgun fixed in-table: deriving module from path string would leave `/api/v1` unkillable while `/api/trade` dies — **module is explicit data**.
- Proxy always runs `exchangePrincipal`; preservePath only changes the upstream URL path.

**Private money surface (all gated):**

| Method | Path                      | Scope / extra                                              |
| ------ | ------------------------- | ---------------------------------------------------------- |
| GET    | `/api/v1/orders/open`     | principal + trade:read (service)                           |
| GET    | `/api/v1/orders/closed`   | principal + trade:read                                     |
| GET    | `/api/v1/orders/:id`      | principal + trade:read                                     |
| POST   | `/api/v1/orders`          | principal + trade:write + jurisdiction                     |
| DELETE | `/api/v1/orders/:id`      | principal + trade:write + jurisdiction                     |
| DELETE | `/api/v1/orders`          | principal + trade:write + jurisdiction (cancelAll)         |
| GET    | `/api/v1/account/trades`  | principal + trade:read                                     |
| GET    | `/api/v1/account/fees`    | principal + trade:read                                     |
| GET    | `/api/v1/account/balance` | principal + trade:read; ledger for `principal.userId` only |
| GET    | `/api/v1/positions`       | principal + trade:read; honest `[]` until futures          |

Public `/api/v1/markets|orderbook|ticker|…` remain unauthenticated by design (not this Q).

---

## Residuals (named, complete for this batch)

1. **RES-GATEWAY-TRUST (P2)** — Platform marks delivered when owner gateway returns 2xx. A buggy gateway can drop after accept. Not fixable inside svc-notify without a second confirmation protocol; operator chooses the gateway.
2. **RES-CRASH-AFTER-2XX (P2)** — Between 2xx and settle, redelivery may re-POST if gateway ignores `idempotency-key`. Double-notify risk, not false “delivered without attempt.”
3. **Honest product gaps (info)** — No credentials ⇒ out-of-app always refuse (documented). `p2pDisputeResolved` / `p2pTradeExpired` not fanned (no user ids). Dispute open notifies opener only.

---

## Proof posture this pass

| Claim                                                 | How known                                                                     |
| ----------------------------------------------------- | ----------------------------------------------------------------------------- |
| No false delivered on unconfigured / refused / failed | Source + schema CHECK + `channels.test.ts` cases                              |
| Private REST 401 without principal                    | `requirePrincipal` + extensive `private-rest.test.ts` mount cases             |
| Edge strip + sign                                     | `principal-exchange.ts` + `principal-exchange.test.ts` (reviewed; not re-run) |
| preservePath auth parity                              | `routes.ts` + single proxy handler in `index.ts`                              |

**Not re-executed this turn:** `pnpm --filter @intafaced/svc-notify test` / `svc-trade` / `svc-edge` suites — judgments are CODE-REVIEWED against tests and source, not “I ran green now.”

---

## Bottom line

**#207 does not claim out-of-app delivery it did not achieve.** Unconfigured channels refuse on the record; critical silence is recorded; DB and claim semantics block “delivered_at without delivered.”  
**Private CCXT money REST fails closed without a real edge-signed principal** — same auth spine as tRPC, including under path-preserving `/api/v1` routing.
