import { z } from 'zod';
import { baseEnvSchema, httpEnvSchema, loadEnv, natsEnvSchema, otelEnvSchema } from '@intafaced/config';

/**
 * Credentials this process must never take. Pin-tested in `env.isolation.test.ts`.
 *
 * Public depth/tape require no identity credentials. Private reads use optional
 * JWT verification and dedicated IDENTITY_OWNERSHIP_SECRET read authentication, never
 * a principal-signing key or identity database connection.
 */
export const FORBIDDEN_SERVICE_CREDENTIALS = ['INTERNAL_SERVICE_SECRET', 'EDGE_PRINCIPAL_SECRET', 'DATABASE_URL'] as const;

/**
 * svc-ws environment.
 *
 * READ THE OMISSIONS FIRST — they are the security argument for this service
 * existing at all:
 *
 *   · **no `INTERNAL_SERVICE_SECRET` env field.** Dedicated identity read
 *     authentication is configured through IDENTITY_OWNERSHIP_SECRET. Public
 *     matching/listing requests never receive this credential.
 *   · **no `EDGE_PRINCIPAL_SECRET`.** The public port is not principal-scoped.
 *     Optional `JWT_ACCESS_SECRET` is ONLY for `/private/stream` and
 *     `/drop-copy/stream` (same secret as identity/edge). Public `/stream` never reads it.
 *   · **no `DATABASE_URL`.** Depth and the trade tape are derived, never
 *     stored. The engine's book and the bus are the truth.
 *   · **no `REDIS_URL`.** One replica holds one book per subscribed market, in
 *     memory, and drops it when the last subscriber leaves. Sharing that across
 *     replicas would be a cache of a cache of the engine.
 *
 * `NATS_URL` is present for the public trade tape only: this process
 * subscribes to `orderFilled` and re-broadcasts a stripped print. That is not
 * a money path and not a principal path — order ids never leave the bus-side
 * handler. Depth still works if the bus is down; trades degrade.
 */
const schema = baseEnvSchema
  .merge(otelEnvSchema)
  .merge(httpEnvSchema)
  .merge(natsEnvSchema)
  .merge(
    z.object({
      SERVICE_NAME: z.string().default('svc-ws'),
      /** Optional private-read authority; missing disables private upgrades only. */
      IDENTITY_URL: z.preprocess((v) => (typeof v === 'string' && !v.trim() ? undefined : v), z.string().optional()),
      IDENTITY_OWNERSHIP_SECRET: z.preprocess((v) => (typeof v === 'string' && !v.trim() ? undefined : v), z.string().optional()),
      /** 4014: every port from 4000 to 4013 is taken by another service. */
      HTTP_PORT: z.coerce.number().int().default(4014),

      /**
       * svc-matching's HTTP base. Reads there are deliberately unauthenticated
       * (`services/svc-matching/src/router.ts` — "Reads stay open: depth and the
       * market list are public market data, and a price is not a secret"), which
       * is exactly why this service can talk to it holding no secret.
       */
      MATCHING_URL: z.string().url().default('http://localhost:4005'),

      /**
       * WHERE THE MARKET LISTING COMES FROM.
       *
       * svc-trade's `GET /api/v1/markets` — the same JSON the browser fetches to
       * draw the market picker, served straight out of `trade.markets` and
       * explicitly unauthenticated ("No auth — public market data",
       * `services/svc-trade/src/public-rest.ts`). Reading it costs this process
       * no credential, so being handed this URL does not weaken the argument in
       * the omissions above: there is still nothing here to steal on the public
       * path.
       *
       * Why it exists at all: `MATCHING_URL` alone was the whole bug. The
       * engine's `/markets` is the books it currently holds, and against the
       * running fleet its ten journal-replayed ids and svc-trade's sixteen
       * listed ids had an EMPTY intersection — so every id a browser could
       * legitimately discover was refused by the socket. See
       * `depth/registry.ts`.
       *
       * Not svc-edge: the edge proxies this exact path to svc-trade unchanged,
       * so a gateway hop between two services on the same network buys nothing
       * and adds a component that can be down.
       */
      TRADE_URL: z.string().url().default('http://localhost:4004'),

      /**
       * Owner-published L2 top-N window, per side.
       *
       * The snapshot AND every delta describe the same top-N window, so a level
       * pushed out of the window arrives as a removal and the client's book
       * stays exactly this deep. A client that wants more depth than this is
       * asking for a different product, not a bigger number.
       *
       * Blank / unset is unpublished — attach refuses `ws.depth_limit_unset`.
       * A git default of 50 looks published. Never invent a window. Owner may
       * set 50 explicitly.
       */
      WS_DEPTH_LIMIT: z.preprocess(
        (v) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : v),
        z.union([z.undefined(), z.coerce.number().int().min(1).max(500)]),
      ),

      /**
       * Poll cadence against svc-matching.
       *
       * Polling, not a push, because §5.1 gives the engine no outbound depth
       * feed and adding one is a change to svc-matching — a separate PR, and
       * arguably a separate design (the README's `SnapshotSink` socket is where
       * it would land). The cost of polling is bounded and visible: one HTTP
       * GET per subscribed market per tick, and markets with no subscriber are
       * not polled at all.
       */
      WS_POLL_INTERVAL_MS: z.coerce.number().int().min(50).max(60_000).default(250),

      /**
       * Owner-published page for `GET /api/v1/markets?limit=` on svc-trade.
       * Blank / unset is unpublished — `HttpMarketRegistry` refuses
       * `ws.markets_list_limit_unset`. A git default of 50 looks published.
       * Never invent a listing page. Owner may set 50 explicitly.
       */
      WS_MARKETS_LIST_LIMIT: z.preprocess(
        (v) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : v),
        z.union([z.undefined(), z.coerce.number().int().min(1).max(500)]),
      ),

      /** How often the cached market list is refreshed from `GET /markets`. */
      WS_MARKETS_REFRESH_MS: z.coerce.number().int().min(1_000).max(600_000).default(30_000),

      /**
       * Owner-published outbound socket buffer above which a client is
       * considered lagging. See `depth/hub.ts` for the policy this number
       * drives. It is bytes already handed to the kernel and not yet drained,
       * not a queue we keep — this service keeps no per-client replay queue.
       *
       * Blank / unset is unpublished — attach refuses `ws.high_water_bytes_unset`.
       * A git default of 1048576 looks published. Never invent a lag buffer
       * bound. Owner may set 1048576 explicitly.
       */
      WS_HIGH_WATER_BYTES: z.preprocess(
        (v) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : v),
        z.union([z.undefined(), z.coerce.number().int().min(4_096)]),
      ),

      /**
       * Owner-published consecutive ticks a client may spend above the
       * high-water mark before it is disconnected. Blank / unset is
       * unpublished — attach refuses `ws.max_lag_ticks_unset`. A git default
       * of 20 looks published (~5 seconds at default poll cadence). Never
       * invent a lag bound. Owner may set 20 explicitly.
       */
      WS_MAX_LAG_TICKS: z.preprocess(
        (v) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : v),
        z.union([z.undefined(), z.coerce.number().int().min(1)]),
      ),

      /**
       * Owner-published max open sockets **per hub** on this replica (depth,
       * trade tape, private, and drop-copy each get their own ceiling of this
       * size — not a process-wide sum). Blank / unset is unpublished — attach
       * refuses `ws.max_connections_unset`. A git default of 5000 looks
       * published. Never invent a ceiling. Owner may set 5000 explicitly.
       */
      WS_MAX_CONNECTIONS: z.preprocess(
        (v) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : v),
        z.union([z.undefined(), z.coerce.number().int().min(1)]),
      ),

      /**
       * Owner-published private / drop-copy max open sockets per authenticated
       * user on this replica. Stops one principal from filling
       * `WS_MAX_CONNECTIONS`. Blank / unset is unpublished — attach refuses
       * `ws.private_max_connections_per_user_unset`. A git default of 16 looks
       * published. Never invent a ceiling. Owner may set 16 explicitly.
       */
      WS_PRIVATE_MAX_CONNECTIONS_PER_USER: z.preprocess(
        (v) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : v),
        z.union([z.undefined(), z.coerce.number().int().min(1)]),
      ),

      /** Ping cadence. A socket that misses a pong is dead and is terminated. */
      WS_HEARTBEAT_MS: z.coerce.number().int().min(1_000).default(30_000),

      /**
       * Owner-published public tape replay length, per watched market.
       *
       * Bound is memory, not correctness — a client that wants history longer
       * than this asks a different product, not a bigger number.
       *
       * Blank / unset is unpublished — attach refuses `ws.trade_recent_limit_unset`.
       * A git default of 50 looks published. Never invent a window. Owner may
       * set 50 explicitly.
       */
      WS_TRADE_RECENT_LIMIT: z.preprocess(
        (v) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : v),
        z.union([z.undefined(), z.coerce.number().int().min(0).max(1_000)]),
      ),

      /**
       * JetStream durable for the `orderFilled` consumer. Must be unique per
       * replica when more than one svc-ws instance should each receive every
       * fill (JetStream durables are exclusive).
       */
      WS_TRADES_DURABLE: z.string().min(1).max(128).default('ws-trade-tape'),

      /**
       * Path to the Real Logic SBE 1.39.0 shaded jar (`SbeCodecMain`). Image
       * default `/app/sbe-codec.jar`. Unset/missing → public L2 SBE refuses
       * `depth.sbe_unavailable`. Not a secret. Not L3.
       */
      INTAFACED_SBE_JAVA: z.string().min(1).optional(),

      /**
       * Optional. When set, `/private/stream` and `/drop-copy/stream` accept
       * `access_token`. Private fans order/fill/position; drop-copy fans
       * executions on a separate durable. Unset → both upgrades 403.
       */
      JWT_ACCESS_SECRET: z.string().min(32).optional(),
      JWT_ISSUER: z.string().default('intafaced'),
      // Must match svc-identity / svc-edge (`intafaced.api`). A mismatch presents
      // as "logged in but private stream 401" with no obvious cause.
      JWT_AUDIENCE: z.string().default('intafaced.api'),
      WS_PRIVATE_ORDERS_DURABLE: z.string().min(1).max(128).default('ws-private-orders'),
      /**
       * JetStream durable for drop-copy `fillSettled`. Distinct from
       * `WS_PRIVATE_ORDERS_DURABLE-fills` so a private-half attach failure
       * cannot unsubscribe execution evidence.
       */
      WS_DROP_COPY_DURABLE: z.string().min(1).max(128).default('ws-drop-copy-fills'),
      /**
       * Owner-published drop-copy session replay length, per watched user.
       * Not durable history — connect still watermarks incompleteness.
       *
       * Blank / unset is unpublished — attach refuses `ws.drop_copy_recent_limit_unset`.
       * A git default of 50 looks published. Never invent a window. Owner may
       * set 50 explicitly.
       */
      WS_DROP_COPY_RECENT_LIMIT: z.preprocess(
        (v) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : v),
        z.union([z.undefined(), z.coerce.number().int().min(0).max(1_000)]),
      ),

      /**
       * Process kill-switch via env (`WS_GATEWAY_ENABLED=false`), restart, or
       * SIGTERM/SIGINT (handler flips enabled off). svc-edge admin kill-switch
       * cannot halt this process — ws is not on the edge route table. When false
       * the service still answers `/health` but refuses upgrades, closes open
       * sockets, and `/ready` returns 503 so the load balancer takes it out.
       */
      WS_GATEWAY_ENABLED: z
        .union([z.boolean(), z.string()])
        .default(true)
        .transform((v) => (typeof v === 'boolean' ? v : !['0', 'false', 'off', 'no'].includes(v.toLowerCase()))),

      /**
       * PX-S03 §19 owner socket — dead-man lease range. Both must be set or
       * arming refuses `cod.lease_range_unconfigured`. No invented default.
       */
      WS_COD_MIN_LEASE_MS: z.preprocess((v) => {
        if (v === undefined || v === null || v === '') return undefined;
        const n = typeof v === 'number' ? v : Number(v);
        return Number.isInteger(n) && n > 0 ? n : undefined;
      }, z.number().int().positive().optional()),
      WS_COD_MAX_LEASE_MS: z.preprocess((v) => {
        if (v === undefined || v === null || v === '') return undefined;
        const n = typeof v === 'number' ? v : Number(v);
        return Number.isInteger(n) && n > 0 ? n : undefined;
      }, z.number().int().positive().optional()),
    }),
  );

/** Keys this service's own schema layer declares (excludes shared base/nats/otel). */
export const SVC_WS_OWN_ENV_KEYS = [
  'SERVICE_NAME',
  'IDENTITY_URL',
  'IDENTITY_OWNERSHIP_SECRET',
  'HTTP_PORT',
  'MATCHING_URL',
  'TRADE_URL',
  'WS_DEPTH_LIMIT',
  'WS_POLL_INTERVAL_MS',
  'WS_MARKETS_LIST_LIMIT',
  'WS_MARKETS_REFRESH_MS',
  'WS_HIGH_WATER_BYTES',
  'WS_MAX_LAG_TICKS',
  'WS_MAX_CONNECTIONS',
  'WS_PRIVATE_MAX_CONNECTIONS_PER_USER',
  'WS_HEARTBEAT_MS',
  'WS_TRADE_RECENT_LIMIT',
  'WS_TRADES_DURABLE',
  'INTAFACED_SBE_JAVA',
  'JWT_ACCESS_SECRET',
  'JWT_ISSUER',
  'JWT_AUDIENCE',
  'WS_PRIVATE_ORDERS_DURABLE',
  'WS_DROP_COPY_DURABLE',
  'WS_DROP_COPY_RECENT_LIMIT',
  'WS_GATEWAY_ENABLED',
  'WS_COD_MIN_LEASE_MS',
  'WS_COD_MAX_LEASE_MS',
] as const;

export const env = loadEnv(schema);
export type Env = typeof env;
