import type { ModuleId } from '@intafaced/config';

/**
 * The route table — which path prefix reaches which service.
 *
 * Kept as data, and kept exhaustive on purpose. An edge that forwards anything
 * it does not recognise is a proxy for the whole internal network: one
 * unlisted service, one debug endpoint, one Actuator, and the perimeter is
 * decoration. **Unknown prefix → 404, never a pass-through.**
 *
 * `svc-ledger` and `svc-matching` are deliberately ABSENT from `/api/*`. They
 * serve service-to-service HTTP authenticated by a shared secret (#50, #55),
 * and no browser has business reaching either — `ledger.post` moves value on a
 * module's own authority, which is exactly why there is no `ledger:write`
 * scope for a user token to carry. The ledger's OPERATOR surface (the durable
 * posting freeze) is reached instead through the explicit, non-proxied
 * `/admin/ledger/*` routes in `admin-api.ts`, which forward one named
 * procedure each rather than opening a path to the money plane.
 */

export interface Upstream {
  /** Path prefix, without a trailing slash. */
  readonly prefix: string;
  /**
   * The module this prefix belongs to, stated rather than derived.
   *
   * ── Why this field exists, and what it cost to not have it ────────────────
   *
   * An earlier revision derived the module by stripping `/api/` off the prefix.
   * That works for twelve of the thirteen routes and fails silently on the one
   * that matters: `/api/v1` is the public CCXT REST contract, it forwards to
   * `svc-trade`, and `v1` is not a module id. Two bugs came out of that single
   * assumption.
   *
   * The first is loud: building the map threw at import, so `svc-edge` did not
   * boot at all. The second is the dangerous one, and it is what a "fix" that
   * skipped unmappable prefixes would have shipped — `/api/v1` would have had
   * no module, so killing `trade` would have refused `/api/trade/trpc/
   * orders.create` while `POST /api/v1/orders` kept placing orders. An operator
   * would have read "trade: killed" on the console while the exchange took new
   * risk through the front door.
   *
   * Stating the module makes both impossible: the type requires it, and one
   * upstream naming a different module than its prefix suggests is now a
   * deliberate, reviewable line rather than an accident of string handling.
   */
  readonly module: ModuleId;
  /** Env var holding the base URL, so nothing is hardcoded per environment. */
  readonly envVar: string;
  /** Default for local development only. */
  readonly devUrl: string;
  /**
   * When true, forward the full inbound pathname instead of stripping `prefix`.
   * Used for CCXT-contract paths (`/api/v1/...`) that must land on the upstream
   * at the same absolute path (the exchange mounts `/api/v1/markets`, not `/markets`).
   */
  readonly preservePath?: boolean;
}

export const UPSTREAMS: readonly Upstream[] = [
  { prefix: '/api/identity', module: 'identity', envVar: 'IDENTITY_URL', devUrl: 'http://localhost:4002' },
  { prefix: '/api/trade', module: 'trade', envVar: 'TRADE_URL', devUrl: 'http://localhost:4004' },
  // Public exchange REST (CCXT contract paths). Path preserved so
  // edge /api/v1/markets → trade /api/v1/markets.
  //
  // `module: 'trade'` and not 'v1'. This is the same service as the row above
  // reached under a different contract, so the kill-switch must treat the two
  // as one module or halting the market would only halt half of it.
  { prefix: '/api/v1', module: 'trade', envVar: 'TRADE_URL', devUrl: 'http://localhost:4004', preservePath: true },
  { prefix: '/api/token', module: 'token', envVar: 'TOKEN_URL', devUrl: 'http://localhost:4003' },
  { prefix: '/api/agents', module: 'agents', envVar: 'AGENTS_URL', devUrl: 'http://localhost:4008' },
  { prefix: '/api/bank', module: 'bank', envVar: 'BANK_URL', devUrl: 'http://localhost:4009' },
  { prefix: '/api/p2p', module: 'p2p', envVar: 'P2P_URL', devUrl: 'http://localhost:4007' },
  { prefix: '/api/pay', module: 'pay', envVar: 'PAY_URL', devUrl: 'http://localhost:4006' },
  { prefix: '/api/blueprint', module: 'blueprint', envVar: 'BLUEPRINT_URL', devUrl: 'http://localhost:4011' },
  { prefix: '/api/protocol', module: 'protocol', envVar: 'PROTOCOL_URL', devUrl: 'http://localhost:4012' },
  // The Protocol Plane's front door. Routed like any other service — the edge
  // does not know or care that its procedures are permissionless; that is the
  // module's own jurisdiction rule, not a property of the route table.
  { prefix: '/api/dex', module: 'dex', envVar: 'DEX_URL', devUrl: 'http://localhost:4010' },
  // svc-indexer mounts its router and answers on 4013, but had no route here,
  // so every chain query 404'd at the edge while the service itself was
  // healthy. A service reachable only from inside the network is not reachable.
  { prefix: '/api/indexer', module: 'indexer', envVar: 'INDEXER_URL', devUrl: 'http://localhost:4013' },
  { prefix: '/api/notify', module: 'notify', envVar: 'NOTIFY_URL', devUrl: 'http://localhost:4015' },
  { prefix: '/api/academy', module: 'academy', envVar: 'ACADEMY_URL', devUrl: 'http://localhost:4016' },
  { prefix: '/api/mining', module: 'mining-pool', envVar: 'MINING_POOL_URL', devUrl: 'http://localhost:4023' },
  { prefix: '/api/support', module: 'support', envVar: 'SUPPORT_URL', devUrl: 'http://localhost:4017' },
  { prefix: '/api/market', module: 'market', envVar: 'MARKET_URL', devUrl: 'http://localhost:4018' },
  { prefix: '/api/execution', module: 'execution', envVar: 'EXECUTION_URL', devUrl: 'http://localhost:4019' },
  { prefix: '/api/tax', module: 'tax', envVar: 'TAX_URL', devUrl: 'http://localhost:4020' },
  { prefix: '/api/quant', module: 'quant', envVar: 'QUANT_URL', devUrl: 'http://localhost:4021' },
  // Campaigns: seasons, limited drops and the TGE claim (RC-campaigns-04/-05). Holds no balance.
  { prefix: '/api/campaigns', module: 'campaigns', envVar: 'CAMPAIGNS_URL', devUrl: 'http://localhost:4024' },
  // CRM / team / warehouse revenue / projects. Module stays `core-ops` (registry
  // id); the shell queries `/api/ops` so query('ops', …) matches the surface.
  { prefix: '/api/ops', module: 'core-ops', envVar: 'OPS_URL', devUrl: 'http://localhost:4022' },
] as const;

/**
 * The set of modules the edge can actually enforce a kill on.
 *
 * Derived from the route table, never written by hand. `decide()` refuses a
 * request by matching its path against a prefix in `UPSTREAMS`; a module with no
 * prefix here has no path to match, so a kill against it can never refuse
 * anything.
 */
export const ENFORCEABLE_MODULES: ReadonlySet<ModuleId> = new Set(UPSTREAMS.map((u) => u.module));

/**
 * Modules that are DEPLOYED but do not sit behind this edge — and are therefore
 * NOT killable from the operator control plane.
 *
 * ── Why this list has to exist, and why it must stay short ──────────────────
 *
 * "Enforced at the door" is only a real property if the door is the only way in.
 * The kill-switch is an `onRequest` hook on svc-edge, so it can refuse exactly
 * what svc-edge serves. A service the browser reaches on its own published port
 * is not behind the door, and no hook on the edge can stop it.
 *
 * Until this list existed, `admin-api.ts` accepted a kill for EVERY `ModuleId`,
 * including these. An operator could halt `ws`, receive 200, and read
 * `disabledModules: ["ws"]` back from `/admin/status` while svc-ws kept
 * streaming — the exact failure `kill-switch.ts` opens by describing: "the
 * operator believes the market is halted, the console says it is halted, and
 * orders are being accepted."
 *
 * So the control plane now refuses to arm these, with the reason below in the
 * message. A refusal an operator can read beats a halt that never happened.
 *
 * The gate `tooling/ci/killswitch-reachability.mjs` cross-checks this list
 * against `docker-compose.apps.yml`: any `svc-*` container that publishes a host
 * port and has no edge prefix must appear here, so a service added later cannot
 * become silently unkillable — it either goes behind the door or it is recorded
 * here as a known gap.
 */
export const OUTSIDE_THE_DOOR: Readonly<Record<string, string>> = {
  /**
   * SOCKET §13 · `socket.ws-behind-the-edge`
   *
   * svc-ws publishes 4014 and the browser connects to it directly
   * (`NEXT_PUBLIC_WS_URL`); the vendored shell's nginx proxies `/ws` straight to
   * `svc-ws:4014`. Neither path crosses svc-edge, so the operator kill-switch
   * cannot reach it. Closing this means terminating the socket at the edge (or
   * giving svc-ws a control-plane-fed switch of its own) — a routing change well
   * beyond the control plane, and it is recorded here rather than pretended away.
   *
   * Blast radius today: svc-ws is `custodial: false`, holds no balance, no
   * database, no bus and no service secret. It re-broadcasts public market data.
   * It cannot move value, which is why this is a gap and not an emergency.
   */
  ws: 'svc-ws is reached directly by the browser on its own port, not through this edge (SOCKET §13 socket.ws-behind-the-edge)',

  /**
   * Deliberately not proxied at all — see the header of this file. svc-ledger's
   * operator surface is the DURABLE `posting_freeze` row, reached through the
   * explicit `/admin/ledger/*` routes, which is a stronger control than an
   * in-memory module flag. Arming `ledger` here would shadow it with a switch
   * that does nothing.
   */
  ledger: 'the money plane is halted with POST /admin/ledger/freeze (durable, attributed, admin:treasury) — not with a module flag',

  /**
   * Still absent from `UPSTREAMS`. A browser must not open an arbitrary
   * matching path. Named operator procedures live in `matching-proxy.ts`
   * (`MATCHING_OPERATOR_EDGE_PATHS`). Halt `trade` to stop new order risk
   * at this door; that is a different switch from a matching halt.
   */
  matching:
    'svc-matching is not in the catch-all proxy. Operators reach named controls through /admin/trade-ops/matching and /admin/trade-ops/surveillance. Halt `trade` to stop new order risk at this door',
};

/**
 * Operator procedures for the trade desk. Data only — `matching-proxy.ts`
 * registers them. Matching stays out of `UPSTREAMS` so an unknown matching
 * path is still 404, including adjudicate and fine.
 */
export const MATCHING_OPERATOR_EDGE_PATHS = {
  halt: '/admin/trade-ops/matching/markets/:marketId/halt',
  resume: '/admin/trade-ops/matching/markets/:marketId/resume',
  reduceOnlyOn: '/admin/trade-ops/matching/markets/:marketId/reduce-only',
  reduceOnlyOff: '/admin/trade-ops/matching/markets/:marketId/reduce-only/off',
  postOnlyOn: '/admin/trade-ops/matching/markets/:marketId/post-only',
  postOnlyOff: '/admin/trade-ops/matching/markets/:marketId/post-only/off',
  delist: '/admin/trade-ops/matching/markets/:marketId/delist',
  haltAll: '/admin/trade-ops/matching/halt-all',
  resumeAll: '/admin/trade-ops/matching/resume-all',
  health: '/admin/trade-ops/matching/health',
  surveillanceCases: '/admin/trade-ops/surveillance/cases',
} as const;

export interface Resolved {
  readonly upstream: Upstream;
  /** Path to request on the upstream, with the prefix removed. */
  readonly path: string;
}

/**
 * Resolve an inbound path, or null.
 *
 * Longest prefix wins, so `/api/identity-admin` could never be captured by
 * `/api/identity` if such a route were added later. Matching is on a segment
 * boundary for the same reason.
 */
export function resolve(pathname: string): Resolved | null {
  const candidates = [...UPSTREAMS].sort((a, b) => b.prefix.length - a.prefix.length);

  for (const upstream of candidates) {
    if (pathname === upstream.prefix || pathname.startsWith(`${upstream.prefix}/`)) {
      if (upstream.preservePath) {
        return { upstream, path: pathname };
      }
      const rest = pathname.slice(upstream.prefix.length);
      return { upstream, path: rest === '' ? '/' : rest };
    }
  }
  return null;
}

/**
 * Service surfaces (`/internal/…`) must never cross this door.
 *
 * Pay, identity, token, bank, trade, p2p all mount cron/stake/rank jobs at
 * `/internal/*`, authenticated by `INTERNAL_SERVICE_SECRET`. The edge strips
 * every `x-intafaced-*` header, so those credentials cannot arrive through
 * here — but forwarding the path still makes the door a probe surface, and
 * a service-side auth bug would become an internet bug. 404, same as an
 * unlisted prefix: do not advertise that the job exists.
 */
export function isS2sPath(path: string): boolean {
  return path === '/internal' || path.startsWith('/internal/');
}

/**
 * Same envs as CORS enforcement: a hosted deploy must not silently fall back
 * to `localhost`. `dev`/`test` keep the table's `devUrl`.
 */
export const UPSTREAM_ENFORCED_ENVS = ['staging', 'prod'] as const;

/** Env var nonempty — configuration, not a live hop. `/ready` must not call this wired. */
export function isUpstreamConfigured(upstream: Upstream, envLookup: (name: string) => string | undefined): boolean {
  const raw = envLookup(upstream.envVar);
  return typeof raw === 'string' && raw.trim().length > 0;
}

export function resolveUpstreamBase(
  upstream: Upstream,
  envLookup: (name: string) => string | undefined,
  appEnv: string,
): { readonly base: string } | { readonly unwired: true } {
  const raw = envLookup(upstream.envVar);
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return { base: raw.replace(/\/$/, '') };
  }
  if ((UPSTREAM_ENFORCED_ENVS as readonly string[]).includes(appEnv)) {
    return { unwired: true };
  }
  return { base: upstream.devUrl.replace(/\/$/, '') };
}

export interface ReadyRoute {
  readonly prefix: string;
  readonly module: ModuleId;
  /** Env var set. Not a health probe. */
  readonly configured: boolean;
}

/** `/ready` route table: prefixes plus whether the env var is set. No URLs. Never `wired`. */
export function readyRoutes(envLookup: (name: string) => string | undefined): readonly ReadyRoute[] {
  return UPSTREAMS.map((u) => ({
    prefix: u.prefix,
    module: u.module,
    configured: isUpstreamConfigured(u, envLookup),
  }));
}
