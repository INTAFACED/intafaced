# Edge CORS production posture (D26-P3-07)

**Status:** staging/prod **origin contract**, documented. Not a code change.  
**Board:** D26-P3-07 — Class **Deploy**. This PR is Class **N** (docs).  
**Leverage:** Phase A IN — existing `services/svc-edge` CORS module. Named, not rebuilt. No second SPA.  
**Do not invent hostnames.** Do not flip Class X (host purchase, DNS, live origin values).  
**Do not edit `services/svc-edge`.** Open edge PRs (including [#2001](https://github.com/Phantom-X-007/intafaced/pull/2001)) stay on their own files.

_Board-Delta: D26-P3-07 — tip ops contract for edge CORS: code path named; staging/prod closed door when origins unset; Class X host/domain residual named, not filled._

---

## 1 · Code path (read-only)

| Piece                                                                                            | Where                                                                                                       |
| ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| Policy + allowlist + hook                                                                        | `services/svc-edge/src/cors.ts`                                                                             |
| Boot: `edgeOriginAllowlist()` then `registerCors(app, cors)` **before** kill-switch / rate-limit | `services/svc-edge/src/index.ts`                                                                            |
| Proofs                                                                                           | `services/svc-edge/src/cors.test.ts` (+ Chromium e2e `cors.browser.e2e.test.ts` when Playwright is present) |
| Operator notes (same facts)                                                                      | `services/svc-edge/README.md` § Browser origins                                                             |
| Env comment                                                                                      | `.env.example` (`EDGE_ALLOWED_ORIGINS`)                                                                     |

There is **no** `@fastify/cors`. The hook is hand-rolled. Fastify `onRequest` registration order is the control: preflight is answered before kill-switch, so an unauthenticated `OPTIONS` cannot be a module-halt oracle.

**Not this mountain:** vendored Java `CORS_ALLOWED_ORIGINS` / `CorsAllowlist.java` (session-cookie shell). Different variable, different posture. Do not merge the two names.

---

## 2 · Staging vs prod contract (what the code actually does)

`CORS_ENFORCED_ENVS` is exactly `staging` and `prod`. `APP_ENV` is the switch. There is **no** wildcard grant in this module.

| `APP_ENV`               | `EDGE_ALLOWED_ORIGINS`                           | Browser cross-origin grant                                         | Process boot                                               |
| ----------------------- | ------------------------------------------------ | ------------------------------------------------------------------ | ---------------------------------------------------------- |
| `dev` / `test` / unset  | empty                                            | Dev default only: `http://localhost:3100`, `http://127.0.0.1:3100` | Starts                                                     |
| `dev` / `test`          | set (valid)                                      | **Exactly** that list (replaces the default; does not union it)    | Starts                                                     |
| **`staging` or `prod`** | empty / unset                                    | **Closed door** — `origins: []`, no `Access-Control-Allow-Origin`  | **Starts** (ERROR log + `/ready` `cors.configured: false`) |
| **`staging` or `prod`** | set (valid)                                      | **Exactly** those origins, echoed, never `*`                       | Starts                                                     |
| Any                     | `*` / `null` / trailing slash / path / duplicate | —                                                                  | **Refuses to boot** (`OriginListError`)                    |

### Fail-closed — say it truthfully

- **Browser fail-closed when `APP_ENV` is `staging`/`prod` and origins are unset:** yes. Empty allowlist. The browser drops the response. Same-origin `:8090` shell (nginx proxies `/api`), CCXT/bots with no `Origin`, and `/health` keep working.
- **Process fail-closed on unset:** **no.** Unset is a closed door, not a boot refusal. Screening/rail posture **do** refuse to boot when unconfigured because those failures are silently _permissive_. CORS unset is silently _restrictive_, so the edge stays up for callers that need no CORS.
- **Process fail-closed on a bad list:** **yes.** A wildcard or malformed origin is a boot failure in every environment.

### Wildcard vs explicit

- **Never `*`.** `parseOriginList` treats `*` as an issue and throws. There is no code path that emits `Access-Control-Allow-Origin: *`.
- **Explicit origins only:** `scheme://host[:port]`, http or https, no path, no trailing slash, no userinfo. Comma-separated.

### Credentials

The edge **never** emits `Access-Control-Allow-Credentials`. Callers send `Authorization: Bearer …` (not cookies). A credentialed response plus a wildcard is the CORS spec’s forbidden pair; this module makes **neither**.

When (if) the §13 refresh-token **httpOnly cookie** lands, credentials + `svc-ws` origin check must be **re-taken in code** — named residual in `cors.ts` / edge README, not this docs mountain.

### Surface and methods (browser)

- CORS surface: `/api`, `/api/*`, `/health`, `/ready`. **`/admin/*` is not a CORS surface.**
- Advertised methods: `GET, POST, OPTIONS`. `OPTIONS` is terminated at the edge and **never proxied**.
- `DELETE`/`PUT`/`PATCH` are not CORS-allowed. The proxy may still forward `DELETE` for non-browser clients that send no `Origin`.
- `Vary: Origin` on every CORS-surface answer (including refusals).

`/ready` reports `{ configured, allowedOrigins: <count> }` — a count, never the origin strings.

### Product shell vs cross-origin SPA

The vendored shell on `:8090` is **same-origin** through nginx. It does not need an `EDGE_ALLOWED_ORIGINS` entry. Listing `:8090` would grant a **cross-origin** capability the shell does not use. Do not add it “just in case.”

---

## 3 · Deploy wiring truth (still not hostnames)

`docker-compose.apps.yml` `svc-edge` environment **does not pass `EDGE_ALLOWED_ORIGINS` today.** `.env` can hold the comment; compose will not inject the variable unless a later deploy PR adds a pass-through (or Kubernetes sets the env). Staging workflow (`.github/workflows/staging-deploy.yml`) forces `APP_ENV=staging` and does **not** set origins.

Consequence: a compose/staging box with `APP_ENV=staging` and no injected list is the **closed door** the code already implements. That is safe. It is not a production SPA grant.

---

## 4 · Residual tickets (Nitro Class X — host / domain)

These are **not** agent-done. Do not invent values in git.

| Ticket                                                 | Owner                                                                | What “done” looks like                                                                                                                            |
| ------------------------------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Staging host + DNS**                                 | Nitro Class **X** (ADR `docs/adr/2026-08-08-staging-deploy-path.md`) | Host exists. This ADR does not buy one.                                                                                                           |
| **Production domain(s)**                               | Nitro Class **X**                                                    | Real HTTPS origins of any **cross-origin** browser UI that will call the edge. Empty list is valid if only the same-origin shell talks to `/api`. |
| **Set `EDGE_ALLOWED_ORIGINS` on the hosted edge**      | Nitro / deploy (Class X values; wiring is ops)                       | Exact `https://…` strings, no `*`. Confirm boot log + `/ready` `configured: true` and the expected count.                                         |
| **Compose/k8s pass-through of `EDGE_ALLOWED_ORIGINS`** | later ops PR, not this file                                          | Until then, setting the var only in an un-interpolated `.env` does not reach the container.                                                       |
| **§13 cookie re-take**                                 | future code (not D26-P3-07)                                          | `cors.ts` credentials + `svc-ws` Origin check. Parked.                                                                                            |

Sibling open PRs (do not dual-edit): [#2001](https://github.com/Phantom-X-007/intafaced/pull/2001) (`services/svc-edge/**` quant door). [#2008](https://github.com/Phantom-X-007/intafaced/pull/2008) is an earlier D26-P3-07 draft under `docs/CORS-PRODUCTION-POSTURE.md` plus a threat-model pointer — this file is the ops-home contract; do not merge both as two laws.

---

## 5 · Done-bar for D26-P3-07

- Code path in `svc-edge` is named (read-only).
- Staging/prod: explicit origins or closed door; no wildcard; no credentials; unset does **not** refuse boot.
- Class X host/domain tickets are named. No hostname invented. No Class X flipped.
