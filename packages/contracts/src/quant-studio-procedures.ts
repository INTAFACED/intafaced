import { z } from 'zod';
import { defineProcedure, type Refusals } from './procedure.js';
import { quantCompileOutputSchema, quantSignalRulesSchema, quantVersionDiffSchema } from './quant-algo.js';
import {
  quantAccountField,
  quantClientIdField,
  quantDecimalSchema,
  quantEnvironmentInputSchema,
  quantStrategyDetailForLiveSchema,
  quantStrategyDetailRecordSchema,
  quantStrategyHeadRecordSchema,
  quantStudioBlockSchema,
  quantStudioRiskInputSchema,
  quantWriteKeyField,
} from './quant-wire.js';

/**
 * svc-quant's saved strategies (AL-editor-01), one record per call: the reads (`studio.list`, `get`, `diff`,
 * `listDeleted`), the no-code builder's check (`compile`) and the writes (`save`, `update`, `organise`, `delete`,
 * `restore`). Simulated strategies; none moves value. svc-quant mounts each from here (`routes/studio.ts`); the customer
 * app and svc-trade's live runner call each by its record.
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

/** What every keyed write of a strategy can refuse before it is stored: its key, and a key already used for another write. */
const WRITE_KEY = {
  'quant.idempotency_key_unset': 'BAD_REQUEST',
  'quant.idempotency_conflict': 'BAD_REQUEST',
  'quant.params_invalid': 'BAD_REQUEST',
} as const satisfies Refusals;

/** What a save or revision checks in the strategy itself (`studio/save.ts`, `studio/modules.ts`, the release note). */
const SAVE_BODY = {
  'quant.cash_unset': 'BAD_REQUEST',
  'quant.studio_risk_block_required': 'BAD_REQUEST',
  'quant.environment_required': 'BAD_REQUEST',
  'quant.environment_unknown': 'BAD_REQUEST',
  'quant.simulated_as_live': 'BAD_REQUEST',
  'quant.param_unset': 'BAD_REQUEST',
  'quant.param_out_of_range': 'BAD_REQUEST',
  'quant.sizing_rule_unset': 'BAD_REQUEST',
  'quant.release_note_limit_unset': 'PRECONDITION_FAILED',
} as const satisfies Refusals;

const RISK = { maxDrawdown: '500', maxNotional: '10000', kill: '100' };
const BLOCK = { side: 'buy', symbol: 'BTC/USDT', qty: '1' };

/** A save's body as sent; the handler checks each field by name. */
const saveBody = {
  name: z.string().min(1).max(128),
  blocks: z.array(quantStudioBlockSchema),
  modules: quantSignalRulesSchema.optional().nullable(),
  risk: quantStudioRiskInputSchema,
  cash: quantDecimalSchema.optional().nullable(),
  ...quantAccountField,
  ...quantWriteKeyField,
};

/** A new strategy, version 1, keyed by the caller's `clientStrategyId` and `idempotencyKey`; the same key reads it back. */
export const QUANT_STUDIO_SAVE = defineProcedure({
  ...base,
  name: 'quant.studio.save',
  kind: 'mutation',
  path: 'studio.save',
  refusals: {
    ...NO_DATABASE,
    ...WRITE_KEY,
    ...SAVE_BODY,
    'quant.client_strategy_id_unset': 'BAD_REQUEST',
    'quant.studio_not_found': 'NOT_FOUND',
  },
  input: z.object({ ...saveBody, ...quantClientIdField, releaseNote: z.string().max(2000).optional() }).merge(quantEnvironmentInputSchema),
  output: quantStrategyDetailRecordSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        name: 'TEST',
        blocks: [BLOCK],
        risk: RISK,
        cash: '1000',
        environment: 'paper',
        clientStrategyId: 'c-1',
        idempotencyKey: 'k-1',
      },
    },
    { verdict: 'accept', input: { name: 'TEST', blocks: [] } },
    { verdict: 'refuse', input: { name: '', blocks: [] } },
    { verdict: 'refuse', input: { name: 'TEST', blocks: [{ side: 'hold', symbol: 'BTC/USDT', qty: '1' }] } },
    { verdict: 'refuse', input: { name: 'TEST', blocks: [], cash: 'lots' } },
  ],
});

/** A new version of one of the caller's strategies; refused while a teammate holds its edit lock. */
export const QUANT_STUDIO_UPDATE = defineProcedure({
  ...base,
  name: 'quant.studio.update',
  kind: 'mutation',
  path: 'studio.update',
  refusals: { ...NO_DATABASE, ...WRITE_KEY, ...SAVE_BODY, 'quant.studio_not_found': 'NOT_FOUND', 'quant.edit_locked': 'CONFLICT' },
  input: z.object({ id: z.string().min(1), ...saveBody, releaseNote: z.string().max(2000).optional() }).merge(quantEnvironmentInputSchema),
  output: quantStrategyDetailRecordSchema,
  samples: [
    {
      verdict: 'accept',
      input: { id: 's-1', name: 'TEST', blocks: [BLOCK], risk: RISK, cash: '1000', environment: 'paper', idempotencyKey: 'k-2' },
    },
    { verdict: 'refuse', input: { id: '', name: 'TEST', blocks: [] } },
    { verdict: 'refuse', input: { id: 's-1', name: 'TEST', blocks: [], releaseNote: 'x'.repeat(2001) } },
  ],
});

/**
 * The no-code builder's check: the source the signal rules generate and the inputs they declare. A blank required input
 * refuses by name; nothing runs and nothing is stored.
 */
export const QUANT_STUDIO_COMPILE = defineProcedure({
  ...base,
  name: 'quant.studio.compile',
  kind: 'query',
  path: 'studio.compile',
  refusals: {
    'quant.param_unset': 'BAD_REQUEST',
    'quant.param_out_of_range': 'BAD_REQUEST',
    'quant.sizing_rule_unset': 'BAD_REQUEST',
    'quant.params_invalid': 'BAD_REQUEST',
  },
  input: z.object({ modules: quantSignalRulesSchema, ...quantAccountField }),
  output: quantCompileOutputSchema,
  samples: [
    {
      verdict: 'accept',
      input: {
        modules: {
          symbol: 'BTC/USDT',
          barSize: '1h',
          signal: { kind: 'ma_cross', average: 'sma', fast: '1', slow: '2' },
          sizing: { kind: 'quantity', value: '1' },
          exit: { stopLossPercent: '', takeProfitPercent: '' },
        },
      },
    },
    { verdict: 'refuse', input: {} },
    { verdict: 'refuse', input: { modules: { symbol: 'BTC/USDT' } } },
  ],
});

/** Moves one of the caller's strategies to the recycle bin; the screen keys it `studio.delete:<id>:<restores>`. */
export const QUANT_STUDIO_DELETE = defineProcedure({
  ...base,
  name: 'quant.studio.delete',
  kind: 'mutation',
  path: 'studio.delete',
  refusals: { ...NO_DATABASE, ...WRITE_KEY, 'quant.studio_not_found': 'NOT_FOUND' },
  input: z.object({ id: z.string().min(1), ...quantAccountField, ...quantWriteKeyField }),
  output: z.object({ ok: z.literal(true) }),
  samples: [
    { verdict: 'accept', input: { id: 's-1', idempotencyKey: 'studio.delete:s-1:0' } },
    { verdict: 'refuse', input: { id: '' } },
  ],
});

/**
 * The line difference between two stored versions of one of the caller's strategies: the source, the order blocks and
 * the signal rules. Derived on read. A version the strategy does not have is not found.
 */
export const QUANT_STUDIO_DIFF = defineProcedure({
  ...base,
  name: 'quant.studio.diff',
  kind: 'query',
  path: 'studio.diff',
  refusals: { ...NO_DATABASE, 'quant.studio_not_found': 'NOT_FOUND', 'quant.version_not_found': 'NOT_FOUND' },
  input: z.object({ id: z.string().min(1), from: z.number().int().positive(), to: z.number().int().positive(), ...quantAccountField }),
  output: quantVersionDiffSchema,
  samples: [
    { verdict: 'accept', input: { id: 's-1', from: 1, to: 2 } },
    { verdict: 'refuse', input: { id: 's-1', from: 0, to: 2 } },
    { verdict: 'refuse', input: { id: '', from: 1, to: 2 } },
  ],
});

/** Text the handler checks by name (`organisationOf`): a non-text value is refused as `quant.params_invalid`. */
const organiseField = z.union([z.string(), z.number(), z.boolean(), z.null()]).optional();

/**
 * Rename, move to a folder and describe one of the caller's strategies. The head changes and no version is added. All
 * three are sent each time; the screen keys the write `studio.organise:<id>:<organised>`.
 */
export const QUANT_STUDIO_ORGANISE = defineProcedure({
  ...base,
  name: 'quant.studio.organise',
  kind: 'mutation',
  path: 'studio.organise',
  refusals: { ...NO_DATABASE, ...WRITE_KEY, 'quant.studio_not_found': 'NOT_FOUND' },
  input: z.object({
    id: z.string().min(1),
    name: organiseField,
    folder: organiseField,
    description: organiseField,
    ...quantAccountField,
    ...quantWriteKeyField,
  }),
  output: quantStrategyDetailRecordSchema,
  samples: [
    { verdict: 'accept', input: { id: 's-1', name: 'TEST', folder: 'swing', description: '', idempotencyKey: 'studio.organise:s-1:0' } },
    { verdict: 'accept', input: { id: 's-1', name: 7 } },
    { verdict: 'refuse', input: { id: '' } },
    { verdict: 'refuse', input: { id: 's-1', name: { text: 'TEST' } } },
  ],
});

/** Brings a deleted strategy back with the versions it had; one not deleted returns its head unchanged. */
export const QUANT_STUDIO_RESTORE = defineProcedure({
  ...base,
  name: 'quant.studio.restore',
  kind: 'mutation',
  path: 'studio.restore',
  refusals: { ...NO_DATABASE, ...WRITE_KEY, 'quant.studio_not_found': 'NOT_FOUND' },
  input: z.object({ id: z.string().min(1), ...quantAccountField, ...quantWriteKeyField }),
  output: quantStrategyDetailRecordSchema,
  samples: [
    { verdict: 'accept', input: { id: 's-1', idempotencyKey: 'studio.restore:s-1:' } },
    { verdict: 'refuse', input: { id: '' } },
  ],
});

/** The recycle bin: the caller's deleted strategies, with the same page limit rule as `studio.list`. */
export const QUANT_STUDIO_LIST_DELETED = defineProcedure({
  ...base,
  name: 'quant.studio.listDeleted',
  kind: 'query',
  path: 'studio.listDeleted',
  refusals: QUANT_STUDIO_LIST.refusals,
  input: QUANT_STUDIO_LIST.input,
  output: QUANT_STUDIO_LIST.output,
  samples: [
    { verdict: 'accept', input: { limit: 20 } },
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: { limit: 0 } },
  ],
});

export const QUANT_STUDIO_PROCEDURES = [
  QUANT_STUDIO_LIST,
  QUANT_STUDIO_GET,
  QUANT_STUDIO_SAVE,
  QUANT_STUDIO_UPDATE,
  QUANT_STUDIO_COMPILE,
  QUANT_STUDIO_DELETE,
  QUANT_STUDIO_DIFF,
  QUANT_STUDIO_ORGANISE,
  QUANT_STUDIO_RESTORE,
  QUANT_STUDIO_LIST_DELETED,
] as const;
