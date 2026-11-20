import { z } from 'zod';
import { defineProcedure, type Refusals } from './procedure.js';
import { quantAccountField, quantStrategyDetailForLiveSchema, quantStrategyHeadRecordSchema } from './quant-wire.js';

/**
 * svc-quant's reads of the account's saved strategies (AL-editor-01), one record per call: a page of them (`studio.list`)
 * and one with every version (`studio.get`). Simulated strategies; neither moves value. svc-quant mounts each from here
 * (`routes/studio.ts`); the customer app and svc-trade's live runner call each by its record.
 */

/** Served wherever quant's fiat plane is, with or without a principal; the handler resolves the account itself. */
const ACCESS = { caller: 'jurisdiction', module: 'quant', plane: 'fiat' } as const;
const base = { service: 'svc-quant', module: 'quant', transport: 'trpc', access: ACCESS } as const;

/** The largest page `studio.list` reads; a page size is the caller's, never assumed (`quant.studio_list_limit_unset`). */
export const QUANT_STUDIO_LIST_LIMIT_CAP = 50;

/** No database wired: every read of the strategy store refuses by name (`studio/open.ts`). The status is `toTrpc`'s. */
const NO_DATABASE = {
  'quant.database_url_unset': 'PRECONDITION_FAILED',
  'quant.database_pool_max_unset': 'PRECONDITION_FAILED',
} as const satisfies Refusals;

const ACCOUNT = '11111111-1111-4111-8111-111111111111';

/**
 * Saved strategies for the caller's account. `limit` is optional so omit reaches `quant.studio_list_limit_unset` instead
 * of a Zod "Required"; blank is not 50. Deleted rows are absent.
 */
export const QUANT_STUDIO_LIST = defineProcedure({
  ...base,
  name: 'quant.studio.list',
  kind: 'query',
  path: 'studio.list',
  refusals: {
    ...NO_DATABASE,
    'quant.studio_list_limit_unset': 'PRECONDITION_FAILED',
    'quant.list_cursor_invalid': 'BAD_REQUEST',
  },
  input: z
    .object({
      limit: z.number().int().min(1).max(QUANT_STUDIO_LIST_LIMIT_CAP).optional(),
      cursor: z.string().optional().nullable(),
      ...quantAccountField,
    })
    .optional(),
  output: z.object({ strategies: z.array(quantStrategyHeadRecordSchema), nextCursor: z.string().nullable() }),
  samples: [
    { verdict: 'accept', input: { limit: 20 } },
    { verdict: 'accept', input: { limit: 20, cursor: 'c-1', accountId: ACCOUNT } },
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: { limit: 0 } },
    { verdict: 'refuse', input: { limit: QUANT_STUDIO_LIST_LIMIT_CAP + 1 } },
  ],
});

/** One of the account's strategies with every version, and what its live approval policy allows (J-algo-dev-16 #4). */
export const QUANT_STUDIO_GET = defineProcedure({
  ...base,
  name: 'quant.studio.get',
  kind: 'query',
  path: 'studio.get',
  refusals: { ...NO_DATABASE, 'quant.studio_not_found': 'NOT_FOUND' },
  input: z.object({ id: z.string().min(1), ...quantAccountField }),
  output: quantStrategyDetailForLiveSchema,
  samples: [
    { verdict: 'accept', input: { id: 's-1' } },
    { verdict: 'accept', input: { id: 's-1', accountId: ACCOUNT } },
    { verdict: 'refuse', input: { id: '' } },
    { verdict: 'refuse', input: { id: 's-1', accountId: 'not-a-uuid' } },
  ],
});

export const QUANT_STUDIO_PROCEDURES = [QUANT_STUDIO_LIST, QUANT_STUDIO_GET] as const;
