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

| Prefix           | Upstream        | Env var           | Notes                                              |
| ---------------- | --------------- | ----------------- | -------------------------------------------------- |
| `/api/identity`  | svc-identity    | `IDENTITY_URL`    |                                                    |
| `/api/trade`     | svc-trade       | `TRADE_URL`       | tRPC trade                                         |
| `/api/v1`        | svc-trade       | `TRADE_URL`       | public CCXT REST; path preserved; module=`trade`   |
| `/api/token`     | svc-token       | `TOKEN_URL`       |                                                    |
| `/api/agents`    | svc-agents      | `AGENTS_URL`      |                                                    |
| `/api/bank`      | svc-bank        | `BANK_URL`        |                                                    |
| `/api/p2p`       | svc-p2p         | `P2P_URL`         |                                                    |
| `/api/pay`       | svc-pay         | `PAY_URL`         |                                                    |
| `/api/blueprint` | svc-blueprint   | `BLUEPRINT_URL`   |                                                    |
| `/api/protocol`  | svc-protocol    | `PROTOCOL_URL`    |                                                    |
| `/api/dex`       | svc-dex         | `DEX_URL`         |                                                    |
| `/api/indexer`   | svc-indexer     | `INDEXER_URL`     |                                                    |
| `/api/notify`    | svc-notify      | `NOTIFY_URL`      |                                                    |
| `/api/academy`   | svc-academy     | `ACADEMY_URL`     |                                                    |
| `/api/mining`    | svc-mining-pool | `MINING_POOL_URL` | PPLNS submitShare; payouts post through svc-ledger |
| `/api/support`   | svc-support     | `SUPPORT_URL`     |                                                    |
| `/api/market`    | svc-market      | `MARKET_URL`      |                                                    |
| `/api/execution` | svc-execution   | `EXECUTION_URL`   | house tenant mechanism; module=`execution`         |
| `/api/tax`       | svc-tax         | `TAX_URL`         | lot export; module=`tax`                           |
| `/api/quant`     | svc-quant       | `QUANT_URL`       | sandboxed strategy runtime; module=`quant`         |
| `/api/ops`       | svc-ops         | `OPS_URL`         | CRM/team/revenue/projects; module=`core-ops`       |

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

**A bad token lands as anonymous, never as an error.** A forged or expired token on a public endpoint is an ordinary event. The request reaches the service unauthenticated and `protectedProcedure` refuses it there with the right status — which is what lets a caller with an expired token still reach `auth.refresh` and recover.

**Hop-by-hop headers are stripped, not forwarded.** The full RFC 7230 set (`connection`, `keep-alive`, `proxy-authenticate`, `proxy-authorization`, `te`, `trailer`, `transfer-encoding`, `upgrade`) plus `host` and `content-length` die in `stripReserved` before anything reaches an upstream. The edge rewrites `host`/`content-length` for the hop it owns; the rest must not be smuggled through the perimeter.

**Unauthenticated `/ready` is not a kill-switch oracle.** It reports route prefixes, screening/CORS counts, rate-limit posture, and the body budget — not `disabledModules`. The halt list is operator-only on `GET /admin/status` (`admin:write` + MFA). Publishing it on `/ready` undid the preflight ordering that exists so an unauthenticated caller cannot learn which modules are killed.

**The edge holds no database, no bus, and no `INTERNAL_SERVICE_SECRET`.** The internet-facing component should have the smallest blast radius in the fleet, and that is a property of what it is allowed to hold. Giving it the service secret would let a compromised edge call `ledger.post` directly rather than merely proxying to something that can.

## Browser origins (CORS)

Until this landed the edge sent **no CORS headers at all** — not a permissive set, none — and `apps/web/next.config.ts` declares no rewrite. So **no browser call from `apps/web` to the edge had ever succeeded.** `edge-client.ts` attaches `Authorization: Bearer …`, which is not a safelisted request header, so every tRPC call was preflighted into a bare `OPTIONS` that no upstream answers; and the unauthenticated reads that _were_ sent came back without `Access-Control-Allow-Origin`, so the browser threw the 200 away. That is the masthead's "PLATFORM UNREACHABLE", and an audit's conclusion follows from it: a fabricated landing page survived for weeks because the real data path from that app had never worked in a browser and there was nothing to compare a mock against.

**The vendored shell on `:8090` was never affected and is unchanged.** nginx proxies its `/api` same-origin, so no `Origin` header is sent and none of this applies to it. There is a test asserting a request with no `Origin` is untouched.

| Behaviour                          | Value                                                               |
| ---------------------------------- | ------------------------------------------------------------------- |
| Allowed origins                    | `EDGE_ALLOWED_ORIGINS` — exact origins, comma-separated             |
| `Access-Control-Allow-Origin`      | the caller's own origin, echoed. **Never `*`**                      |
| `Access-Control-Allow-Credentials` | **never emitted** — our front-ends send no cookies                  |
| `Access-Control-Allow-Methods`     | `GET, POST, OPTIONS`                                                |
| `Access-Control-Allow-Headers`     | `authorization, content-type`                                       |
| `Access-Control-Expose-Headers`    | unset                                                               |
| `Vary`                             | `origin`, on every answer including the ones that allow nothing     |
| Surface                            | `/api/*`, `/health`, `/ready`. **`/admin/*` is not a CORS surface** |

**No wildcard, ever.** `*` in `EDGE_ALLOWED_ORIGINS` is a boot failure with an explanation, not a silently skipped entry.

**No credentials, deliberately.** `apps/web` holds the access token in memory (`providers.tsx` — explicitly not `localStorage`, explicitly not a cookie) and sends it as an `Authorization` header. There is no `credentials: 'include'` anywhere in `apps/`. Announcing credentials support would describe a mechanism we do not use, and a credentialed response may never carry `*` — we emit neither, so the forbidden pair cannot arise. **When the §13 refresh-token-in-an-httpOnly-cookie socket lands, this decision must be re-taken deliberately**: a cookie is ambient, and every request here becomes credentialed the day it exists.

> **The same cookie decision lands in `svc-ws` too, and harder.** `/private/stream` (port 4014) authenticates an explicit `?access_token=` / `Authorization` bearer and deliberately performs **no `Origin` check** — correctly, today, because a token the page must fetch from its own memory is not something an attacker's page can cause a browser to send. A cookie is: browsers attach cookies to WebSocket upgrades regardless of origin, and there is no preflight and no CORS on a socket to stop them. So the day an httpOnly session cookie exists, `svc-ws` needs an origin allowlist on the private upgrade or it is cross-site-hijackable, and nothing in this repo currently records that dependency. It is its own piece of work in its own service; it is noted here because this is where the decision that triggers it gets made.

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

| Surface                                    | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /admin/kill-switches`                | Per-module halt (`admin:write` + MFA + distinct `confirmOperatorId`). Missing/same confirm refuses `missing_operator` — one operator cannot kill or resume. Reads and cancels still pass; new commitments return `503 edge.module_killed`.                                                                                                                                                                                                                                                                                                                               |
| `GET /admin/status`                        | Who is killed, **what cannot be killed** (`outsideTheDoor`), **kill durability** (`killState` — process-local; `multiReplicaShared: false`), **`flagEdgeGateway.enforced: false`**, plus **ops honesty**: `region` (resolved source + trusted-header posture), `networkSignal` (unset≠clear; **enforced on `/api` when fail-closed**), `freezeAuthority` (only `ledger.posting`; invent trade/pay freeze refused), `complianceQueue` (empty-safe; partner absent named), `analytics` (warehouse dark/unavailable; ETL watermark `absent`; never live cubes without lag). |
| `GET /admin/compliance/queue`              | In-memory screening/review queue snapshot — honest empty; no invent cases; includes `recentAudit` of dispositions. Full durable case product residual.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `POST /admin/compliance/queue/open`        | Open a case explicitly (`id` + `kind` + `subjectId`). Never auto-invented.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `POST /admin/compliance/queue/disposition` | Dispose a case. Audit attribution comes from the verified operator token, never a caller-supplied actor. `partner_cleared` **refuses** when screening partner absent (`409 refuse.partner_absent`).                                                                                                                                                                                                                                                                                                                                                                      |
| `GET /admin/analytics/warehouse`           | Warehouse door for operators — dark/unavailable; writer URLs refuse; `etlWatermark: absent`; never live cubes without lag probe.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `POST /admin/ledger/freeze`                | Money-plane halt (`admin:treasury`) — durable row on svc-ledger, not an in-memory module flag.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

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

| Variable                               | Notes                                                                                                                                                                 |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JWT_ACCESS_SECRET`                    | **must match svc-identity's.** A mismatch means every login succeeds and every request after it is anonymous — which presents as "logged in but nothing works".       |
| `EDGE_PRINCIPAL_SECRET`                | must match every mounted service's                                                                                                                                    |
| `DEFAULT_REGION`                       | two-letter code; `XX` = unresolved sentinel (open defaults + `regionResolved: false`, not a lock-down)                                                                |
| `INTAFACED_REGION_FAIL_CLOSED`         | process-wide; when `true`/`1`/`yes`/`on`, `checkAccess` refuses unresolved (`XX`) with `denied.region_unknown`. Default off.                                          |
| `UPSTREAM_TIMEOUT_MS`                  | a hung service must not hold an edge connection open                                                                                                                  |
| `EDGE_ALLOWED_ORIGINS`                 | browser origins, comma-separated and exact. **Required in `staging`/`prod`** — unset there is a closed door to every front-end. `*` is a boot failure.                |
| `EDGE_RATE_LIMIT_ENABLED`              | throttle on/off (see `env.ts` defaults)                                                                                                                               |
| `EDGE_RATE_LIMIT_MAX` / `_WINDOW_MS`   | per-replica budget when enabled. Pair: both required (blank refuses boot, never 300 / never 60000). Owner may set 300 and 60000.                                      |
| `EDGE_TRUST_PROXY`                     | when set, Fastify trusts proxy headers for `req.ip` (rate-limit key) **and** trusted geo header reads. Unset behind nginx = one shared bucket — boot WARN.            |
| `EDGE_GEO_COUNTRY_HEADER`              | optional trusted geo header name (e.g. `cf-ipcountry`). Requires `EDGE_TRUST_PROXY`. Missing/invalid → unresolved `XX`. No vendor invent.                             |
| `INTAFACED_NETWORK_SIGNAL_CONFIGURED`  | partner slot claimed (not a vendor name). Without it, signal stays `unset`.                                                                                           |
| `INTAFACED_NETWORK_SIGNAL_FAIL_CLOSED` | when armed, `/api/*` refuses `unset`/`dark` with `edge.network_*` codes. Default off.                                                                                 |
| `EDGE_BODY_LIMIT_BYTES`                | max request body the edge will parse. Required (blank refuses boot, never 1048576). Owner may set 1048576. Oversize → 413 before principal exchange or upstream work. |
| `EDGE_KILL_STATE_PATH`                 | JSON path for single-process kill restart durability. Empty = memory only. **Not** multi-replica share.                                                               |
| `LEDGER_URL`                           | optional; operator freeze surface. Unset → `/admin/status.ledgerConfigured: false`.                                                                                   |

Authenticated forwarding now checks current identity authority on every request with the dedicated `IDENTITY_OWNERSHIP_SECRET`, matching identity's `IDENTITY_EDGE_AUTHORITY_SECRET`. It never substitutes the generic internal service secret, a WebSocket read key or an owner money-admission key. Missing configuration, a revoked or expired credential, unavailable identity or a response beyond the bounded three-second read refuses authenticated forwarding. Anonymous public enquiry routes remain reachable. The check covers the response body, avoids cached responses and redirects, and binds the original user/credential/subaccount. API keys additionally use current owner, expiry, IP, origin, product and account restrictions; the route determines the product. Identity's current KYC tier replaces the token's older tier. Ordinary interactive TOTP sessions can use the platform; existing explicit passkey and money-admission policies retain their own gates.

## Not built yet

- **Full geo topology + CDN contract.** Mechanism: trusted header + trustProxy (`EDGE_GEO_COUNTRY_HEADER`). Still needs deployment topology proof (socket.geo-region-resolution residual) and Class X counsel list content.
- **VPN/Tor partner product + live probe adapter.** Fail-closed on `/api` is wired; partner procurement + request-time probe remain Class X — no vendor invent here.
- **Full compliance case-management product.** Open + disposition + process-local audit is mechanism; durable UI/DB/SLA residual.
- **Analytics ETL/lag probe process.** Door names dark/unavailable + `etlWatermark: absent`; physical replica probe + cube jobs stay residual (contracts Stage-1).
- **Streaming / WebSocket proxying.** The proxy buffers with `response.text()`, so this is not a path for websockets or large downloads. Market-data sockets stay on `svc-ws` (see outside-the-door).
- **Multi-replica shared kill store.** Process-local file or memory only. SOCKET §13 residual — inventing Redis/etc. without product law is fenced.
- **§13 refresh-token in httpOnly cookie.** When that lands, CORS credentials + `svc-ws` origin check must be re-taken deliberately (see Browser origins). Named residual, not fake done.
- **`edge.gateway` flag enforcement.** Still `NOT_ENFORCED` in the registry; do not claim it gates traffic until a deliberate enforcement PR.
