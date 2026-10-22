import { z } from 'zod';
import { edgeEnvSchema, internalServiceEnvSchema, loadEnv, s2sEnvSchema, serviceEnvSchema } from '@intafaced/config';

/**
 * svc-academy environment.
 *
 * This service self-mounts /trpc, so it must be able to authenticate the edge:
 * every procedure resolves `ctx.principal.userId` into somebody's seat, their
 * progress or their certification, and an unsigned principal header would let a
 * caller claim any of them (docs/decisions/mount-boundary.md).
 *
 * `internalServiceEnvSchema` is here for exactly two callees, both of which
 * authenticate on the shared service secret:
 *
 *   · svc-token's `/internal/stake/:userId` — how a staked lobby knows who may
 *     sit down;
 *   · svc-identity's `/internal/rank/:userId/perks` — how the service knows who
 *     may open a room (§4.1 `lobbyHostRights`).
 *
 * There is no LEDGER_URL, and that absence is the design: `academy` is
 * `custodial: false` and this process holds no credential that could reach
 * anything which moves value.
 */
const schema = serviceEnvSchema
  .merge(edgeEnvSchema)
  .merge(internalServiceEnvSchema)
  .merge(s2sEnvSchema)
  .merge(
    z.object({
      SERVICE_NAME: z.string().default('svc-academy'),
      /** 4016: every port from 4000 to 4015 is claimed in docker-compose.apps.yml. */
      HTTP_PORT: z.coerce.number().int().default(4016),

      /** svc-token's internal address — the source of `stakeOf` for staked lobbies. */
      TOKEN_URL: z.string().url().default('http://localhost:4003'),

      /**
       * svc-identity's internal address — the source of §4.1's
       * `rank_thresholds.perks.lobbyHostRights`, which decides who may open a
       * room at all. Read at `createRoom` and nowhere else (host-rights.ts).
       */
      IDENTITY_URL: z.string().url().default('http://localhost:4002'),

      /**
       * Which streaming provider carries live sessions.
       *
       * `none` runs lobbies as seats, presence and the 2D scene canvas with no
       * audio or video, and says so out loud rather than handing out a join
       * token that cannot connect (SOCKET §13 `socket.stream-provider`).
       *
       * Chosen explicitly, never by fallback: a misconfigured provider must
       * fail loudly instead of quietly degrading a paid lobby to text.
       */
      ACADEMY_STREAM_PROVIDER: z.enum(['none', 'livekit']).default('none'),
      /** LiveKit websocket URL. Blank keeps the provider refuse-closed. */
      LIVEKIT_URL: z.string().optional().default(''),
      /** LiveKit API credentials. Never included in readiness or logs. */
      LIVEKIT_API_KEY: z.string().optional().default(''),
      LIVEKIT_API_SECRET: z.string().optional().default(''),
      LIVEKIT_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(86_400).default(3600),

      /**
       * Owner-published hard ceiling on a lobby, above whatever a room asks for.
       * Blank / unset is unpublished — createRoom refuses
       * `academy.room_capacity_unset`. A git default of 5000 looks published.
       * Never invent a ceiling. Owner may set 5000 explicitly.
       */
      ACADEMY_MAX_ROOM_CAPACITY: z.preprocess(
        (v) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : v),
        z.union([z.undefined(), z.coerce.number().int().min(1).max(100_000)]),
      ),

      /**
       * Stage-1 tournament ladder kill-switch (mirrors flag `academy.tournament`).
       * When false, season/standing procedures refuse `academy.tournament_disabled`.
       */
      ACADEMY_TOURNAMENT_ENABLED: z
        .union([z.boolean(), z.string()])
        .default(true)
        .transform((v) => (typeof v === 'boolean' ? v : !['0', 'false', 'off', 'no'].includes(String(v).toLowerCase()))),

      /**
       * Stage-3 paper-trading ops kill-switch (TRK-academy.paper-trading).
       * When false, paperDrill / paperOps refuse `academy.paper_trading_disabled`.
       * Live trade on svc-trade is unaffected.
       */
      ACADEMY_PAPER_TRADING_ENABLED: z
        .union([z.boolean(), z.string()])
        .default(true)
        .transform((v) => (typeof v === 'boolean' ? v : !['0', 'false', 'off', 'no'].includes(String(v).toLowerCase()))),

      /**
       * Owner-published ambassador IFC pay rate authority (D26-P1-C2).
       * Blank → unpublished / refuse-closed. Never invent session credits.
       * Shape: {"published":true,"sessionCredit":"10.00000000","asset":"IFC","period":"session"}
       */
      ACADEMY_AMBASSADOR_IFC_PAY_LAW_JSON: z.string().optional().default(''),

      /**
       * Owner-published ambassador revenue-share rate authority (D26-P1-C2).
       * Blank → unpublished / refuse-closed. Never invent fee %.
       * Shape: {"published":true,"shareOfFeeBps":500,"feeBasis":"lobby_host_fees"}
       */
      ACADEMY_AMBASSADOR_REVENUE_SHARE_LAW_JSON: z.string().optional().default(''),

      /**
       * svc-trade public REST (`GET /api/v1/markets` paper flag).
       * Blank / unset → paper drills refuse `academy.paper_flag_unverified`
       * rather than trusting `paper: true` from the caller. No default URL:
       * a localhost fallback would look verified while trade is absent.
       */
      TRADE_URL: z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), z.string().url().optional()),

      /**
       * Owner-published page size for paper-flag `GET /api/v1/markets?limit=`.
       * Matches trade 1..500. Blank / unset is unpublished — paper flag port
       * refuses `academy.paper_markets_limit_unset`. A git default of 50
       * looks published. Never invent 50.
       */
      ACADEMY_PAPER_MARKETS_LIMIT: z.preprocess(
        (v) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : v),
        z.union([z.undefined(), z.coerce.number().int().min(1).max(500)]),
      ),

      /**
       * Stored VOD (TRK-academy.video). Blank = unconfigured refuse
       * `academy.video_storage_unconfigured`. Not LiveKit.
       * MinIO compose is profile-gated default off.
       */
      ACADEMY_VIDEO_S3_ENDPOINT: z.string().optional().default(''),
      ACADEMY_VIDEO_S3_BUCKET: z.string().optional().default(''),
      ACADEMY_VIDEO_S3_ACCESS_KEY: z.string().optional().default(''),
      ACADEMY_VIDEO_S3_SECRET_KEY: z.string().optional().default(''),
      /**
       * Owner-published S3 signing region. Blank / unset is unpublished —
       * grant refuses `academy.video_s3_region_unset` when storage is
       * otherwise configured. A git default of us-east-1 looks published.
       * Never invent a region.
       */
      ACADEMY_VIDEO_S3_REGION: z.string().optional().default(''),
      /**
       * Owner-published signed-GET lifetime. Blank / unset is unpublished —
       * grant refuses `academy.video_url_ttl_unset`. A git default of 300
       * looks published. Never invent seconds.
       */
      ACADEMY_VIDEO_URL_TTL_SECONDS: z.preprocess(
        (v) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : v),
        z.union([z.undefined(), z.coerce.number().int().min(1).max(3600)]),
      ),
      /** Blank = unpublished magnitudes, grant refuse-closed. */
      ACADEMY_VIDEO_MIN_TIER: z.string().optional().default(''),
      ACADEMY_VIDEO_MIN_STAKE: z.string().optional().default(''),

      /**
       * Owner-published cap on unauthenticated certVerify calls per address
       * per window. Blank / unset is unpublished — certVerify refuses
       * `academy.verify_rate_unset`. Never invent a count or a window.
       */
      ACADEMY_CERT_VERIFY_RATE_MAX: z.preprocess(
        (v) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : v),
        z.union([z.undefined(), z.coerce.number().int().min(1).max(10_000)]),
      ),
      ACADEMY_CERT_VERIFY_RATE_WINDOW_SECONDS: z.preprocess(
        (v) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : v),
        z.union([z.undefined(), z.coerce.number().int().min(1).max(86_400)]),
      ),

      /**
       * AC-roles-01: owner cap on the number of custom course roles. Blank is
       * unpublished — createCustomRole refuses `academy.role_limit_unset`.
       */
      ACADEMY_CUSTOM_ROLE_LIMIT: z.preprocess(
        (v) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : v),
        z.union([z.undefined(), z.coerce.number().int().min(1).max(1_000)]),
      ),
    }),
  );

export const env = loadEnv(schema);
export type Env = typeof env;
