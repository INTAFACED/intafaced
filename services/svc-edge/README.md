# svc-edge — the front door (§9)

Turns a bearer token into the signed principal every mounted service requires, and refuses to carry anything else a caller tried to smuggle in.

## Why it exists

`packages/contracts/src/edge.ts` verifies a signature over the principal header. **Nothing in the platform produced that signature.** The result, found by audit: every `scopedProcedure` in the OS refused every caller, because svc-identity issued a JWT that opened no door.

This service is the join between those two halves. It is the only place in the system that turns proof of identity into authority.

## API contract

| Route            | Purpose                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| `GET /health`    | liveness                                                                                          |
| `GET /ready`     | readiness + the route table, so an operator can see what will be forwarded without reading source |
| `GET /metrics`   | Prometheus scrape surface (§14.5)                                                                 |
| `ALL /api/*`     | the proxy                                                                                         |
| `OPTIONS /api/*` | CORS preflight — answered here and **never forwarded upstream**                                   |
| `/admin/*`       | operator control plane (§14.6) — **not** a CORS surface; bearer + MFA scopes                      |

### The route table

Source of truth is `src/routes.ts` (`UPSTREAMS`). `/ready` returns the prefix list plus `upstreamConfiguration` (which env vars are set — `probe: unprobed`, no URLs, never `wired`). This table must stay in lockstep.

| Prefix           | Upstream        | Env var           | Notes                                                 |
| ---------------- | --------------- | ----------------- | ----------------------------------------------------- |
| `/api/identity`  | svc-identity    | `IDENTITY_URL`    |                                                       |
| `/api/trade`     | svc-trade       | `TRADE_URL`       | tRPC trade                                            |
| `/api/v1`        | svc-trade       | `TRADE_URL`       | public CCXT REST; path preserved; module=`trade`      |
| `/api/token`     | svc-token       | `TOKEN_URL`       |                                                       |
| `/api/agents`    | svc-agents      | `AGENTS_URL`      |                                                       |
| `/api/bank`      | svc-bank        | `BANK_URL`        |                                                       |
| `/api/p2p`       | svc-p2p         | `P2P_URL`         |                                                       |
| `/api/pay`       | svc-pay         | `PAY_URL`         |                                                       |
| `/api/blueprint` | svc-blueprint   | `BLUEPRINT_URL`   |                                                       |
| `/api/protocol`  | svc-protocol    | `PROTOCOL_URL`    |                                                       |
| `/api/dex`       | svc-dex         | `DEX_URL`         |                                                       |
| `/api/indexer`   | svc-indexer     | `INDEXER_URL`     |                                                       |
| `/api/notify`    | svc-notify      | `NOTIFY_URL`      |                                                       |
| `/api/academy`   | svc-academy     | `ACADEMY_URL`     |                                                       |
| `/api/mining`    | svc-mining-pool | `MINING_POOL_URL` | PPLNS submitShare; payouts post through svc-ledger    |
| `/api/support`   | svc-support     | `SUPPORT_URL`     |                                                       |
| `/api/market`    | svc-market      | `MARKET_URL`      |                                                       |
| `/api/execution` | svc-execution   | `EXECUTION_URL`   | house tenant mechanism; module=`execution`            |
| `/api/tax`       | svc-tax         | `TAX_URL`         | lot export; module=`tax`                              |
| `/api/quant`     | svc-quant       | `QUANT_URL`       | sandboxed strategy runtime; module=`quant`            |
| `/api/campaigns` | svc-campaigns   | `CAMPAIGNS_URL`   | seasons, limited drops, TGE claim; module=`campaigns` |
| `/api/ops`       | svc-ops         | `OPS_URL`         | CRM/team/revenue/projects; module=`core-ops`          |

**`svc-ledger` and `svc-matching` are deliberately absent.** Both serve service-to-service HTTP behind a shared secret (#50, #55). No browser has business reaching either — `ledger.post` moves value on a module's own authority, which is exactly why no user token carries `ledger:write`. The ledger's **operator** surface is the durable `posting_freeze` via `/admin/ledger/*`, not a proxied `/api/ledger`. There is a test asserting ledger/matching never appear in the table.

**`svc-ws` is also not here.** The browser reaches it on its own port (`4014`); nginx `/ws` proxies straight to it. That is SOCKET §13 `socket.ws-behind-the-edge` — the edge kill-switch cannot halt market-data sockets. `/admin/status` names this under `outsideTheDoor.ws` so the console cannot show a green halt while the socket is still live.

An unlisted prefix returns **404, never a pass-through**. An edge that forwards what it does not recognise is a proxy for the entire internal network.

**`/internal/*` after a listed prefix is also 404** (`edge.s2s_not_proxied`). Pay jobs, token stake, identity rank, bank cron — those are S2S, authenticated by a secret the edge does not hold and will not forward. A 200 on that path would be a door that opened nothing useful, or worse.

**`/ready.upstreamConfiguration`** lists which prefixes have their env var set (`configured`) vs unset (`absent`). This process does not fetch upstream `/health` (`probe: unprobed`). In `staging`/`prod` an unset `PAY_URL` (etc.) refuses with **503 `edge.upstream_unwired`** — it does not silently proxy to `localhost`. `dev`/`test` keep the table's local default.

**API-key `Origin`.** `ifc_…` exchange at the door sends the real `Origin` to identity so `domain_whitelist` can fail closed. Client `x-forwarded-origin` is stripped and rewritten from `Origin` only — a stolen browser key cannot pick its own allowed origin.

**API-key product/module.** `ifc_…` exchange consumes identity's product list (#3333). A named `x-product` outside the list cannot open a session. Empty list stays grantor intersection — never invent a default product. Client `x-intafaced-product` is stripped and does not stand in.

## The security properties, and why each is shaped that way

**Reserved headers are stripped, not overwritten.** Anything under `x-intafaced-` is the edge's vocabulary, not the caller's. They are removed unconditionally _before_ any decision about whether to set our own. The difference matters on every path where we decide not to — an anonymous request, a failed verification, an expired token. Overwriting only protects the success case, which was never the one at risk.

**Region is resolved server-side.** It drives the jurisdiction matrix — which modules a caller may reach at all. A client that could set its own region would select its own regulator. Defaults to `XX`, the platform _unresolved_ sentinel — **not** a restrictive lock-down. With no matrix entry, `XX` falls through to open defaults (`regionResolved: false` on every `checkAccess` decision). Set `INTAFACED_REGION_FAIL_CLOSED=true` to refuse with `denied.region_unknown` instead.

**The bearer token is never forwarded upstream.** A service that can read a token is a service that can replay it.

**A bad session token lands as anonymous, never as an error.** A forged or expired token on a public endpoint is an ordinary event. The request reaches the service unauthenticated and `protectedProcedure` refuses it there with the right status — which is what lets a caller with an expired token still reach `auth.refresh` and recover.

**A bad API key is refused at the door, and forwarded nowhere** (`src/api-key-refusal.ts`, DV-errors-02). A key has no refresh path, and forwarded as anonymous it only drew the service's "authentication required", the same answer as sending no key, so a bot could not tell a dead key from a missing header. This is stricter than before, never looser: one less request reaches a service.

| Case                                                                                                                                                                                  | Status                 | `code`                                              | `intafacedCode`        | Decided by                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | --------------------------------------------------- | ---------------------- | --------------------------------------------------------- |
| No key at all                                                                                                                                                                         | 401                    | `AuthenticationError`                               | `auth.required`        | the service (svc-trade): only it knows a route is private |
| Key identity does not open, a restriction refuses (origin, IP, product, account, the caller's request signature), or (today) a revoked, expired or frozen-account key at the exchange | 401                    | `edge.api_key_denied`                               | `auth.api_key_denied`  | edge, on identity's verdict code                          |
| Revoked: the current-authority read names the credential revoked; at the exchange only once svc-identity's exchange names it (pending svc-identity change)                            | 401                    | `edge.api_key_revoked`                              | `auth.api_key_revoked` | edge, on identity's answer                                |
| Expired: past the `expiresAt` identity returned, or the authority read names it expired; at the exchange only once svc-identity names it                                              | 401                    | `edge.api_key_expired`                              | `auth.api_key_expired` | edge                                                      |
| Account behind the key frozen or closed: the opened key's status, the authority read's denial, or the exchange's `auth.account_frozen`                                                | 403                    | `account_frozen`                                    | `auth.account_frozen`  | svc-identity's state, reported by the edge                |
| Key without the route's scope                                                                                                                                                         | 403                    | `PermissionDenied` (trade) / tRPC `FORBIDDEN` (pay) | `scope.denied`         | edge gateway plane                                        |
| Identity cannot be asked, or refuses for a reason of the edge's own (a 404, a 400 for a body the edge built, a refusal with no verdict code)                                          | 503 + `Retry-After: 1` | `edge.authority_unavailable`                        |                        | edge                                                      |

**What fires today.** svc-identity's exchange doors look a key up only among live, unexpired rows, so a revoked or expired key is answered `auth.invalid_credentials` there and reads `edge.api_key_denied`; and a freeze revokes the account's keys before identity checks the account, so a frozen account's key reads the same. The revoked, expired and frozen mappings at the exchange are in place for the day svc-identity names them (pending svc-identity change: check the account first, then revoked, then expiry). Through the current-authority read, which runs after an exchange succeeds, all three already fire.

**Only verdict codes are key refusals.** A refused exchange counts as identity's verdict on the key only when it carries one of the verdict codes in `api-key-refusal.ts` (the key, the account, a restriction, the caller's own request signature `auth.request_*`). Anything else is the edge's own setup failing and is a retryable 503, never "your key is bad". So that a caller cannot force that 503 at will, the edge first checks the shape identity's schema accepts (key 8 to 200 characters, `ifc_` + base64url; a signed request's nonce 8 to 128, timestamp up to 32, path up to 2048, signature 64 hex) and refuses a bad shape `edge.api_key_denied` without calling identity. A failed service authentication of the edge itself is answered `auth.invalid_credentials` by identity (`assertEdgeSignedRequest`) and cannot be told apart from a wrong key here; that is svc-identity's to separate.

Restrictions are not told apart on purpose: identity answers them in the shape of a wrong key so a caller never learns which half of a credential was right, and the edge keeps that posture. `account_frozen` has no `edge.` prefix because the freeze is svc-identity's state, not a gateway policy; the edge only reports which state applies and never invents one. The scope refusal keeps its published CCXT class (renaming a published code is DV-versioning-02's deprecation process).

## Request id, server times and the error body (`src/reply-envelope.ts`)

Every reply, on every path and status, carries `x-request-id` (a random UUID per request; the edge never adopts a caller's id, `requestIdHeader: false`), `x-server-received` and `x-server-sent` (unix ms from this process's clock: arrival in the first hook, and the moment the reply is serialised; sent is never before received). The same id goes upstream as `x-request-id`, replacing anything the caller sent. Millisecond times tell an integrator how much of the latency is ours, which the round trip already bounds; they are too coarse to time a comparison.

Every JSON-object error under `/api/*` carries `requestId`, equal to the header:

- **An edge refusal** is completed into one shape: `code` (always `edge.*`, or a code the edge sends on purpose such as `account_frozen`, `PermissionDenied`, `auth.csrf_origin_required`), a human `message` beside the older `error` string (the code's catalogue sentence, else the sentence for its status; never the bare code), `docs` (`/developers/errors#<code>`, `/developers/errors/auth#<code>` for key and freeze codes, `/developers/permissions` on a scope refusal) and `requestId`.
- **A thrown error** (Fastify's error-handler shape) whose code is not `edge.*` is renamed: `edge.body_too_large`, `edge.unsupported_media_type`, else `edge.internal_error` (5xx) or `edge.request_invalid` (4xx). Its own code and message (an `ERR_INVALID_URL`, a `token.invalid`) go to the log only, the body gets the catalogue sentence, and `statusCode` is dropped.
- **A proxied service error** gains `requestId` and nothing else: the edge inserts the one field without re-serialising the body (no number is rounded) and never re-words a code, message or field list it did not decide. A body that already names a `requestId`, a tRPC batch array, non-JSON and every success reply pass untouched. The `edge.` prefix is how a client tells a gateway refusal from a service error.

The operator plane (`/admin/*`) and the probes get the headers only.

**Hop-by-hop headers are stripped, not forwarded.** The full RFC 7230 set (`connection`, `keep-alive`, `proxy-authenticate`, `proxy-authorization`, `te`, `trailer`, `transfer-encoding`, `upgrade`) plus `host` and `content-length` die in `stripReserved` before anything reaches an upstream. The edge rewrites `host`/`content-length` for the hop it owns; the rest must not be smuggled through the perimeter.

**Unauthenticated `/ready` is not a kill-switch oracle.** It reports route prefixes, screening/CORS counts, rate-limit posture, and the body budget — not `disabledModules`. The halt list is operator-only on `GET /admin/status` (`admin:write` + MFA). Publishing it on `/ready` undid the preflight ordering that exists so an unauthenticated caller cannot learn which modules are killed.

**The edge holds no database, no bus, and no `INTERNAL_SERVICE_SECRET`.** The internet-facing component should have the smallest blast radius in the fleet, and that is a property of what it is allowed to hold. Giving it the service secret would let a compromised edge call `ledger.post` directly rather than merely proxying to something that can.

## Browser origins (CORS)

Until this landed the edge sent **no CORS headers at all** — not a permissive set, none — and `apps/web/next.config.ts` declares no rewrite. So **no browser call from `apps/web` to the edge had ever succeeded.** `edge-client.ts` attaches `Authorization: Bearer …`, which is not a safelisted request header, so every tRPC call was preflighted into a bare `OPTIONS` that no upstream answers; and the unauthenticated reads that _were_ sent came back without `Access-Control-Allow-Origin`, so the browser threw the 200 away. That is the masthead's "PLATFORM UNREACHABLE", and an audit's conclusion follows from it: a fabricated landing page survived for weeks because the real data path from that app had never worked in a browser and there was nothing to compare a mock against.

**The vendored shell on `:8090` was never affected and is unchanged.** nginx proxies its `/api` same-origin, so no `Origin` header is sent and none of this applies to it. There is a test asserting a request with no `Origin` is untouched.

| Behaviour                          | Value                                                                 |
| ---------------------------------- | --------------------------------------------------------------------- |
| Allowed origins                    | `EDGE_ALLOWED_ORIGINS` — exact origins, comma-separated               |
| `Access-Control-Allow-Origin`      | the caller's own origin, echoed. **Never `*`**                        |
| `Access-Control-Allow-Credentials` | `true`, beside an exact allowlisted origin only; never with `*`       |
| `Access-Control-Allow-Methods`     | `GET, POST, OPTIONS`                                                  |
| `Access-Control-Allow-Headers`     | `authorization, content-type`                                         |
| `Access-Control-Expose-Headers`    | `x-request-id, x-server-received, x-server-sent`, allowed origin only |
| `Vary`                             | `origin`, on every answer including the ones that allow nothing       |
| Surface                            | `/api/*`, `/health`, `/ready`. **`/admin/*` is not a CORS surface**   |

**No wildcard, ever.** `*` in `EDGE_ALLOWED_ORIGINS` is a boot failure with an explanation, not a silently skipped entry.

**Three headers are exposed, and only these** (RC-developer-03). A browser on an allowed origin needs the request id to quote to support and the two server times for its clock check. They are readable on credentialed replies too (the allowed origin's answers carry `Access-Control-Allow-Credentials: true`), and that is fine: the id is a random UUID minted per request, the times are this server's clock, and none of the three is a secret, holds a cookie or token, or names an account. The allowed origin can already read the whole body of the same reply; the grant adds nothing an attacker's page could use, because a disallowed origin reads nothing at all. Not the rate-limit headers, not `x-intafaced-*`. A disallowed origin, a caller with no `Origin`, a preflight and `/admin/*` get no expose header.

**Credentials, for exact allowlisted origins only.** The refresh token rides in an httpOnly cookie, and the customer app restores a session with `credentials: 'include'` (`apps/customer/src/features/session/session-restore.ts`), so `cors.ts` answers an allowlisted origin with `Access-Control-Allow-Credentials: true` beside that exact origin, on preflights and on replies. It never pairs it with `*` (there is no path that emits `*`), a disallowed origin gets neither header, and a request with no `Origin` gets no CORS headers at all. The access token itself is still held in memory and sent as an `Authorization` header; the cookie is the refresh path only.

> **The cookie decision above bears on `svc-ws` too, and harder.** `/private/stream` (port 4014) authenticates an explicit `?access_token=` / `Authorization` bearer and deliberately performs **no `Origin` check** — correctly, today, because a token the page must fetch from its own memory is not something an attacker's page can cause a browser to send. A cookie is: browsers attach cookies to WebSocket upgrades regardless of origin, and there is no preflight and no CORS on a socket to stop them. So the day an httpOnly session cookie exists, `svc-ws` needs an origin allowlist on the private upgrade or it is cross-site-hijackable, and nothing in this repo currently records that dependency. It is its own piece of work in its own service; it is noted here because this is where the decision that triggers it gets made.

**`OPTIONS` is terminated at the edge and never proxied.** A preflight is unauthenticated by necessity — the browser sends it before it will send the `Authorization` header — so it is the one request that reaches us with no principal, and the only safe amount to forward is zero. Two properties follow: it cannot reach anything that mutates, and it cannot be used to probe which routes exist, because the answer is computed from `Origin` alone before the route table is consulted. A preflight to `/api/trade/…` and one to `/api/does-not-exist` are byte-identical. It also runs **before** the kill-switch guard, so an unauthenticated caller cannot read off which modules an operator has halted.

**Refusals carry the headers too.** A 404, a kill-switch 503, a 502 from a dead upstream — all of them are readable by an allowed origin. A refusal the browser discards is reported in devtools as a CORS error, so without this the operator who halted a module would watch the UI say "unreachable" instead of "switched off by the operator".

**`dev` is frictionless, `staging`/`prod` are explicit.** With nothing configured, `dev`/`test` fall back to `http://localhost:3100` / `http://127.0.0.1:3100` (`apps/admin`, both loopback spellings). `staging` and `prod` get no default. **The :3000 pair is gone**, taken with `apps/web` in its deletion commit as the note here required: left behind, those two entries would have handed a standing cross-origin grant to whatever a developer next starts on the most commonly squatted port on a workstation. Do not re-add either spelling for a dev convenience — set `EDGE_ALLOWED_ORIGINS`. The product shell on `:8090` needs no entry: nginx serves it same-origin and proxies `/api` by service name, so its browser never makes a cross-origin request. See the `DEV_ORIGINS` note in `src/cors.ts`.

**An enforced environment with no configured origins serves a closed door — it does not refuse to boot**, and that is a deliberate departure from `assertScreeningConfigured` and `assertRailPosture`. Those refuse because their unconfigured state is silently _permissive_ and dishonest: an unscreened process clears every region and reports it as screened. An unconfigured origin list is the opposite on both counts — silently _restrictive_, and loud in the console of the person affected. Nobody is told anything untrue. And the edge is the front door for callers who need no CORS at all (the `:8090` shell, the CCXT REST contract, every server-to-server integration, `/health`), so refusing to boot would trade a browser-only outage for a total one. Instead it logs at ERROR and reports on `/ready`. A **misconfigured** list is the other case, and that _does_ refuse to boot.

### Proving it

`src/cors.test.ts` covers the policy against Fastify's own pipeline; `src/cors.browser.e2e.test.ts` drives **real Chromium** against a real socket, because nothing on the server enforces CORS — a browser does, and a suite that only asserts header strings is asserting that we wrote the right sentence, not that anything obeys it. Its load-bearing assertion is that a disallowed origin's POST is **never put on the wire**, checked against the edge's own record of what arrived; its sibling guard asserts that a blocked _read_ did arrive, so a `fetch` rejection cannot be a shut port masquerading as a CORS refusal. The browser suite skips loudly when no Chromium binary is present (`pnpm exec playwright install chromium`).

## Events

**None.** This service publishes and consumes nothing. It owns no data.

## Ledger recipes used

**None.** No value moves through the edge. It is a request-shaping component; the money paths live behind it.

## Kill-switch

**Live control is the operator surface, not the `edge.gateway` flag.**

| Surface                                                                                           | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /admin/kill-switches`                                                                       | Per-module halt (`admin:write` + MFA + distinct `confirmOperatorId`). Missing/same confirm refuses `missing_operator` — one operator cannot kill or resume. Reads and cancels still pass; new commitments return `503 edge.module_killed`.                                                                                                                                                                                                                                                                                                                                  |
| `GET /admin/status`                                                                               | Who is killed, **what cannot be killed** (`outsideTheDoor`), **kill durability** (`killState` — process-local; `multiReplicaShared: false`), **`flagEdgeGateway.enforced: false`**, plus **ops honesty**: `region` (resolved source + trusted-header posture), `networkSignal` (unset≠clear; **enforced on `/api` when fail-closed**), `freezeAuthority` (only `ledger.posting`; invent trade/pay freeze refused), `complianceQueue` (empty-safe; partner absent named), `analytics` (warehouse dark/unavailable; ETL watermark `absent`; never live cubes without lag).    |
| `GET /admin/compliance/queue`                                                                     | In-memory screening/review queue snapshot — honest empty; no invent cases; includes `recentAudit` of dispositions. Full durable case product residual.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `POST /admin/compliance/queue/open`                                                               | Open a case explicitly (`id` + `kind` + `subjectId`). Never auto-invented.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `POST /admin/compliance/queue/disposition`                                                        | Dispose a case. Audit attribution comes from the verified operator token, never a caller-supplied actor. `partner_cleared` **refuses** when screening partner absent (`409 refuse.partner_absent`).                                                                                                                                                                                                                                                                                                                                                                         |
| `GET /admin/analytics/warehouse`                                                                  | Warehouse door for operators — dark/unavailable; writer URLs refuse; `etlWatermark: absent`; never live cubes without lag probe.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `POST /admin/ledger/freeze`                                                                       | Money-plane halt (`admin:treasury`) — durable row on svc-ledger, not an in-memory module flag.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `GET /admin/ledger/transactions/:txId`, `GET /admin/ledger/trace?businessKey=`                    | Ledger object lookup (a founder's `admin:read` with a second factor on a live session, owner decision 2026-10-23): forwarded with the operator's own token to svc-ledger, which records the lookup before it reads. A malformed id or key refuses here with `edge.invalid_ledger_lookup` and calls nothing.                                                                                                                                                                                                                                                                 |
| `GET /admin/ledger/transactions`, `GET /admin/ledger/accounts?prefix=`, `GET /admin/ledger/stats` | Ledger desk reads (OPS-ledger-desk-01), on the lookups' authority: the transaction list (`assetId`, `from`, `to`, `before`), the account address search (`prefix`, `after`) and the book's counts. Forwarded with the operator's own token; only each read's named query keys go through, each one value of at most 256 characters, else `edge.invalid_ledger_lookup` and nothing is called. svc-ledger checks the values and records the list and the search before it reads.                                                                                              |
| `GET /admin/ledger/accounts/:accountId/metadata`, `POST …/metadata/set`, `POST …/metadata/delete` | An account's operator metadata (J-ops-console-03 #6, #7). The read is on the lookups' authority with the operator's own token; the set and the delete are treasury writes. The path is built from a checked account UUID and only the named fields go through (set: `key`, `value`, `reason`, `revision`; delete: `key`, `reason`, `revision`, `approvalId`, `operationId`), else `edge.invalid_account_metadata` and nothing is called. svc-ledger spends a delete's approval and refuses both writes `ledger.frozen` under the posting freeze; its answer passes through. |
| `GET/POST /admin/ledger/reconciliation/controls`, `POST .../update`, `POST .../run`               | Operator reconciliation controls (OPS-reconciliation-01): list is `admin:treasury` with a second factor or `admin:compliance`; define, update and run are `admin:treasury` with a second factor on a live session, and run also carries a two-person identity approval that svc-ledger consumes. Forwarded with the operator's own token. A body the contract refuses answers 400 `edge.invalid_reconciliation_control` here and calls nothing.                                                                                                                             |

`edge.gateway` in `FLAG_REGISTRY` is **`NOT_ENFORCED`**. Flipping that flag does **not** take the proxy down. Do not operate as if it does. The real kill is `/admin/kill-switches` + the `onRequest` guard in `control-plane.ts`.

**Outside the door (cannot arm here):** `ws` (SOCKET §13 `socket.ws-behind-the-edge`), `ledger` (use `/admin/ledger/freeze`), `matching` (halt `trade` for new risk). Arming these returns **400** with the reason — never a green 200 that refuses nothing.

**Durability:** optional `EDGE_KILL_STATE_PATH` file = single-process restart durability. Multi-replica shared store is SOCKET §13 residual and is **not invented** here. `/admin/status.killState` says so out loud.

`/health` and `/ready` keep answering under kills so the process stays probeable and cancels/reads stay reachable through the same door.

## Transport hardening (built)

| Control          | Where                                  | Honesty                                                                                                                                                                                                                                                                                               |
| ---------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Security headers | `src/hardening.ts` (`@fastify/helmet`) | Always on.                                                                                                                                                                                                                                                                                            |
| Rate limit       | same file (`@fastify/rate-limit`)      | Per-replica in-process counters. Keyed on `req.ip`. Without `EDGE_TRUST_PROXY` behind a balancer, every caller shares one bucket — boot log warns. `OPTIONS`/`/health`/`/ready` unthrottled. **`/ready.rateLimit`** reports armed budget + `multiReplicaShared: false` (never invent a shared store). |

## Configuration

| Variable                               | Notes                                                                                                                                                                                                                           |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JWT_ACCESS_SECRET`                    | **must match svc-identity's.** A mismatch means every login succeeds and every request after it is anonymous — which presents as "logged in but nothing works".                                                                 |
| `EDGE_PRINCIPAL_SECRET`                | must match every mounted service's                                                                                                                                                                                              |
| `EDGE_PRINCIPAL_PRIVATE_KEY`           | optional. Ed25519 signing key (PKCS8, base64url), held by the edge alone. Unset: the shared secret signs. Set it only once every receiver verifies with the public key. Needs the next setting.                                 |
| `EDGE_PRINCIPAL_MAX_LIFETIME_SECONDS`  | 1 to 300, no default. How long a signed principal lives. Required with the signing key; setting one without the other refuses boot.                                                                                             |
| `DEFAULT_REGION`                       | two-letter code; `XX` = unresolved sentinel (open defaults + `regionResolved: false`, not a lock-down)                                                                                                                          |
| `INTAFACED_REGION_FAIL_CLOSED`         | process-wide; when `true`/`1`/`yes`/`on`, `checkAccess` refuses unresolved (`XX`) with `denied.region_unknown`. Default off.                                                                                                    |
| `UPSTREAM_TIMEOUT_MS`                  | a hung service must not hold an edge connection open                                                                                                                                                                            |
| `EDGE_AUTHORITY_STRICT_TIMEOUT_MS`     | cap (default 3000 ms) on the per-request identity read for writes and money, security and identity modules. If identity cannot answer, the request gets 503 `edge.authority_unavailable` (with `Retry-After`) and nothing runs. |
| `EDGE_AUTHORITY_READ_TIMEOUT_MS`       | higher cap (default 8000 ms) for GET/HEAD to non-money modules only (academy, blueprint, indexer, quant, support, tax, notify)                                                                                                  |
| `EDGE_AUTHORITY_POSITIVE_CACHE_MS`     | reuse of a positive answer for the same session, at most 1000 ms (identity's revocation lease is 5000 ms); a refusal is never cached                                                                                            |
| `EDGE_ALLOWED_ORIGINS`                 | browser origins, comma-separated and exact. **Required in `staging`/`prod`** — unset there is a closed door to every front-end. `*` is a boot failure.                                                                          |
| `EDGE_RATE_LIMIT_ENABLED`              | throttle on/off (see `env.ts` defaults)                                                                                                                                                                                         |
| `EDGE_RATE_LIMIT_MAX` / `_WINDOW_MS`   | per-replica budget when enabled. Pair: both required (blank refuses boot, never 300 / never 60000). Owner may set 300 and 60000.                                                                                                |
| `EDGE_TRUST_PROXY`                     | when set, Fastify trusts proxy headers for `req.ip` (rate-limit key) **and** trusted geo header reads. Unset behind nginx = one shared bucket — boot WARN.                                                                      |
| `EDGE_GEO_COUNTRY_HEADER`              | optional trusted geo header name (e.g. `cf-ipcountry`). Requires `EDGE_TRUST_PROXY`. Missing/invalid → unresolved `XX`. No vendor invent.                                                                                       |
| `INTAFACED_NETWORK_SIGNAL_CONFIGURED`  | partner slot claimed (not a vendor name). Without it, signal stays `unset`.                                                                                                                                                     |
| `INTAFACED_NETWORK_SIGNAL_FAIL_CLOSED` | when armed, `/api/*` refuses `unset`/`dark` with `edge.network_*` codes. Default off.                                                                                                                                           |
| `EDGE_BODY_LIMIT_BYTES`                | max request body the edge will parse. Required (blank refuses boot, never 1048576). Owner may set 1048576. Oversize → 413 before principal exchange or upstream work.                                                           |
| `EDGE_KILL_STATE_PATH`                 | JSON path for single-process kill restart durability. Empty = memory only. **Not** multi-replica share.                                                                                                                         |
| `LEDGER_URL`                           | optional; operator freeze surface. Unset → `/admin/status.ledgerConfigured: false`.                                                                                                                                             |

Authenticated forwarding now checks current identity authority on every request with the dedicated `IDENTITY_OWNERSHIP_SECRET`, matching identity's `IDENTITY_EDGE_AUTHORITY_SECRET`. It never substitutes the generic internal service secret, a WebSocket read key or an owner money-admission key. Missing configuration, a revoked or expired credential, unavailable identity or a response beyond the bounded three-second read refuses authenticated forwarding. Anonymous public enquiry routes remain reachable. The check covers the response body, avoids cached responses and redirects, and binds the original user/credential/subaccount. API keys additionally use current owner, expiry, IP, origin, product and account restrictions; the route determines the product. Identity's current KYC tier replaces the token's older tier. Ordinary interactive TOTP sessions can use the platform; existing explicit passkey and money-admission policies retain their own gates.

## Service keys: outgoing calls

With `S2S_AUTH_MODE` set to `dual` or `keypair` (plus `S2S_KEYRING`, `S2S_SIGNING_KID` and `S2S_SIGNING_KEY`, the edge's own key), svc-edge signs the service calls it makes with that key instead of hand-signing them with a shared secret:

| Call                                                                                                                                                   | Callee         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------- |
| Current-authority read, API-key ownership, account status, session ownership, passkey read, API-key exchange attestation (`IDENTITY_OWNERSHIP_SECRET`) | `svc-identity` |
| Operator controls and reads (`MATCHING_EDGE_SIGNING_SECRET`)                                                                                           | `svc-matching` |
| The proxy forward, for the module behind each `/api/*` prefix                                                                                          | that service   |

The signature binds the method, the path and query as sent, the exact body bytes and the content type. On the proxy forward the forwarded principal, its signature and the region are inside the signed context too. `dual` also sends the dedicated shared secret on the identity and matching calls; `keypair` sends the key only. The edge holds no shared secret for the other upstreams, so the proxy forward carries the key signature alone in both modes. The modules blueprint, dex, indexer and protocol have no service role and are forwarded unsigned. Unset `S2S_AUTH_MODE` leaves every call exactly as before (the shared secret). Browsers cannot supply these headers: every `x-intafaced-*` request header is stripped.

## Not built yet

- **Full geo topology + CDN contract.** Mechanism: trusted header + trustProxy (`EDGE_GEO_COUNTRY_HEADER`). Still needs deployment topology proof (socket.geo-region-resolution residual) and Class X counsel list content.
- **VPN/Tor partner product + live probe adapter.** Fail-closed on `/api` is wired; partner procurement + request-time probe remain Class X — no vendor invent here.
- **Full compliance case-management product.** Open + disposition + process-local audit is mechanism; durable UI/DB/SLA residual.
- **Analytics ETL/lag probe process.** Door names dark/unavailable + `etlWatermark: absent`; physical replica probe + cube jobs stay residual (contracts Stage-1).
- **Streaming / WebSocket proxying.** The proxy buffers with `response.text()`, so this is not a path for websockets or large downloads. Market-data sockets stay on `svc-ws` (see outside-the-door).
- **Multi-replica shared kill store.** Process-local file or memory only. SOCKET §13 residual — inventing Redis/etc. without product law is fenced.
- **§13 refresh-token in httpOnly cookie.** When that lands, CORS credentials + `svc-ws` origin check must be re-taken deliberately (see Browser origins). Named residual, not fake done.
- **`edge.gateway` flag enforcement.** Still `NOT_ENFORCED` in the registry; do not claim it gates traffic until a deliberate enforcement PR.

### When identity cannot be asked

The per-request authority read has two different failures. Identity answering "not eligible / revoked" is a refusal: the request goes on as anonymous and the service answers 401, as before. Identity not answering (timeout, network error, 5xx, 408, 429, malformed answer) is not a sign-out: the edge answers 503 `edge.authority_unavailable` with `Retry-After: 1` and does not forward the request. Clients keep the session and retry; only a 401 ends it. Concurrent requests of one session share a single in-flight read, never across sessions.
