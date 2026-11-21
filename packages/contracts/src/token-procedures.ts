import { z } from 'zod';
import { assetIdSchema } from './asset-id.js';
import { defineProcedure, NO_INPUT, type Refusals } from './procedure.js';
import { tokenAccessViewSchema, tokenAmountSchema as amount, tokenBurnedSupplySchema, tokenStakeViewSchema } from './token-governance.js';

/**
 * svc-token's calls an app makes, one record per call. svc-token mounts each from here (`mountRecord` in its router,
 * which is not made from records as a whole yet), so its path, guard, input, output and named refusals are this file.
 * A `TokenError` leaves with the status svc-token's `toTrpcError` gives its code; the lists below say which may leave.
 */

const base = { service: 'svc-token', module: 'token', transport: 'trpc' } as const;
/** A token reader, on the token module's jurisdiction check. */
const READER = { caller: 'scope', scope: 'token:read', module: 'token' } as const;
/** A token reader with no module check (a public supply figure). */
const ANY_READER = { caller: 'scope', scope: 'token:read' } as const;

const freeze = (r: Refusals): Refusals => Object.freeze(r);
const PARAMS_REASON = z.enum(['token.params_unset', 'token.params_missing', 'token.params_invalid']);
const iso = z.string().datetime({ offset: true });
const bps = z.number().int().min(0).max(10_000);

/** A page of history: the size is optional so an omit reaches `token.history_list_limit_unset`, never a zod "Required". */
export const tokenHistoryInputSchema = z
  .object({
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.string().min(1).max(512).optional(),
  })
  .default({});

/** A payout history page (`yieldHistory`, `revenueShareHistory`): one row per weekly window, read from its posting. */
export const tokenPayoutHistorySchema = z.object({
  items: z.array(
    z.object({
      windowId: z.string(),
      amount: amount.nullable(),
      assetId: assetIdSchema.nullable(),
      ledgerTxId: z.string().nullable(),
      reason: z.literal('ledger_tx_unread').nullable(),
    }),
  ),
  nextCursor: z.string().nullable(),
});

export const TOKEN_ACCESS_OF = defineProcedure({
  ...base,
  name: 'token.accessOf',
  kind: 'query',
  path: 'accessOf',
  access: READER,
  refusals: freeze({
    'token.params_unset': 'PRECONDITION_FAILED',
    'token.params_invalid': 'BAD_REQUEST',
    'token.fee_discount_invalid': 'BAD_REQUEST',
    'token.stake_ledger_mismatch': 'PRECONDITION_FAILED',
  }),
  input: z.object({}).optional(),
  output: tokenAccessViewSchema,
  samples: [{ verdict: 'accept' }, { verdict: 'accept', input: {} }, { verdict: 'refuse', input: 7 }],
});

export const TOKEN_LIST_STAKES = defineProcedure({
  ...base,
  name: 'token.listStakes',
  kind: 'query',
  path: 'listStakes',
  access: READER,
  refusals: freeze({ 'token.stakes_list_limit_unset': 'PRECONDITION_FAILED' }),
  input: z
    .object({
      status: z.enum(['active', 'closed', 'pending', 'all']).default('active'),
      /** Optional so an omit reaches `token.stakes_list_limit_unset`; blank is not 50. */
      limit: z.number().int().min(1).max(200).optional(),
    })
    .default({ status: 'active' }),
  output: z.array(tokenStakeViewSchema),
  samples: [
    { verdict: 'accept', input: { status: 'all', limit: 50 } },
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: { status: 'gone' } },
    { verdict: 'refuse', input: { limit: 0 } },
  ],
});

export const TOKEN_EMISSION_SCHEDULE = defineProcedure({
  ...base,
  name: 'token.emissionSchedule',
  kind: 'query',
  path: 'emissionSchedule',
  access: READER,
  refusals: freeze({ 'token.emission_schedule_count_unset': 'PRECONDITION_FAILED' }),
  input: z.object({ count: z.number().int().min(1).max(200).optional() }).default({}),
  output: z.object({
    params: z
      .object({
        initialEpochReward: amount,
        halvingIntervalEpochs: z.number().int().positive(),
        maxSupply: amount,
      })
      .nullable(),
    epochs: z.array(z.object({ epoch: z.number().int().nonnegative(), reward: amount })).nullable(),
    missing: z.string().nullable(),
    reason: PARAMS_REASON.nullable(),
  }),
  accept: {
    setOrRefused: {
      says: 'the owner parameters are there exactly when no reason is given',
      holds: (reply) =>
        typeof reply === 'object' &&
        reply !== null &&
        'params' in reply &&
        'reason' in reply &&
        (reply.params === null) === (reply.reason !== null),
    },
  },
  samples: [
    { verdict: 'accept', input: { count: 12 } },
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: { count: 0 } },
  ],
});

export const TOKEN_REVENUE_SHARE_HISTORY = defineProcedure({
  ...base,
  name: 'token.revenueShareHistory',
  kind: 'query',
  path: 'revenueShareHistory',
  access: READER,
  refusals: freeze({ 'token.history_list_limit_unset': 'PRECONDITION_FAILED', 'token.history_cursor_invalid': 'BAD_REQUEST' }),
  input: tokenHistoryInputSchema,
  output: tokenPayoutHistorySchema,
  samples: [
    { verdict: 'accept', input: { limit: 50 } },
    { verdict: 'accept', input: { limit: 50, cursor: 'c-1' } },
    { verdict: 'refuse', input: { limit: 201 } },
  ],
});

/**
 * `burned` is the `burnedSupply` balance; `minted`, `bought`, `toRewards` and `distributed` are sums of rows svc-token
 * stored. Null on those sums, and a null `lastBuyback`, means no rows, not zero. No price.
 */
export const TOKEN_TREASURY = defineProcedure({
  ...base,
  name: 'token.treasury',
  kind: 'query',
  path: 'treasury',
  access: READER,
  refusals: freeze({ 'token.treasury_figure_unreadable': 'PRECONDITION_FAILED' }),
  input: NO_INPUT,
  output: z.object({
    minted: amount.nullable(),
    burned: amount,
    bought: amount.nullable(),
    toRewards: amount.nullable(),
    distributed: amount.nullable(),
    lastBuyback: z.object({ bought: amount, burned: amount, toRewards: amount, executedAt: iso }).nullable(),
  }),
  samples: [{ verdict: 'accept' }],
});

/** Stored buyback runs, the job's state and the rate (or why the rate is blank). */
export const TOKEN_BUYBACK_RUNS = defineProcedure({
  ...base,
  name: 'token.buybackRuns',
  kind: 'query',
  path: 'buybackRuns',
  access: READER,
  refusals: freeze({ 'token.treasury_figure_unreadable': 'PRECONDITION_FAILED' }),
  input: z.object({ limit: z.number().int().min(1).max(200) }),
  output: z.object({
    job: z.enum(['set', 'unset']),
    runs: z.array(
      z.object({
        id: z.string().min(1),
        bought: amount,
        burned: amount,
        toRewards: amount,
        executedAt: iso,
        windowFrom: iso,
        windowTo: iso,
      }),
    ),
    rate: z.object({ buybackBps: bps, burnSplitBps: bps }).nullable(),
    missing: z.string().nullable(),
    reason: PARAMS_REASON.nullable(),
  }),
  samples: [
    { verdict: 'accept', input: { limit: 50 } },
    { verdict: 'refuse', input: {} },
    { verdict: 'refuse', input: { limit: 0 } },
  ],
});

/** Tokens permanently removed from circulation: the burn account's balance. */
export const TOKEN_BURNED_SUPPLY = defineProcedure({
  ...base,
  name: 'token.burnedSupply',
  kind: 'query',
  path: 'burnedSupply',
  access: ANY_READER,
  refusals: freeze({}),
  input: NO_INPUT,
  output: tokenBurnedSupplySchema,
  samples: [{ verdict: 'accept' }],
});

/** Every svc-token record in this file, for the service's own sample test. */
export const TOKEN_PROCEDURES = [
  TOKEN_ACCESS_OF,
  TOKEN_LIST_STAKES,
  TOKEN_EMISSION_SCHEDULE,
  TOKEN_REVENUE_SHARE_HISTORY,
  TOKEN_TREASURY,
  TOKEN_BUYBACK_RUNS,
  TOKEN_BURNED_SUPPLY,
] as const;
