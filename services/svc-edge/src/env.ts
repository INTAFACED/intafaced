import { z } from 'zod';
import { baseEnvSchema, edgeEnvSchema, httpEnvSchema, loadEnv, otelEnvSchema } from '@intafaced/config';

/**
 * svc-edge environment.
 *
 * Composed from slices rather than `serviceEnvSchema`, and the omissions are
 * the point: **no `DATABASE_URL`, no `NATS_URL`, no `INTERNAL_SERVICE_SECRET`.**
 *
 * The edge owns no data and publishes no events — it verifies a token and
 * forwards a request. Giving it a database would eventually give it a table,
 * and giving it the service secret would let a compromised edge call
 * `ledger.post` directly rather than merely proxying to something that can.
 * The blast radius of the internet-facing component should be the smallest in
 * the fleet, and that is a property of what it is allowed to hold.
 */
const schema = baseEnvSchema
  .merge(httpEnvSchema)
  .merge(otelEnvSchema)
  // Signs the principal it forwards. Same value as every mounted service.
  .merge(edgeEnvSchema)
  .merge(
    z.object({
      SERVICE_NAME: z.string().default('svc-edge'),
      HTTP_PORT: z.coerce.number().int().default(4000),

      /**
       * Verifies the bearer token svc-identity issued. Must match
       * svc-identity's `JWT_ACCESS_SECRET` — a mismatch means every login
       * succeeds and every subsequent request is anonymous, which presents as
       * "logged in but nothing works".
       */
      JWT_ACCESS_SECRET: z.string().min(32),
      JWT_ISSUER: z.string().default('intafaced'),
      // Must match identity / platform default (`intafaced.api`) or all bearer
      // auth (including operator kill) fails closed with opaque 401s.
      JWT_AUDIENCE: z.string().default('intafaced.api'),
      JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),

      /**
       * Jurisdiction region, resolved server-side.
       *
       * Default `XX` is the platform UNRESOLVED sentinel (`UNRESOLVED_REGION` in
       * `@intafaced/config`) — not a restrictive jurisdiction. There is no matrix
       * entry for `XX`, so `checkAccess` falls through to `DEFAULT_MODULE_RULES`
       * (open defaults) and, for non-custodial protocol modules, still returns
       * `allowed.permissionless`. The decision now carries `regionResolved: false`
       * so that open outcome is distinguishable from a real code; set
       * `INTAFACED_REGION_FAIL_CLOSED=true` if a deployment must refuse instead
       * of falling open. Do not read `XX` as "safe default / locked down".
       *
       * ── READ THIS BEFORE TRUSTING ANY REGION-BASED CONTROL ─────────────────
       * IT IS ONE CONSTANT FOR EVERY REQUEST. The value is read once and stamped
       * onto the principal of every caller in the platform (`index.ts`, the
       * `exchangePrincipal` call). No geo-IP resolution exists anywhere in this
       * repo — no `cf-ipcountry`, no `x-vercel-ip-country`, no provider lookup.
       *
       * So sanctions screening and the jurisdiction matrix both work, and both
       * evaluate THE SAME SINGLE REGION for all traffic. A counsel-supplied
       * `INTAFACED_SANCTIONS_REGIONS` will never meet a real caller's actual
       * jurisdiction; it can only ever match if that jurisdiction happens to be
       * the one configured here. `assertScreeningConfigured()` passing at boot
       * means A LIST WAS SUPPLIED. It does not mean traffic is screened.
       *
       * Declared as §13 `socket.geo-region-resolution` (tooling/tracker/features.mjs).
       * Closing it is not a one-line header read: region must never come from
       * the caller — one who could set it would choose its own regulator — so it
       * needs a trusted upstream geo header, a stated precedence, proof the
       * header cannot be forged by reaching origin directly, and a fail-closed
       * answer when it is absent (`INTAFACED_REGION_FAIL_CLOSED` arms the
       * mechanism; per-request resolution still has to supply a real code).
       */
      DEFAULT_REGION: z.string().length(2).default('XX'),

      /** Upstream timeout. A hung service must not hold an edge connection open. */
      UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(15_000),

      /**
       * Where to exchange long-lived API keys (`ifc_…`) for short-lived JWTs.
       * Direct to svc-identity — never loop back through this edge (recursion).
       * Matches routes.ts IDENTITY_URL default.
       */
      IDENTITY_URL: z.string().url().default('http://localhost:4002'),

      /**
       * svc-matching health (venue halt-all consume). Unset skips — matching is
       * not proxied by this edge; do not invent a matching URL or operator.
       * Set → GET /health; missing `halted` refuses NEW orders (not live).
       * Never INTERNAL_SERVICE_SECRET (matching POST /halt-all is svc-trade).
       */
      MATCHING_URL: z.string().url().optional(),

      /**
       * Dedicated read key matching IDENTITY_EDGE_AUTHORITY_SECRET in identity.
       * Only currentAuthority POST and key metadata GET are authorized.
       * Missing key refuses authenticated forwarding; anonymous intake stays usable.
       * Never `INTERNAL_SERVICE_SECRET` or a trade/payment admission key.
       */
      IDENTITY_OWNERSHIP_SECRET: z.string().min(32).optional(),

      /**
       * svc-ledger's OPERATOR surface, for `/admin/ledger/*` (§14.6).
       *
       * A URL, not a credential — which is why it does not violate the rule at
       * the top of this file. The edge holds no secret of the ledger's and
       * cannot post to the money plane; it forwards the operator's own bearer
       * token to two named paths, and svc-ledger verifies it independently.
       * `/api/ledger` is still deliberately absent from the route table.
       *
       * Optional. Unset means the console is told the money-plane control is
       * unreachable, which is the honest answer and not the same as reporting
       * the platform healthy.
       */
      LEDGER_URL: z.string().url().optional(),

      /**
       * Optional path for kill-switch restart durability (JSON). Empty = memory
       * only. Multi-replica share still §13 residual — file is per process host.
       */
      EDGE_KILL_STATE_PATH: z.string().default('.data/edge-kill-state.json'),

      /**
       * Request throttle (see `hardening.ts`). On by default: the front door
       * proxies to svc-identity, so "off" means unlimited password attempts.
       */
      EDGE_RATE_LIMIT_ENABLED: z
        .union([z.boolean(), z.string()])
        .default(true)
        .transform((v) => (typeof v === 'boolean' ? v : !['0', 'false', 'off', 'no'].includes(v.toLowerCase()))),

      /**
       * Requests per window per key, per replica. Pair with WINDOW_MS.
       *
       * No git default: blank refuses boot (never invent 300). Owner may set
       * 300 explicitly. Counters are in-process, so the fleet's true allowance
       * is this times the replica count. Not a capacity limit — a per-replica
       * stuffing throttle.
       */
      EDGE_RATE_LIMIT_MAX: z.coerce.number().int().min(1),
      /**
       * Window length for EDGE_RATE_LIMIT_MAX. Pair: both required, neither
       * invented. Blank refuses boot (never invent 60000). Owner may set 60000.
       * Bounds are 1s–1h; they are not a default.
       */
      EDGE_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(1000).max(3_600_000),

      /**
       * Who may set `X-Forwarded-For`, passed straight to Fastify's `trustProxy`.
       *
       * UNSET IS THE SAFE DEFAULT AND THE USELESS ONE, and both halves matter.
       * Trusting the header unconditionally lets any caller forge their own
       * identity and walk around the throttle one fake address at a time. Not
       * trusting it behind a proxy collapses every caller onto the proxy's
       * address, so the limit becomes one shared global budget — a control that
       * converts one attacker into an outage for everybody.
       *
       * There is no default that is right for both topologies, so there is no
       * clever default: state the proxy, or be told at boot what you actually
       * got (`rateLimitSummary`).
       *
       * Accepts what Fastify accepts — `true`, a hop count, an IP, or a
       * comma-separated CIDR list.
       */
      EDGE_TRUST_PROXY: z.string().optional(),

      /**
       * Trusted geo country header name (mechanism half of socket.geo-region-resolution).
       *
       * Empty/unset → every request still stamps `DEFAULT_REGION` (constant).
       * Set (e.g. `cf-ipcountry`) **and** `EDGE_TRUST_PROXY` set → per-request
       * region from that header. Header without trustProxy is ignored (forge path).
       * Missing/invalid header → unresolved `XX` (regionResolved false).
       *
       * Never invents a geo vendor product or sanctions list content (Class X).
       */
      EDGE_GEO_COUNTRY_HEADER: z.string().optional(),

      /**
       * Max request body bytes the edge will parse before refusing with 413.
       *
       * No git default: blank refuses boot (never invent 1048576). Owner may
       * set 1048576 explicitly. Bounds 1 KiB–32 MiB are not a default.
       * Fastify's library default is ~1 MiB; this env is the owner-published
       * budget, not that constant. An oversized body is refused with 413
       * before principal exchange or upstream work, so it is not free CPU.
       * The proxy re-serialises with `JSON.stringify`, so this is also the
       * max JSON payload the edge will re-encode.
       */
      EDGE_BODY_LIMIT_BYTES: z.coerce
        .number()
        .int()
        .min(1024)
        .max(32 * 1024 * 1024),

      /**
       * Commercial licence for the embeddable ramp widget (`/api/widget/ramp`).
       *
       * UNSET / blank → named refuse `ops.infra_licence_unset`. This is not a
       * money secret and not a default-on switch: packaging stays refuse-closed
       * until an operator sets a licence. Do not invent licence content here.
       */
      INFRA_LICENCE: z.string().optional(),
      /** White-label accent — hex only; widget ignores anything else. */
      INFRA_WIDGET_ACCENT: z.string().optional(),
      /** Operator-supplied CSS for the widget chrome. Query string cannot set this. */
      INFRA_WIDGET_CSS: z.string().optional(),
    }),
  );

export const env = loadEnv(schema);
export type EdgeEnv = typeof env;
