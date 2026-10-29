import type { FastifyInstance } from 'fastify';
import { EXPOSED_RESPONSE_HEADERS } from './reply-envelope.js';
import { userCopy } from './user-copy.js';

/**
 * BROWSER ORIGINS — the door `apps/web` has been knocking on since it was built.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS FILE EXISTS
 *
 * svc-edge sent no CORS headers at all. Not a permissive set — none. There is no
 * `@fastify/cors`, and `apps/web/next.config.ts` declares no rewrite, so the
 * browser talked to `http://localhost:4000` from `http://localhost:3000` as a
 * genuine cross-origin call and refused every answer.
 *
 * That is not a partial outage. `edge-client.ts` attaches `Authorization:
 * Bearer …`, which is not a CORS-safelisted request header, so **every tRPC call
 * this app makes is preflighted** — and a preflight to a server with no CORS
 * layer reaches the catch-all proxy as a bare `OPTIONS`, which no upstream
 * answers usefully. The request never happened. The unauthenticated reads fare
 * no better: `GET /ready` is a simple request that is actually sent, but with no
 * `Access-Control-Allow-Origin` on the reply the browser refuses to hand it to
 * JavaScript. That is the masthead's "PLATFORM UNREACHABLE" — the edge answered
 * 200 and the browser threw it away.
 *
 * So no browser call from `apps/web` to the edge has ever succeeded, and an
 * audit's conclusion follows: a fabricated landing page survived for weeks
 * because the real data path from that app had never worked in a browser. There
 * was nothing to compare a mock against.
 *
 * The vendored shell on `:8090` was never affected — nginx proxies its `/api`
 * same-origin, so no `Origin` header is sent and none of this applies to it.
 * Nothing in this file changes that path, and there is a test saying so.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE SHAPE, AND WHY EACH PART IS SHAPED THAT WAY
 *
 * **An allowlist from configuration, never a wildcard.** The origin we echo is
 * one we were told about; there is no code path that emits `*`. See the
 * credentials note below for why `*` is not merely lazy here but wrong.
 *
 * **`Access-Control-Allow-Credentials: true` only for an exact allowlisted origin.**
 * The refresh token now rides in an httpOnly cookie. A cross-origin customer
 * page on the allowlist must be allowed to send it (`credentials: 'include'`).
 * The header is never paired with `Access-Control-Allow-Origin: *` — this file
 * still has no path that emits `*`. A request with no `Origin` (the customer
 * app behind nginx, curl, server-to-server) gets no CORS headers and no
 * credentials announcement; the cookie is first-party there and does not need
 * this header. A disallowed origin gets neither header.
 *
 * **`OPTIONS` is terminated at the edge and never proxied.** Not "handled before
 * the proxy" — never proxied, on any path, from any origin. A preflight is
 * unauthenticated by necessity (the browser sends it before it will send the
 * `Authorization` header), so it is the one request in the platform that reaches
 * us with no principal and no token, and the only safe amount of it to forward
 * is zero. Two properties fall out:
 *
 *   · It cannot reach anything that mutates, because it cannot reach anything.
 *   · It cannot be used to probe which routes exist. The answer is computed from
 *     the `Origin` header alone, before `resolve()` is ever called, so a
 *     preflight to a real prefix and a preflight to an invented one are byte-for-
 *     byte identical. A CORS layer that 404'd unknown paths would hand any
 *     attacker the route table one guess at a time.
 *
 * **The headers go on refusals too.** A 404 from the route table, a 503 from the
 * operator kill-switch, a 502 from a dead upstream — all of them carry the
 * allow-origin header when the caller's origin is allowed. This is not
 * generosity. A refusal the browser discards is reported in devtools as a CORS
 * error, so during an incident the operator who killed a module would watch the
 * UI say "unreachable" instead of "switched off by the operator". The status
 * code is the message; it has to survive.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS DELIBERATELY LEFT CLOSED
 *
 *   · `/admin/*` is not a CORS surface. `apps/admin` reaches the edge only from
 *     its own server (`control-plane-client.ts` holds the operator token; the
 *     browser talks to that app's own Next route). Opening the operator control
 *     plane to a browser origin would put `admin:write` — and the ledger freeze —
 *     one XSS away from a page we do not control, to enable a call nobody makes.
 *   · `x-intafaced-*` is absent from the allowed request headers, so a browser
 *     will not even send the edge's own header vocabulary. `stripReserved` in
 *     `principal-exchange.ts` removes it regardless; this is the same rule
 *     enforced one layer earlier, where the caller can see it.
 *   · `Access-Control-Expose-Headers` names exactly three headers, and only beside
 *     an allowed origin's allow-origin header: `x-request-id`, `x-server-received`
 *     and `x-server-sent` (RC-developer-03, `reply-envelope.ts`). Every reply
 *     already carries them; without the grant a browser on an allowed origin
 *     cannot read the id it should quote to support, or the times its clock
 *     check needs. None of them is a secret or names an account. Nothing else is
 *     exposed: not the rate-limit headers, not `x-intafaced-*`, not
 *     `set-cookie` (which no expose list can grant anyway). A disallowed origin
 *     reads nothing at all, so the grant changes nothing for it.
 *   · `DELETE`/`PUT`/`PATCH` are not CORS-allowed methods. That is a browser
 *     preflight rule, not a claim about the proxy. The edge DOES forward
 *     `DELETE /api/v1/orders…` (CCXT cancel — kill-switch release path) for
 *     non-browser clients that send no `Origin`. Browsers cancel via tRPC
 *     `orders.cancel` (POST). svc-matching's DELETE surface is deliberately
 *     absent from the route table entirely.
 *   · `http://localhost:8090` (the vendored shell) is not in the dev defaults. It
 *     is served same-origin through nginx and needs no CORS; listing it would
 *     grant a cross-origin capability to something that already works without one.
 */

/** Comma-separated absolute origins. See `parseOriginList` for the exact shape. */
export const ALLOWED_ORIGINS_ENV = 'EDGE_ALLOWED_ORIGINS';

/**
 * APP_ENVs where the dev default does not apply.
 *
 * `staging` is included for the same reason `SCREENING_ENFORCED_ENVS` and
 * `RAIL_POSTURE_ENFORCED_ENVS` include it: it is a production-like posture
 * reachable by real people, and it is where a convenient default gets normalised
 * before it reaches prod. Handing `localhost` a cross-origin grant on a hosted
 * environment is not dangerous by itself — nobody's `localhost` is ours — but it
 * means the deployment believes it has an allowlist when nothing was ever
 * decided, which is the state this repo keeps building controls against.
 */
export const CORS_ENFORCED_ENVS = ['staging', 'prod'] as const;

/**
 * Where our own front-ends run under `pnpm dev`. Used only when nothing is
 * configured AND the environment is not enforced.
 *
 * `dev` must be frictionless: nobody should have to set an environment variable
 * to open the app they just started. Both loopback spellings are listed because
 * a browser sends whichever one is in the address bar, and `localhost` and
 * `127.0.0.1` are different origins to it even though they are the same host.
 *
 *   :3100  apps/admin  (`next dev --port 3100`) — its browser talks to its own
 *          Next routes today, but a developer poking the edge directly from that
 *          origin should not meet an invisible wall. `/admin/*` on the edge stays
 *          closed to browsers regardless; this covers `/api/*` and `/ready`.
 *
 * The product shell on :8090 is NOT here and does not need to be: nginx serves it
 * same-origin and proxies `/api` to this service by service name, so its browser
 * never makes a cross-origin request at all.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE :3000 PAIR IS GONE, with `apps/web` — taken in the deletion commit exactly
 * as the note that stood here required.
 *
 * Recorded because a removed control is invisible and this one was a real hole:
 * with `apps/web` deleted, `http://localhost:3000` would have been a standing
 * cross-origin grant to whatever a developer happens to start on the most
 * commonly squatted port on a workstation — a hole nobody chose, surviving only
 * because nobody remembers the port belonged to a deleted app. Do not re-add
 * either spelling for a dev convenience; set `EDGE_ALLOWED_ORIGINS` instead.
 */
export const DEV_ORIGINS: readonly string[] = ['http://localhost:3100', 'http://127.0.0.1:3100'];

/**
 * `GET, POST, OPTIONS` and nothing more — for browser CORS preflight only.
 *
 * tRPC uses GET for queries and POST for mutations. Browsers that cancel orders
 * use `orders.cancel` (POST). The CCXT REST contract also exposes DELETE
 * cancels on `/api/v1/orders…` (see `ALWAYS_ALLOWED_REST` in kill-switch.ts);
 * those are for bots/ccxt clients that do not send `Origin`, so CORS never
 * applies. Advertising DELETE here would grant a cross-origin cancel surface
 * to any allowed browser origin with no product need.
 *
 * Do not re-read this constant as "the edge has no DELETE routes."
 */
export const ALLOWED_METHODS = 'GET, POST, OPTIONS';

/**
 * The exact set `apps/web` sends, stated rather than reflected.
 *
 * Echoing `Access-Control-Request-Headers` back is the common shortcut and it
 * means the allowed set is whatever the caller asked for, which is not a control.
 * `authorization` is what makes every tRPC call preflight in the first place;
 * `content-type: application/json` is not CORS-safelisted, so a POST needs it
 * named here. `accept` is safelisted and needs no permission.
 *
 * `trpc-accept` is absent because `httpLink` does not send it — only
 * `httpBatchStreamLink` does, and `edge-client.ts` uses `httpLink` for a reason
 * it documents. If a link that streams is ever adopted, this line is what has to
 * change with it, and the failure until it does is loud rather than subtle.
 */
export const ALLOWED_REQUEST_HEADERS = 'authorization, content-type';

/**
 * Ten minutes. Long enough that a terminal firing many calls preflights once,
 * short enough that removing an origin takes effect within a coffee break rather
 * than at the mercy of a cache. Chromium caps this at two hours regardless.
 */
export const PREFLIGHT_MAX_AGE_SECONDS = 600;

export interface OriginAllowlist {
  /** Exact origins to echo. Never contains `*`; may be empty, which means closed. */
  readonly origins: readonly string[];
  /**
   * Did an operator supply this list?
   *
   * The same distinction `ScreeningList.configured` draws, for the same reason:
   * a list that was never supplied and a list that was supplied and is short are
   * different facts, and a dashboard that renders both as a number cannot tell
   * anyone which one they are looking at.
   */
  readonly configured: boolean;
  /** Provenance, for the boot log and `/ready`. */
  readonly source: string;
  /** One line an operator can read in a log. */
  readonly summary: string;
}

export class OriginListError extends Error {
  constructor(
    message: string,
    readonly issues: readonly string[],
  ) {
    super(`${message}\n  - ${issues.join('\n  - ')}`);
    this.name = 'OriginListError';
  }
}

/**
 * Parse the env format into exact origins.
 *
 * SHAPE: comma-separated absolute origins — `scheme://host[:port]`, http or
 * https, no path, no trailing slash, no credentials, no wildcard.
 *
 *   EDGE_ALLOWED_ORIGINS="https://app.example.com,https://www.example.com"
 *
 * A MALFORMED ENTRY THROWS; it is never skipped. The vendored shell's
 * `CorsAllowlist.java` skips a bare `*` silently, and that is the weaker half of
 * an otherwise sound control: skipping means an operator who wrote something is
 * served a list that differs from what they wrote, and finds out when a browser
 * they cannot see refuses a call they cannot trace. An origin is a thing that is
 * either exactly right or not an origin at all — a trailing slash is a different
 * string, `:80` is a port a browser never sends — so every problem is reported at
 * once and the process refuses to start until the list says what it means.
 *
 * That is deliberately a stricter posture than the unconfigured case (see
 * `edgeOriginAllowlist`), and the asymmetry is the point: saying nothing is a
 * closed door, saying something wrong is a boot failure.
 */
export function parseOriginList(raw: string | undefined): readonly string[] {
  const trimmed = raw?.trim() ?? '';
  if (trimmed === '') return [];

  const issues: string[] = [];
  const seen = new Set<string>();
  const origins: string[] = [];

  for (const item of trimmed.split(',')) {
    const entry = item.trim();
    if (entry === '') continue;

    if (entry === '*') {
      issues.push(
        `"*" — a wildcard is not an allowlist. It would let any page on the internet read every ` +
          `response this edge produces on behalf of whoever is logged in. List the origins instead.`,
      );
      continue;
    }

    // `null` is what a browser sends from a sandboxed iframe, a `data:` URL or a
    // file. Matching it grants a cross-origin capability to content whose source
    // cannot be established, which is the one origin value that is never a claim
    // about anybody.
    if (entry.toLowerCase() === 'null') {
      issues.push(`"null" — an opaque origin. A sandboxed frame or a local file is not an origin we can vouch for.`);
      continue;
    }

    const normalized = entry.toLowerCase();
    let url: URL;
    try {
      url = new URL(normalized);
    } catch {
      issues.push(`"${entry}" — not a URL. Expected an absolute origin, e.g. "https://app.example.com".`);
      continue;
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      issues.push(`"${entry}" — scheme must be http or https; a browser sends no other kind of origin here.`);
      continue;
    }

    // `URL.origin` is exactly the string a browser puts in the `Origin` header.
    // Anything else — a path, a trailing slash, userinfo, an explicit default
    // port — produces a value that would never match at runtime, so it is
    // rejected here rather than quietly never matching in production.
    if (url.origin !== normalized) {
      issues.push(`"${entry}" — not an origin. A browser sends "${url.origin}"; use that exact string, with no path or trailing slash.`);
      continue;
    }

    if (seen.has(url.origin)) {
      issues.push(`"${url.origin}" listed more than once — one entry per origin, so there is one line to delete when it is revoked.`);
      continue;
    }

    seen.add(url.origin);
    origins.push(url.origin);
  }

  if (issues.length > 0) {
    throw new OriginListError(`Invalid ${ALLOWED_ORIGINS_ENV}:`, issues);
  }

  return origins;
}

/**
 * The allowlist for this process.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE DECISION: an enforced environment with no configured origins serves a
 * CLOSED DOOR. It does not refuse to boot.
 *
 * `assertScreeningConfigured` and `assertRailPosture` both refuse to start, and
 * this deliberately does not, because the failure they prevent is not the
 * failure here. An unscreened process is SILENTLY PERMISSIVE and DISHONEST: it
 * clears every region and reports that as "screened", and nothing downstream —
 * no log line, no dashboard, no call site — can tell that apart from a real
 * check that passed. A sandbox rail tells a user their money moved. Both lie,
 * and neither lie is visible from inside the process, so refusing to run is the
 * only way to make them visible at all.
 *
 * An unconfigured origin list is the opposite on both counts. It is SILENTLY
 * RESTRICTIVE — the door is shut, nobody is let through who should not be — and
 * it is not silent to the person affected: the browser refuses the response and
 * names the missing header in the console, which is about as loud as a diagnostic
 * gets. Nobody is told anything untrue.
 *
 * And the blast radius of refusing runs the wrong way. The edge is the front door
 * for the entire platform, including callers that need no CORS at all: the
 * vendored shell on `:8090` (same-origin through nginx), the CCXT REST contract,
 * every server-to-server integration, `/health` for the load balancer. Refusing
 * to boot over a browser-only convenience would take all of those down to fix a
 * problem none of them have — trading a partial outage for a total one.
 *
 * So: boot, serve nobody a cross-origin grant, and be loud about it. `index.ts`
 * logs this at ERROR in an enforced environment and puts it on `/ready`, so the
 * state is answerable from a probe rather than from someone's memory.
 *
 * A MISCONFIGURED list is the other case and it does refuse to boot — see
 * `parseOriginList`. Saying nothing is a closed door; saying something that is
 * not what you meant is a failure to start.
 */
export function edgeOriginAllowlist(env: Record<string, string | undefined> = process.env): OriginAllowlist {
  const configuredOrigins = parseOriginList(env[ALLOWED_ORIGINS_ENV]);
  const appEnv = env.APP_ENV ?? 'dev';
  const enforced = (CORS_ENFORCED_ENVS as readonly string[]).includes(appEnv);

  if (configuredOrigins.length > 0) {
    return {
      origins: configuredOrigins,
      configured: true,
      source: `env:${ALLOWED_ORIGINS_ENV}`,
      summary: `browser origins: ${configuredOrigins.length} allowed [${configuredOrigins.join(', ')}] from ${ALLOWED_ORIGINS_ENV}`,
    };
  }

  if (!enforced) {
    return {
      origins: DEV_ORIGINS,
      configured: false,
      source: 'dev-default',
      summary:
        `browser origins: NOT CONFIGURED — falling back to the development default ` +
        `[${DEV_ORIGINS.join(', ')}] because APP_ENV=${appEnv}. ` +
        `${CORS_ENFORCED_ENVS.join(' and ')} get no default; set ${ALLOWED_ORIGINS_ENV} there.`,
    };
  }

  return {
    origins: [],
    configured: false,
    source: 'unconfigured',
    summary:
      `browser origins: NOT CONFIGURED and APP_ENV=${appEnv} — NO browser origin can call this edge. ` +
      `Every cross-origin call from a front-end will be refused by the browser with a missing ` +
      `Access-Control-Allow-Origin, which looks to a user like the platform being down. ` +
      `This is a closed door, not a boot failure: server-to-server callers and the same-origin shell ` +
      `are unaffected. Supply ${ALLOWED_ORIGINS_ENV}="https://app.example.com,https://…".`,
  };
}

/** Paths a browser is allowed to reach cross-origin. `/admin/*` is not one. */
export function isCorsSurface(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/') || pathname === '/health' || pathname === '/ready';
}

/**
 * Register the CORS layer.
 *
 * MUST BE REGISTERED BEFORE `registerKillSwitchGuard`. Fastify runs `onRequest`
 * hooks in registration order, and the ordering carries two properties:
 *
 *   · A preflight is answered without the kill-switch being consulted, so the
 *     unauthenticated request cannot report which modules an operator has
 *     halted. Operational state is not public.
 *   · The allow-origin header is set on the reply BEFORE the kill-switch sends
 *     its 503, so the browser can read the refusal. A header set here survives
 *     whichever later hook or handler ends up doing the sending.
 */
export function registerCors(app: FastifyInstance, allowlist: OriginAllowlist): void {
  const allowed = new Set(allowlist.origins);

  app.addHook('onRequest', async (req, reply) => {
    const pathname = req.url.split('?')[0] ?? req.url;
    if (!isCorsSurface(pathname)) return;

    /**
     * `Vary: Origin` on every answer, including the ones that carry no
     * allow-origin header at all.
     *
     * Without it a shared cache in front of the edge may serve a response
     * generated for an allowed origin — allow-origin header and all — to a
     * request from a different one, which converts a correct allowlist into a
     * wildcard that nothing in this file emitted. It is set before any branch
     * below so no path can forget it.
     */
    reply.header('vary', 'origin');

    const rawOrigin = req.headers.origin;
    const origin = Array.isArray(rawOrigin) ? rawOrigin[0] : rawOrigin;

    /**
     * EVERY `OPTIONS` ENDS HERE. See the header: the one unauthenticated request
     * shape in the platform is the one we forward none of.
     *
     * The answer depends on the `Origin` header and on nothing else — not the
     * path, not the route table, not the method being asked about. Two preflights
     * from the same origin to `/api/trade/trpc/orders.create` and to
     * `/api/does-not-exist` are indistinguishable, which is what stops this being
     * a route oracle for anyone who can open a socket.
     */
    if (req.method === 'OPTIONS') {
      if (origin === undefined || !allowed.has(origin)) {
        // No allow-origin header on a refusal — a 200 carrying a permissive
        // header would be the bug this file exists to not have. 403 rather than
        // a bare 204 so a developer staring at devtools is told the origin was
        // the problem; it reveals nothing, because the decision was made before
        // anything about the path was looked at.
        return reply.code(403).send({ error: userCopy('edge.origin_not_allowed'), code: 'edge.origin_not_allowed' });
      }

      return reply
        .code(204)
        .header('access-control-allow-origin', origin)
        .header('access-control-allow-credentials', 'true')
        .header('access-control-allow-methods', ALLOWED_METHODS)
        .header('access-control-allow-headers', ALLOWED_REQUEST_HEADERS)
        .header('access-control-max-age', String(PREFLIGHT_MAX_AGE_SECONDS))
        .send();
    }

    // No `Origin` at all: same-origin, `curl`, a server-to-server caller, or the
    // vendored shell reaching us through nginx. None of them are subject to any
    // of this, and adding headers for them would be describing a policy to a
    // client that has no use for one.
    if (origin === undefined) return;

    /**
     * A disallowed origin is NOT refused — it simply gets no allow-origin header,
     * and the browser drops the response on the caller's side.
     *
     * Refusing outright would be a behaviour change for non-browser clients that
     * happen to set `Origin`, to protect against nothing: a request that carries
     * no ambient credential and reaches an endpoint that demands a bearer token
     * gets exactly as far as an anonymous `curl` would. The cross-site risk this
     * layer exists to contain is READING the answer, and that is the part the
     * missing header shuts down.
     */
    if (!allowed.has(origin)) return;

    // The exact origin we were configured with — echoed, never `*`. Credentials
    // are announced only beside that exact origin. See the header.
    reply.header('access-control-allow-origin', origin);
    reply.header('access-control-allow-credentials', 'true');
    reply.header('access-control-expose-headers', EXPOSED_RESPONSE_HEADERS.join(', '));
  });
}
