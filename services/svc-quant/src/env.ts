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
      /** Required only when DATABASE_URL is set. Blank is not 10. */
      DATABASE_POOL_MAX: z
        .string()
        .optional()
        .transform((v) => (v === undefined || v.trim() === '' ? undefined : v.trim())),
    }),
  );

export const env = loadEnv(schema);
export type QuantEnv = typeof env;
