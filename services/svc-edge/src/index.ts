import Fastify from 'fastify';
import { AuthError } from '@intafaced/auth';
import { assertScreeningConfigured } from '@intafaced/config';
import { createAdminApi, httpLedgerOperator } from './admin-api.js';
import { readEdgeAuthority } from './live-authority.js';
import { createHttpEdgeApprovalConsumer } from './action-approval-consume.js';
import { registerAdminRoutes, registerGeoBlockGuard, registerKillSwitchGuard, registerNetworkAccessGuard } from './control-plane.js';
import { resolveRequestRegion } from './geo-region.js';
import { CORS_ENFORCED_ENVS, edgeOriginAllowlist, registerCors } from './cors.js';
import { env } from './env.js';
import {
  EDGE_API_KEY_RATE_BUCKET,
  rateLimitReadiness,
  rateLimitSummary,
  registerRateLimit,
  registerSecurityHeaders,
  stampRateLimitRefuseHeaders,
  type RateLimitConfig,
} from './hardening.js';
import { KillSwitchState } from './kill-switch.js';
import { registerMatchingVenueHaltGuard } from './matching-venue-halt.js';
import { markAuthOutcome, registerMetrics } from './metrics.js';
import { createQuotaStore, decideGateway, sandboxOf } from './gateway-plane.js';
import { exchangePrincipal } from './principal-exchange.js';
import { upstreamBody } from './proxy-body.js';
import { readyUpstreamHonesty } from './ready-honesty.js';
import { isS2sPath, resolve, resolveUpstreamBase, UPSTREAMS } from './routes.js';
import { withEdgeSpan } from './tracing.js';
import { userCopy } from './user-copy.js';
import { registerWidgetRampRoute } from './widget-ramp.js';
import { registerProcessHooks, startTelemetry } from '@intafaced/telemetry';

// §9 — register the TracerProvider before the first span is created.
// `@opentelemetry/api` alone is a no-op: without this call every span in
// ./tracing.ts is built, tagged and then discarded before it reaches the
// collector. Tracers grabbed at module scope resolve lazily through the proxy
// provider, so registering here still captures them.
registerProcessHooks(
  startTelemetry({
    serviceName: env.SERVICE_NAME,
    endpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    enabled: env.OTEL_ENABLED,
    environment: env.APP_ENV,
  }),
);

/**
 * svc-edge — the front door (§9).
 *
 * Everything a browser touches arrives here, and nothing reaches a service any
 * other way. Its single job: turn a bearer token into a principal the services
 * will believe, and refuse to carry anything else the caller tried to smuggle
 * under our header prefix.
 *
 * Until this existed, `packages/contracts/src/edge.ts` verified a signature no
 * component produced, so every `scopedProcedure` in the platform refused every
 * caller. svc-identity issued a JWT that opened no door.
 */

const app = Fastify({
  logger: { level: env.LOG_LEVEL },
  disableRequestLogging: false,
  // Explicit body budget — see EDGE_BODY_LIMIT_BYTES. Refuses with 413 before
  // principal exchange or upstream work, so an oversized body is not free CPU.
  bodyLimit: env.EDGE_BODY_LIMIT_BYTES,
  // Unset means "believe the socket, never the header". See EDGE_TRUST_PROXY in
  // env.ts: this is what decides whether `req.ip` — and therefore the throttle's
  // key — identifies a caller or identifies our own load balancer.
  ...(env.EDGE_TRUST_PROXY === undefined ? {} : { trustProxy: env.EDGE_TRUST_PROXY }),
});

/**
 * §24 Lane A, asserted at boot rather than assumed.
 *
 * The edge is where region screening applies — it is the hosted front end, and
 * it is the component that resolves `region` server-side for every request in
 * the platform. So it is the component that must not start up unable to screen.
 *
 * Modelled on svc-protocol's §22 sovereignty assertion: throw rather than boot
 * into a state that quietly misleads users. Without a list, `checkAccess`
 * clears every region and calls it screened. In `dev` and `test` this returns
 * instead of throwing, and the warning below is the control's visibility.
 */
const screening = assertScreeningConfigured();
app.log[screening.configured ? 'info' : 'warn'](
  {
    appEnv: env.APP_ENV,
    configured: screening.configured,
    // `configured` alone no longer identifies the state. A reviewed-and-
    // deliberately-empty list is `configured: true` with a count of zero, which
    // reads in a field set exactly like a list that happens to be short. The
    // message string spells it out; a structured field is what gets queried.
    declaration: screening.declaration,
    blocked: screening.blockedRegions.length,
    source: screening.source,
  },
  screening.summary,
);

/**
 * Which browser origins may call this edge (see `cors.ts`).
 *
 * Read before anything is registered, because a malformed list throws here — a
 * list that does not say what its author meant is a boot failure, in the same
 * spirit as the screening list above. An ABSENT list is not: it is a closed door
 * that this log line and `/ready` make visible, and `cors.ts` argues at length
 * why the two cases differ.
 *
 * ERROR, not `warn`, when an enforced environment has nothing configured. That
 * state means every front-end this deployment serves is being refused by the
 * browser, and it presents to users as the platform being down — which is
 * exactly the failure that went unnoticed for weeks before this file had a CORS
 * layer at all.
 */
const cors = edgeOriginAllowlist();
const corsEnforced = (CORS_ENFORCED_ENVS as readonly string[]).includes(env.APP_ENV);
app.log[cors.configured ? 'info' : corsEnforced ? 'error' : 'warn'](
  { appEnv: env.APP_ENV, configured: cors.configured, allowedOrigins: cors.origins.length, source: cors.source },
  cors.summary,
);

/**
 * FIRST — before every route and before the kill-switch guard.
 *
 * The ordering is the control, not a tidiness preference. Registered here, the
 * preflight is answered without the kill-switch ever being consulted (so an
 * unauthenticated `OPTIONS` cannot report which modules an operator has halted),
 * and the allow-origin header is on the reply before any later hook or handler
 * sends a 404, a 503 or a 502 — so the browser can read our refusals instead of
 * reporting them all as the same opaque CORS error.
 */
registerCors(app, cors);

/**
 * THEN the transport controls, in this order and after CORS for the reasons
 * `hardening.ts` sets out: a preflight is answered before the limiter can spend
 * a user's budget on it, and the allow-origin header is already on the reply
 * when a 429 is sent, so a browser can read the refusal instead of reporting it
 * as an opaque CORS failure.
 */
await registerSecurityHeaders(app);

const rateLimit: RateLimitConfig = {
  enabled: env.EDGE_RATE_LIMIT_ENABLED,
  max: env.EDGE_RATE_LIMIT_MAX,
  windowMs: env.EDGE_RATE_LIMIT_WINDOW_MS,
  trustProxy: env.EDGE_TRUST_PROXY !== undefined,
};
await registerRateLimit(app, rateLimit);

// Same posture as the screening and CORS lines above: say what the control
// actually resolved to, because "throttle installed" and "throttle keyed on
// something meaningful" are different facts and only one of them is protection.
const rateLimitState = rateLimitSummary(rateLimit);
app.log[rateLimitState.level]({ appEnv: env.APP_ENV, ...rateLimit }, rateLimitState.summary);

const envLookup = (name: string): string | undefined => process.env[name];

/** Per-key quota for the API-key plane (`gateway-plane.ts`). IP throttle stays in hardening.ts. */
const keyQuota = createQuotaStore();

const tokenConfig = {
  secret: env.JWT_ACCESS_SECRET,
  issuer: env.JWT_ISSUER,
  audience: env.JWT_AUDIENCE,
  accessTtlSeconds: env.JWT_ACCESS_TTL_SECONDS,
};

/** §14.6 — the operator kill-switch, and the first one in the platform anything can reach. */
const killSwitches = new KillSwitchState({ statePath: env.EDGE_KILL_STATE_PATH });

const admin = createAdminApi(killSwitches, {
  tokens: tokenConfig,
  sessionLive: async (principal) => {
    if (
      principal.kid ||
      principal.sub_account ||
      !(await readEdgeAuthority(principal, {
        identityUrl: env.IDENTITY_URL,
        identityOwnershipSecret: env.IDENTITY_OWNERSHIP_SECRET,
      }))
    )
      throw new AuthError('Operator session is not live', 'token.invalid');
  },
  // Null when unset, and the console is told. `LEDGER_URL` is a URL, not a
  // secret — `env.ts` withholds `DATABASE_URL`, `NATS_URL` and
  // `INTERNAL_SERVICE_SECRET` from this service, and none of them is needed
  // here: the edge forwards the operator's own token and holds no credential of
  // the ledger's.
  ledger: env.LEDGER_URL ? httpLedgerOperator(env.LEDGER_URL, env.UPSTREAM_TIMEOUT_MS) : null,
  approvals: createHttpEdgeApprovalConsumer({
    identityUrl: env.IDENTITY_URL,
    edgeSecret: env.EDGE_PRINCIPAL_SECRET,
    region: env.DEFAULT_REGION,
  }),
});

/**
 * §14.5 — the scrape surface, and the numbers the SLO panel is drawn from.
 *
 * Registered HERE, before the kill-switch guard and the proxy, for a reason that
 * is entirely about what ends up in the denominator. The `onResponse` hook it
 * installs counts every reply this process sends — a 429 from the limiter above,
 * a 503 from the guard below, a 400 from the path resolver, a 502 from a dead
 * upstream. An availability SLO that only sees requests which reached a handler
 * is an SLO that reports green through an outage.
 *
 * `tooling/infra/prometheus.yaml` scrapes this at `svc-edge:4000/metrics`, and
 * `observability-wiring.test.ts` asserts that host, port and path against the
 * real config and the real compose file rather than trusting this comment.
 */
registerMetrics(app, { service: env.SERVICE_NAME });

app.get('/health', async () => ({ ok: true, service: env.SERVICE_NAME }));

app.get('/ready', async () => ({
  ready: true,
  // The route table, so an operator can see what the edge will forward without
  // reading the source. Deliberately no secrets, no upstream URLs.
  //
  // Env var set is `configured`, not a live hop. This process does not fetch
  // upstream `/health`. A prefix in `absent` would have been forwarded to
  // localhost in staging/prod (a 200/502 on an unset door).
  routes: UPSTREAMS.map((u) => u.prefix),
  upstreamConfiguration: readyUpstreamHonesty(envLookup),
  // Whether screening is armed, and how many regions it refuses — a count, not
  // the codes. An operator needs to see the control is on; an unauthenticated
  // caller does not need our exact configuration read back to them.
  //
  // `declaration` is here because `configured` stopped being enough to identify
  // the state. There are now two ways to be configured: a supplied list
  // (`listed`), and a recorded "reviewed, and no region is screened out"
  // (`reviewed-empty`), and the second is `configured: true` with
  // `blockedRegions: 0`. A probe with only the boolean and the count would render
  // that identically to a short list, and the one thing this whole control exists
  // to prevent is two different compliance states looking like the same number.
  // It is a state name, not configuration content — it says which question was
  // answered, never which regions.
  screening: {
    configured: screening.configured,
    declaration: screening.declaration,
    blockedRegions: screening.blockedRegions.length,
  },
  // Same shape, same reason: whether a browser allowlist was SUPPLIED, and how
  // many origins it holds — a count, never the origins themselves. "Zero because
  // nobody configured one" and "zero because the list is short" are different
  // facts, and a probe that renders both as `0` cannot tell an operator which
  // one is why the front-end says the platform is unreachable.
  cors: { configured: cors.configured, allowedOrigins: cors.origins.length },
  // Throttle posture without boot logs. multiReplicaShared is always false —
  // counters are per process; do not invent a shared store on /ready.
  rateLimit: rateLimitReadiness(rateLimit),
  // Body budget the process will accept (bytes). Count only — not a secret.
  bodyLimitBytes: env.EDGE_BODY_LIMIT_BYTES,
  // Readiness is about the process, never about the switches: a killed module is
  // an operator's decision, and taking the edge out of the load balancer because
  // of it would remove the surface that serves cancels and reads.
  //
  // `disabledModules` is deliberately ABSENT here. `/ready` is unauthenticated
  // and a CORS surface; publishing the halt list let any caller learn which
  // modules an operator had killed — the same oracle the preflight ordering
  // exists to deny (audit 2026-08-08 #5). Operators read the list from
  // `GET /admin/status` (admin:write + MFA).
}));

// ── Operator control plane (§14.6) ─────────────────────────────────
//
// Both live in `control-plane.ts` rather than inline here, so the end-to-end
// test drives THE SAME code this process serves. A kill-switch verified only
// through a test-only copy of the rule is not verified.

registerKillSwitchGuard(app, killSwitches);
// Matching venue halt-all on NEW trade writes. Unset MATCHING_URL skips.
// Never invent an operator or POST /halt-all.
registerMatchingVenueHaltGuard(app, { matchingUrl: env.MATCHING_URL });
// Geo-block on /api — unset/empty screening is unknown, not a geo-clearance.
// Must not invent sanctions list content (Class X).
registerGeoBlockGuard(app);
// Network fail-closed on /api — product Done bar for VPN/signal residual.
// Must not invent a partner; refuses only when env arms fail-closed / flagged.
registerNetworkAccessGuard(app);
registerAdminRoutes(app, admin);

registerWidgetRampRoute(app, {
  licence: env.INFRA_LICENCE,
  accent: env.INFRA_WIDGET_ACCENT,
  tenantCss: env.INFRA_WIDGET_CSS,
});

/**
 * The proxy.
 *
 * A catch-all rather than a route per upstream, because the failure mode of a
 * missing route must be 404 — not "fell through to a default upstream".
 *
 * Encapsulated so the JSON parser here can keep RAW BYTES (pay webhook HMAC)
 * without turning `/admin/*` bodies into Buffers. Fastify parsers are
 * per-context; the parent keeps the object parser the control plane needs.
 */
await app.register(async (api) => {
  api.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });
  api.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  api.all('/api/*', async (req, reply) => {
    const url = new URL(req.url, `http://${env.HTTP_HOST}`);
    const target = resolve(url.pathname);

    if (!target) {
      // An unlisted prefix is not forwarded anywhere. An edge that proxies what
      // it does not recognise is a proxy for the entire internal network.
      return reply.code(404).send({ error: userCopy('edge.no_route'), code: 'edge.no_route' });
    }

    if (isS2sPath(target.path)) {
      // Belt: the onRequest hook already refuses this. Kept so a future route
      // that skips the hook cannot open the S2S plane.
      return reply.code(404).send({ error: userCopy('edge.s2s_not_proxied'), code: 'edge.s2s_not_proxied' });
    }

    const resolved = resolveUpstreamBase(target.upstream, envLookup, env.APP_ENV);
    if ('unwired' in resolved) {
      // Staging/prod with no PAY_URL (etc.) used to silently hit localhost.
      // 503 + named code, not a 200/502 that looks like the service is down.
      req.log.error({ prefix: target.upstream.prefix, envVar: target.upstream.envVar }, 'edge: upstream env unset');
      return reply.code(503).send({
        error: userCopy('edge.upstream_unwired'),
        code: 'edge.upstream_unwired',
        module: target.upstream.module,
      });
    }

    // The kill-switch already ran, in the `onRequest` hook registered above —
    // before body parsing and before this handler exists. See `control-plane.ts`
    // for why it is a hook and not a check here: a guard inside one handler
    // protects that handler, a hook protects the door.

    // Region: DEFAULT_REGION, or trusted geo header when EDGE_GEO_COUNTRY_HEADER
    // + EDGE_TRUST_PROXY are both set. Never caller-supplied free-form region.
    const regionRes = resolveRequestRegion({
      defaultRegion: env.DEFAULT_REGION,
      trustProxy: env.EDGE_TRUST_PROXY !== undefined,
      geoHeaderName: env.EDGE_GEO_COUNTRY_HEADER,
      headers: req.headers as Record<string, string | string[] | undefined>,
    });
    if (regionRes.refuseCode) {
      return reply.code(403).send({
        error: regionRes.note,
        code: regionRes.refuseCode,
      });
    }

    const exchanged = await exchangePrincipal(req.headers, {
      tokens: tokenConfig,
      edgeSecret: env.EDGE_PRINCIPAL_SECRET,
      region: regionRes.region,
      // Direct to identity for `ifc_…` API keys — never via this edge (loop).
      identityUrl: env.IDENTITY_URL,
      // Dedicated current identity read. Missing key refuses authenticated forwarding.
      identityOwnershipSecret: env.IDENTITY_OWNERSHIP_SECRET,
      // Server-resolved hop (trust-proxy / socket). Never a client-supplied
      // x-forwarded-for — principal-exchange strips those and writes this.
      clientIp: req.ip,
      resolvedProduct: target.upstream.module,
    });

    // A refused token is logged and the request continues as ANONYMOUS. The
    // service decides — `protectedProcedure` answers UNAUTHORIZED with the right
    // status, and a `publicProcedure` still works, which is what lets a caller
    // with an expired token reach `auth.refresh` and recover.
    if (exchanged.rejected) {
      req.log.info({ reason: exchanged.rejected, path: url.pathname }, 'edge: token refused, forwarding anonymous');
    }

    // Recorded for the metric, not for the response. Kept as three values rather
    // than a boolean because "presented nothing" and "presented something we
    // refused" are different incidents: a spike in `refused` after a deploy is a
    // signing-key mismatch, and a spike in `anonymous` is a front-end that stopped
    // attaching the header. An availability panel that merges them shows neither.
    markAuthOutcome(req, exchanged.rejected ? 'refused' : exchanged.principal ? 'authenticated' : 'anonymous');

    // One key/scope/quota/sandbox plane. Dialects stay two — refuse bodies are
    // CCXT on /api/v1 and tRPC on /api/pay. Interactive sessions skip this.
    const gate = decideGateway({
      pathname: url.pathname,
      method: req.method,
      principal: exchanged.principal,
      quota: keyQuota,
      now: Date.now(),
      max: env.EDGE_RATE_LIMIT_MAX,
      windowMs: env.EDGE_RATE_LIMIT_WINDOW_MS,
    });
    if (exchanged.principal?.kid) {
      reply.header('x-intafaced-key-env', sandboxOf(exchanged.principal) ? 'sandbox' : 'live');
    }
    if (!gate.allow) {
      if (gate.status === 429) {
        const resetSeconds = Math.max(1, Number(gate.body.retryAfterSeconds) || 1);
        stampRateLimitRefuseHeaders(reply, {
          limit: env.EDGE_RATE_LIMIT_MAX,
          resetSeconds,
          bucket: EDGE_API_KEY_RATE_BUCKET,
          requestId: String(req.id),
        });
      }
      return reply.code(gate.status).send(gate.body);
    }

    const body = upstreamBody(req.method, req.body);

    return withEdgeSpan(
      'edge.proxy',
      {
        upstream: target.upstream.prefix,
        method: req.method,
        auth: exchanged.rejected ?? (exchanged.principal ? 'authenticated' : 'anonymous'),
      },
      async () => {
        let response: Response;
        try {
          const request = {
            method: req.method,
            headers: exchanged.headers,
            redirect: 'error' as const,
            cache: 'no-store',
            ...(body === undefined ? {} : { body }),
            signal: AbortSignal.timeout(env.UPSTREAM_TIMEOUT_MS),
          };
          response = await fetch(`${resolved.base}${target.path}${url.search}`, request);
        } catch (err) {
          // 502, not 500: the edge is fine, the upstream is not, and a caller
          // needs to tell those apart before deciding whether to retry.
          req.log.error({ err, upstream: target.upstream.prefix }, 'edge: upstream unreachable');
          return reply.code(502).send({ error: userCopy('edge.upstream_unavailable'), code: 'edge.upstream_unavailable' });
        }

        const text = await response.text();
        return reply
          .code(response.status)
          .header('content-type', response.headers.get('content-type') ?? 'application/json')
          .send(text);
      },
    );
  });
});

await app.listen({ host: env.HTTP_HOST, port: env.HTTP_PORT });
app.log.info({ port: env.HTTP_PORT, routes: UPSTREAMS.length }, 'svc-edge ready');

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void (async () => {
      await app.close();
      process.exit(0);
    })();
  });
}
