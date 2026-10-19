import { z } from 'zod';
import { baseEnvSchema, edgeEnvSchema, httpEnvSchema, loadEnv, otelEnvSchema, s2sEnvSchema } from '@intafaced/config';

/**
 * svc-execution — house-tenant mechanism + OMS plan/execute (D26-P1-X3).
 *
 * No Postgres: the sealed registry is in-process. No REDIS/NATS/DATABASE_URL —
 * this process holds no balances (Doctrine §0.6). House fills would use
 * `packages/ledger-client` recipes later; this service does not invent accounts.
 *
 * External spot trade adapters wire when `EXECUTION_VENUE_IDS` lists a known
 * public spot id and matching `EXECUTION_VENUE_<ID>_API_KEY` / `_API_SECRET`
 * (optional `_PASSPHRASE` for okx-spot) are set. Unset → refuse-closed.
 *
 * HTTP_PORT 4019: 4000–4018 are taken by the existing fleet.
 */
/** Compose interpolates unset optional URLs to "". Blank is absent, not an invalid URL. */
const blankAsAbsent = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), inner);

const schema = baseEnvSchema
  .merge(otelEnvSchema)
  .merge(httpEnvSchema)
  .merge(edgeEnvSchema)
  .merge(s2sEnvSchema)
  .merge(
    z.object({
      SERVICE_NAME: z.string().default('svc-execution'),
      HTTP_PORT: z.coerce.number().int().positive().default(4019),
      /**
       * Comma-separated signed spot venue ids for OMS execute/cancel/fetch/openOrders.
       * Empty (default) = no external trade adapters mounted.
       * Known ids: `binance-spot`, `bybit-spot`, `okx-spot`.
       * Unknown id or unset credentials → venue skipped (refuse-closed at call).
       */
      EXECUTION_VENUE_IDS: z.string().default(''),
      /**
       * svc-trade base for OMS book snapshot on venue `intafaced-spot`
       * (`GET /api/v1/orderbook/:symbol`). Unset / blank → snapshot map empty.
       */
      TRADE_URL: blankAsAbsent(z.string().url().optional()),
      /**
       * svc-matching base for TWAP/VWAP/POV start/approve/release halt-all consume
       * (`GET /markets` `venueHalted`). Unset / blank → those doors refuse
       * (missing halt source). Never invent localhost. Never POST /halt-all.
       */
      MATCHING_URL: blankAsAbsent(z.string().url().optional()),
      /**
       * Identity base for founder execution halt consume. Blank → halt refuses
       * action_approval.identity_unwired. In-flight read does not need it.
       */
      IDENTITY_URL: blankAsAbsent(z.string().url().optional()),
      /**
       * JSONL path for durable EMS ack journal. Parent/pause/fill journals sit beside it.
       * Blank → boot throws execution.algo_store_path_unset (never in-memory parents/pauses/fills).
       * Tests inject in-memory stores; they do not boot this process.
       */
      EXECUTION_EMS_STORE_PATH: z.string().default(''),
      /**
       * Owner JSON map of latency letter → routing bps (A/B/C/D/F keys).
       * Blank (default) → letter→bps gate refuses; never invent DEFAULT_THRESHOLDS.
       */
      EXECUTION_SOR_LETTER_BPS_SCHEDULE: z.string().default(''),
      /**
       * Owner JSON inclusive bounds for MM half-spread and inventory skew bps.
       * Blank (default) → spread/skew gate refuses; never invent band magnitudes.
       */
      EXECUTION_MM_SPREAD_SKEW_BANDS: z.string().default(''),
      /**
       * Owner max quote age (ms) for arb scans. Blank (default) → capital gate refuses.
       */
      EXECUTION_ARB_MAX_QUOTE_AGE_MS: z.string().default(''),
      /**
       * Master kill for starting already-approved TWAP/VWAP/POV parents.
       * Default OFF. Only denylist strings enable. Never invent a live schedule when unset.
       */
      EXECUTION_ALGO_JOBS_ENABLED: z
        .union([z.boolean(), z.string()])
        .default(false)
        .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'on', 'yes'].includes(String(v).toLowerCase()))),
      /**
       * connect.data-lake TSDB sink for OMS snapshot capture. Blank → capture-log-only drain.
       */
      CONNECT_DATA_LAKE_TSDB_URL: blankAsAbsent(z.string().url().optional()),
      /** Owner retention days — both TSDB URL and this must be set to persist. */
      CONNECT_DATA_LAKE_RETENTION_DAYS: z.string().default(''),
      /** Optional periodic drain interval (ms). Blank → drain on shutdown only. */
      CONNECT_DATA_LAKE_DRAIN_INTERVAL_MS: z.string().default(''),
    }),
  );

export type ExecutionEnv = z.infer<typeof schema>;
export const env: ExecutionEnv = loadEnv(schema);
