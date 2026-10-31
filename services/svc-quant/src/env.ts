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
      /**
       * Overfitting check (ENGINE BT-9): how far the out-of-sample return may fall below the in-sample return, in
       * percentage points, before a result shows a warning. NO DEFAULT: blank, the check reads "not set" and warns of
       * nothing.
       */
      QUANT_CHECK_MAX_SAMPLE_GAP_PERCENT: blankable(z.string().regex(/^\d{1,6}(\.\d{1,4})?$/)),
      /**
       * Overfitting check (ENGINE BT-9): the most variants of one strategy on one symbol and bar size before a result
       * shows a warning, a whole number. NO DEFAULT: blank, the check reads "not set" and warns of nothing.
       */
      QUANT_CHECK_MAX_VARIANTS: blankable(z.string().regex(/^\d{1,6}$/)),
      /**
       * Sensitivity check (ENGINE BT-9): how far the return may move, in percentage points, when the same run starts one
       * bar later, before a result shows a warning. NO DEFAULT: blank, the check reads "not set" and warns of nothing.
       */
      QUANT_CHECK_MAX_OFFSET_SHIFT_PERCENT: blankable(z.string().regex(/^\d{1,6}(\.\d{1,4})?$/)),
      /**
       * Simulated account (ENGINE RK-5): the highest leverage a margin backtest may use, from 1. The rules of the market
       * simulated, published here until the futures engine publishes its own. NO DEFAULT: blank, a margin run refuses
       * `quant.account_rule_unset` naming it; a cash run is unaffected.
       */
      QUANT_ACCOUNT_MAX_LEVERAGE: blankable(z.string().regex(/^\d{1,4}(\.\d{1,2})?$/)),
      /**
       * Simulated account (ENGINE RK-5): the margin level, equity over the margin used in percent, at which a margin
       * backtest records a margin call. NO DEFAULT: blank, a margin run refuses `quant.account_rule_unset` naming it.
       */
      QUANT_ACCOUNT_MARGIN_CALL_PERCENT: blankable(z.string().regex(/^\d{1,4}(\.\d{1,2})?$/)),
      /**
       * Simulated account (ENGINE RK-5): the margin level in percent at which a margin backtest closes the position (a
       * stop-out), below the margin call level. NO DEFAULT: blank, a margin run refuses `quant.account_rule_unset` naming it.
       */
      QUANT_ACCOUNT_STOP_OUT_PERCENT: blankable(z.string().regex(/^\d{1,4}(\.\d{1,2})?$/)),
      /**
       * Public reads of a share link allowed in one window (AL-report-03). NO DEFAULT: blank refuses
       * `quant.share_rate_unset`. Zero is a real cap and refuses every public read.
       */
      QUANT_SHARE_RATE: blankable(z.string().regex(/^\d{1,7}$/)),
      /**
       * The window those reads are counted in, in whole seconds. NO DEFAULT: blank refuses `quant.share_window_unset`.
       * Never 60 unless the owner sets 60.
       */
      QUANT_SHARE_WINDOW_SEC: blankable(z.string().regex(/^[1-9]\d{0,6}$/)),
      /**
       * Frame origins that may embed a shared result, comma-separated. NO DEFAULT: a blank list refuses only the embed
       * snippet (`quant.embed_origins_unset`). The link still opens.
       */
      QUANT_EMBED_ORIGINS: blankable(z.string().max(2000)),
      /**
       * The longest release note a saved version may carry, in characters (AL-editor-01). NO DEFAULT: blank refuses a
       * save that writes a note (`quant.release_note_limit_unset`); a save without a note still saves. At most 2000.
       */
      QUANT_RELEASE_NOTE_MAX: blankable(z.string().regex(/^(?:[1-9]\d{0,2}|1\d{3}|2000)$/)),
      /**
       * The owner's quota profile for an account no operator has assigned one (AL-limits-01). Blank refuses every new
       * strategy, version and run of such an account with `quant.quota_profile_unset`; nothing is assumed.
       */
      QUANT_DEFAULT_QUOTA_PROFILE: blankable(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 _-]{0,47}$/)),
      /** Required only when DATABASE_URL is set. Blank is not 10. */
      DATABASE_POOL_MAX: z
        .string()
        .optional()
        .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim())),
    }),
  );

export const env = loadEnv(schema);
export type QuantEnv = typeof env;
