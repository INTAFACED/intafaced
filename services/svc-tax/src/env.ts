import { z } from 'zod';
import {
  baseEnvSchema,
  edgeEnvSchema,
  httpEnvSchema,
  internalServiceEnvSchema,
  loadEnv,
  otelEnvSchema,
  postgresEnvSchema,
  s2sEnvSchema,
} from '@intafaced/config';
import { TAX_DATABASE_POOL_MAX_UNSET } from './codes.js';

/**
 * svc-tax — lot export. Ledger reads live on svc-ledger. Customer basis rows, when
 * DATABASE_URL is set, live in this service's own `tax` schema and move no money.
 *
 * TAX_JURISDICTION_MAP_JSON is owner/counsel config. Blank is allowed at boot
 * and refused by name at the door (`tax.jurisdiction_unmapped`). Never default
 * a country.
 *
 * HTTP_PORT 4020: 4000–4019 are taken by the existing fleet.
 */
const blankAsAbsent = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess((v) => (typeof v === 'string' && v.trim() === '' ? undefined : v), inner);

/** Same field ledger and the other schema owners refuse with. Blank is not a size. */
const databasePoolMax = postgresEnvSchema.shape.DATABASE_POOL_MAX;

function poolBlank(value: unknown): boolean {
  return value === undefined || (typeof value === 'string' && value.trim() === '');
}

const schema = baseEnvSchema
  .merge(otelEnvSchema)
  .merge(httpEnvSchema)
  .merge(edgeEnvSchema)
  .merge(internalServiceEnvSchema)
  .merge(s2sEnvSchema)
  .merge(
    z.object({
      SERVICE_NAME: z.string().default('svc-tax'),
      HTTP_PORT: z.coerce.number().int().positive().default(4020),
      LEDGER_URL: z.string().url().default('http://localhost:4001'),
      /**
       * Owner JSON: object keyed by ISO-3166 alpha-2, or an array of those codes.
       * Blank / empty → procedures refuse `tax.jurisdiction_unmapped`.
       */
      TAX_JURISDICTION_MAP_JSON: z.string().default(''),
      /**
       * Owner-published ledger history window in years. Blank / unset is
       * unpublished — export refuses `tax.history_years_unset`. A git default
       * of 10 looks published. Never invent a window. Owner may set 10 explicitly.
       */
      TAX_HISTORY_YEARS: z.preprocess(
        (v) => (v === undefined || (typeof v === 'string' && v.trim() === '') ? undefined : v),
        z.union([z.undefined(), z.coerce.number().int().min(1).max(100)]),
      ),
      /** Blank → `absent`. Set → `configured`/`tax.data_lake_unprobed`, never `ok`. */
      CONNECT_DATA_LAKE_TSDB_URL: blankAsAbsent(z.string().url().optional()),
      /** Blank → `absent`. Set → `configured`/`tax.indexer_unprobed`, never `ok`. */
      INDEXER_URL: blankAsAbsent(z.string().url().optional()),
      /**
       * svc-trade's public market data, for the price of a coin when it arrived (the lot book). Blank: arrivals are not
       * valued and the book names `tax.price_at_time_unavailable`.
       */
      TRADE_URL: blankAsAbsent(z.string().url().optional()),
      /**
       * Owner policy for the cost of a deposit, reward or transfer in: `market` (its value when it arrived) or `customer`
       * (unknown until the customer enters one). Blank: unknown, named `tax.deposit_basis_policy_unset`. Never a default.
       */
      TAX_DEPOSIT_BASIS: blankAsAbsent(z.enum(['market', 'customer']).optional()),
      /**
       * Customer-entered basis. Blank: `tax.basisOverride.set` refuses `tax.basis_store_unwired`.
       * Not a default database, and not a balance.
       */
      DATABASE_URL: blankAsAbsent(z.string().url().optional()),
      /**
       * Owner pool size, parsed by `postgresEnvSchema` when `DATABASE_URL` is set.
       * Blank refuses `tax.database_pool_max_unset`. Never a filled-in size.
       * Unused when the URL is blank, so the lot book can still boot.
       */
      DATABASE_POOL_MAX: z.unknown().optional(),
    }),
  )
  .superRefine((value, ctx) => {
    if (value.DATABASE_URL === undefined) return;
    const parsed = databasePoolMax.safeParse(value.DATABASE_POOL_MAX);
    if (parsed.success) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['DATABASE_POOL_MAX'],
      message: poolBlank(value.DATABASE_POOL_MAX)
        ? TAX_DATABASE_POOL_MAX_UNSET
        : parsed.error.issues.map((issue) => issue.message).join('; '),
    });
  })
  .transform((value) => {
    if (value.DATABASE_URL === undefined) return { ...value, DATABASE_POOL_MAX: undefined as number | undefined };
    return { ...value, DATABASE_POOL_MAX: databasePoolMax.parse(value.DATABASE_POOL_MAX) };
  });

export type TaxEnv = z.infer<typeof schema>;
export const env: TaxEnv = loadEnv(schema);
