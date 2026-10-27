import { z } from 'zod';
import { blankAsUnset } from '@intafaced/service-kit';
import { ACADEMY_DISCUSSION_IMAGE_MAX_BYTES } from '@intafaced/contracts';
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
const MIME_TYPE = /^[a-z]+\/[a-z0-9.+-]+$/;
/** A comma-separated list; blank is unset. */
const mimeList = (v: unknown) =>
  v === undefined || (typeof v === 'string' && v.trim() === '')
    ? undefined
    : typeof v === 'string'
      ? v
          .split(',')
          .map((t) => t.trim().toLowerCase())
          .filter(Boolean)
      : v;

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
       * AC-progress-02: how many to-do items one learner may keep in the planner. Blank / unset is unpublished: adding
       * refuses `academy.planner_limit_unset`. Never invent a cap.
       */
      ACADEMY_PLANNER_TODO_LIMIT: z.preprocess(
        (v) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : v),
        z.union([z.undefined(), z.coerce.number().int().min(1).max(10_000)]),
      ),

      /**
       * AC-course-structure-02: how many sections one course outline may hold. Blank / unset is unpublished: saving an
       * outline refuses `academy.outline_limits_unset`. Never invent a limit.
       */
      ACADEMY_OUTLINE_MAX_SECTIONS: z.preprocess(
        (v) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : v),
        z.union([z.undefined(), z.coerce.number().int().min(1).max(1000)]),
      ),
      /**
       * AC-course-structure-02: how many items a learner can open (subheaders are labels and are not counted) one course
       * outline may hold in all. Blank / unset is unpublished: saving an outline refuses `academy.outline_limits_unset`.
       */
      ACADEMY_OUTLINE_MAX_ITEMS: z.preprocess(
        (v) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : v),
        z.union([z.undefined(), z.coerce.number().int().min(1).max(1000)]),
      ),

      /**
       * AC-course-structure-03: the largest lesson file, in bytes, the Academy desk imports. Blank / unset is
       * unpublished: an import refuses `academy.import_limit_unset`, and a larger file refuses `academy.import_too_large`
       * before it is parsed.
       */
      ACADEMY_LESSON_IMPORT_MAX_BYTES: z.preprocess(
        (v) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : v),
        z.union([z.undefined(), z.coerce.number().int().min(1).max(1_048_576)]),
      ),

      /**
       * AC-programmes-01: how many courses one learning programme may hold. Blank / unset is unpublished: a programme save
       * with courses refuses `academy.programme_limit_unset`.
       */
      ACADEMY_PROGRAMME_MAX_COURSES: z.preprocess(
        (v) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : v),
        z.union([z.undefined(), z.coerce.number().int().min(1).max(100)]),
      ),

      /**
       * AC-rooms-01: the longest discussion post or reply, in characters. Blank / unset is unpublished: posting refuses
       * `academy.post_limit_unset`.
       */
      ACADEMY_POST_MAX_CHARS: z.preprocess(
        (v) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : v),
        z.union([z.undefined(), z.coerce.number().int().min(1).max(20_000)]),
      ),

      /**
       * AC-rooms-01: the largest image, in bytes, one discussion post may carry. Blank / unset is unpublished: a post with an
       * image refuses `academy.attachment_limit_unset`; a post without one is not affected.
       */
      ACADEMY_POST_IMAGE_MAX_BYTES: z.preprocess(
        (v) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : v),
        z.union([z.undefined(), z.coerce.number().int().min(1).max(ACADEMY_DISCUSSION_IMAGE_MAX_BYTES)]),
      ),

      /**
       * AC-rooms-04: the longest message to or from a course team, in characters. Blank / unset is unpublished: sending
       * refuses `academy.message_limit_unset`.
       */
      ACADEMY_MESSAGE_MAX_CHARS: z.preprocess(
        (v) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : v),
        z.union([z.undefined(), z.coerce.number().int().min(1).max(20_000)]),
      ),

      /**
       * AC-quizzes-01: the proxies (comma-separated CIDR ranges) whose `x-intafaced-client-ip` header names the caller.
       * Blank / unset: no caller address can be read, so a quiz with an IP filter refuses `academy.ip_unreadable`.
       */
      ACADEMY_TRUSTED_PROXY_CIDRS: z.preprocess(
        (v) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : v),
        z.union([z.undefined(), z.string().max(4000)]),
      ),

      /**
       * AC-certificates-02: seconds between issue sweeps, which issue delayed certificates once due. Blank / unset is
       * unpublished: no sweep runs and a delayed issue rule refuses `academy.cert_sweep_unset`.
       */
      ACADEMY_CERT_ISSUE_SWEEP_SECONDS: z.preprocess(
        (v) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : v),
        z.union([z.undefined(), z.coerce.number().int().min(1).max(86_400)]),
      ),

      /**
       * AC-assignments-02: how many seconds a grader holds a hand-in while grading it. Blank / unset is unpublished:
       * grading refuses `academy.grader_lease_unset`.
       */
      ACADEMY_GRADER_LEASE_SECONDS: z.preprocess(
        (v) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : v),
        z.union([z.undefined(), z.coerce.number().int().min(1).max(86_400)]),
      ),

      /**
       * AC-assignments-04: how many learner rows one grade report may hold. Blank / unset is unpublished: a report refuses
       * `academy.report_limit_unset`.
       */
      ACADEMY_GRADE_REPORT_ROWS: blankAsUnset(z.coerce.number().int().min(1).max(100_000)),

      /**
       * AC-articles-01: how many topics the founder console's topic list shows. Blank / unset is unpublished: the list
       * refuses `academy.topics_list_limit_unset`.
       */
      ACADEMY_TOPICS_LIST_LIMIT: z.preprocess(
        (v) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : v),
        z.union([z.undefined(), z.coerce.number().int().min(1).max(1000)]),
      ),

      /**
       * AC-videos-02: the largest video or handout, in bytes, the Academy desk uploads. Blank / unset is unpublished:
       * an upload refuses `academy.upload_limits_unset`, and a larger file refuses `academy.upload_too_large` before an
       * upload address is issued.
       */
      ACADEMY_UPLOAD_MAX_BYTES: z.preprocess(
        (v) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : v),
        z.union([z.undefined(), z.coerce.number().int().min(1).max(5_368_709_120)]),
      ),

      /**
       * AC-videos-02: the video types the Academy desk accepts, comma-separated (for example `video/mp4,video/webm`).
       * Blank / unset is unpublished: a video upload refuses `academy.upload_limits_unset`.
       */
      ACADEMY_UPLOAD_VIDEO_TYPES: z.preprocess(mimeList, z.union([z.undefined(), z.array(z.string().regex(MIME_TYPE)).min(1)])),

      /**
       * AC-videos-02: the handout types the Academy desk accepts, comma-separated (for example `application/pdf`).
       * Blank / unset is unpublished: a handout upload refuses `academy.upload_limits_unset`.
       */
      ACADEMY_UPLOAD_HANDOUT_TYPES: z.preprocess(mimeList, z.union([z.undefined(), z.array(z.string().regex(MIME_TYPE)).min(1)])),

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
      /**
       * Owner-published seconds of stored watch position that count as
       * watched (AC-videos-01). Blank / unset is unpublished —
       * `videoProgress.watched` refuses `academy.watch_threshold_unset`.
       * Zero is not a threshold: it would mark a video watched before any
       * position was stored. Never invent a fraction of the duration.
       */
      ACADEMY_VIDEO_WATCH_THRESHOLD_SECONDS: z.preprocess(
        (v) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : v),
        z.union([z.undefined(), z.coerce.number().int().min(1).max(86_400)]),
      ),
      /**
       * Owner-published seconds between watch-position saves while a video
       * plays (AC-videos-01). Blank / unset: the player saves on pause and on
       * leaving only, and says the interval is not set.
       */
      ACADEMY_VIDEO_POSITION_SAVE_SECONDS: z.preprocess(
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
    }),
  );

export const env = loadEnv(schema);
export type Env = typeof env;
