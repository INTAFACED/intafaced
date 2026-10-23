import { z } from 'zod';
import { baseEnvSchema, edgeEnvSchema, httpEnvSchema, loadEnv, otelEnvSchema } from '@intafaced/config';

/**
 * svc-quant environment.
 *
 * No INTERNAL_SERVICE_SECRET: this process cannot reach ledger.post.
 * DATABASE_URL is optional and has no default. Unset, studio and backtest
 * refuse quant.database_url_unset. A URL without DATABASE_POOL_MAX refuses
 * quant.database_pool_max_unset. Pool size is never invented.
 *
 * QUANT_VENUE_VAULT is the Venue Vault trade-only pin. Blank = venue OMS
 * refuses `quant.venue_vault_unset`. Internal book still runs.
 */
/** A setting that is unset when blank, so a blank owner value is never read as a value. */
function blankable<T extends z.ZodTypeAny>(inner: T) {
  return z.preprocess(
    (v) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : String(v).trim()),
    inner.optional(),
  );
}

const schema = baseEnvSchema
  .merge(httpEnvSchema)
  .merge(otelEnvSchema)
  .merge(edgeEnvSchema)
  .merge(
    z.object({
      SERVICE_NAME: z.string().default('svc-quant'),
      HTTP_PORT: z.coerce.number().int().default(4021),

      /** Hang fuse. Not a published product bound — missing env still times out. */
      SANDBOX_TIMEOUT_MS: z.coerce.number().int().min(50).max(10_000).default(500),

      /**
       * Owner-published isolate op budget. Blank / unset is unpublished —
       * sandbox.run refuses `quant.sandbox_max_ops_unset`. A git default of
       * 50000 looks published. Never invent a ceiling. Owner may set 50000
       * explicitly. Hang fuse stays SANDBOX_TIMEOUT_MS.
       */
      SANDBOX_MAX_OPS: z.preprocess(
        (v) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : v),
        z.union([z.undefined(), z.coerce.number().int().min(100).max(1_000_000)]),
      ),

      /**
       * Owner-published isolate source-length ceiling. Blank / unset is
       * unpublished — sandbox.run refuses `quant.sandbox_max_source_unset`.
       * A git default of 8000 looks published. Never invent a ceiling. Owner
       * may set 8000 explicitly.
       */
      SANDBOX_MAX_SOURCE: z.preprocess(
        (v) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : v),
        z.union([z.undefined(), z.coerce.number().int().min(32).max(64_000)]),
      ),

      /**
       * Venue Vault trade-only credential pin. Pass-through, no default.
       * Unset/blank → venue OMS refuses by name. Never invent a key.
       */
      QUANT_VENUE_VAULT: z
        .string()
        .optional()
        .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim())),

      /**
       * Paper strategy library. Blank refuses studio writes. Never a default URL.
       * Not a ledger connection.
       */
      DATABASE_URL: z
        .string()
        .optional()
        .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim())),
      /**
       * svc-trade's base URL, for the bar backtest's two public reads: closed candles and the published fee schedule.
       * Unset leaves both unwired and every bar backtest refuses by name. Never a default URL.
       */
      TRADE_URL: z
        .string()
        .optional()
        .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim())),
      /**
       * Out-of-sample criterion (ENGINE MT-7): the fewest round trips the out-of-sample part must enter before its
       * verdict is judged, a whole number. NO DEFAULT: blank makes every verdict inconclusive with reason
       * `criteria_unset`, naming it; it never reads passed.
       */
      QUANT_OOS_MIN_TRADES: blankable(z.string().regex(/^\d{1,6}$/)),
      /**
       * Out-of-sample criterion (ENGINE MT-7): the lowest out-of-sample return after costs, in percent. NO DEFAULT:
       * blank makes every verdict inconclusive with reason `criteria_unset`, naming it.
       */
      QUANT_OOS_MIN_RETURN_PERCENT: blankable(z.string().regex(/^-?\d{1,6}(\.\d{1,4})?$/)),
      /**
       * Out-of-sample criterion (ENGINE MT-7): the largest out-of-sample fall from a peak, in percent. NO DEFAULT: blank
       * makes every verdict inconclusive with reason `criteria_unset`, naming it.
       */
      QUANT_OOS_MAX_DRAWDOWN_PERCENT: blankable(z.string().regex(/^\d{1,3}(\.\d{1,4})?$/)),
      /**
       * Out-of-sample criterion (ENGINE MT-7): how far the out-of-sample return may fall below the in-sample return, in
       * percentage points. NO DEFAULT: blank makes every verdict inconclusive with reason `criteria_unset`, naming it.
       */
      QUANT_OOS_MAX_SHORTFALL_PERCENT: blankable(z.string().regex(/^\d{1,6}(\.\d{1,4})?$/)),
      /**
       * The owner's holdout (ENGINE BT-9): bars from this point on are kept out of every in-sample part when a run asks to
       * enforce it. An instant with its UTC offset, or an ISO duration (PT6H, P30D) read as that long before the request.
       * NO DEFAULT: blank, a run that asks to enforce it refuses `quant.holdout_date_unset`.
       */
      QUANT_HOLDOUT_START: blankable(
        z.string().regex(/^(\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:\d{2})|P(?=.*[1-9])(\d+D)?(T(?=\d)(\d+H)?(\d+M)?)?)$/i),
      ),
      /** Required only when DATABASE_URL is set. Blank is not 10. */
      DATABASE_POOL_MAX: z
        .string()
        .optional()
        .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim())),
    }),
  );

export const env = loadEnv(schema);
export type QuantEnv = typeof env;
