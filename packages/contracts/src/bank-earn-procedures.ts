import { z } from 'zod';
import { defineProcedure, NO_INPUT } from './procedure.js';
import { assetIdSchema } from './asset-id.js';

// Written by tooling/codemod/call-records from the router; edit freely, the codemod only appends.
/** svc-bank `earn.*`, one record per call, written from its router while its Rust port is in flight: every app caller calls it by its record, and the router keeps its own schemas until the port's switch. */

const base = { service: 'svc-bank', module: 'bank', transport: 'trpc' } as const;

export const amountString = z.string().regex(/^\d+(\.\d{1,18})?$/, 'amount must be an unsigned decimal string (max 18dp)');

/**
 * What a pool publishes beyond its rate and term (BK-earn-02, BK-earn-05), so the pool page and the side-by-side table
 * read the bank, not the browser. Interest is paid once a UTC day, simple, into the person's main balance in the pool's
 * own asset, out of the pool's reserve that the bank funds (`earn-service.ts`, `interest.ts`): those are facts of the
 * code, not settings. No owner table exists for balance-band rates, a commission on interest or a pool capacity, so each
 * reads null and the page says "not set"; a pool never shows zero for a figure nobody published.
 */
export const poolFacts = {
  payoutEvery: z.literal('day'),
  compounding: z.literal('simple'),
  rewardAssetId: z.string(),
  yieldSource: z.literal('pool_reserve'),
  rateBands: z.array(z.object({ from: amountString, rateBps: z.number().int() })).nullable(),
  commissionBps: z.number().int().nullable(),
  capacity: amountString.nullable(),
  /** Staking-style (BK-earn-04): days a saving taken back unbonds before it is paid back; null for no unbonding. */
  unbondingDays: z.number().int().nullable(),
};

export const BANK_EARN_POOLS = defineProcedure({
  ...base,
  name: 'bank.earn.pools',
  kind: 'query',
  path: 'earn.pools',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({
    assetId: assetIdSchema.min(1).max(16).optional(),
    /**
     * Page size. Optional so omit reaches `bank.earn_pools_list_limit_unset`
     * instead of a Zod "Required". Blank is not 50; pass 50 explicitly.
     */
    limit: z.number().int().min(1).max(200).optional(),
  }),
  output: z.array(
    z.object({
      id: z.string(),
      assetId: assetIdSchema,
      kind: z.enum(['flexible', 'fixed']),
      name: z.string(),
      aprBps: z.number().int(),
      termDays: z.number().int().nullable(),
      minDeposit: amountString,
      ...poolFacts,
    }),
  ),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

/** One pool by id, open or closed, with what it publishes (BK-earn-02, BK-earn-05): the pool's own page. */
export const BANK_EARN_POOL = defineProcedure({
  ...base,
  name: 'bank.earn.pool',
  kind: 'query',
  path: 'earn.pool',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({ poolId: z.string().guid() }),
  output: z.object({
    id: z.string(),
    assetId: assetIdSchema,
    kind: z.enum(['flexible', 'fixed']),
    name: z.string(),
    aprBps: z.number().int(),
    termDays: z.number().int().nullable(),
    minDeposit: amountString,
    status: z.enum(['open', 'closed']),
    /** How many approved status changes the pool has had (BK-earn-04). */
    statusRevision: z.number().int(),
    ...poolFacts,
  }),
  samples: [
    { verdict: 'accept', input: { poolId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * Every rate the pool has published, oldest first, as the bank recorded it (BK-earn-05, J-bank-08 #1). Nothing before
 * the first record is filled in: `earlier` says older records exist beyond this page, and an empty list means the
 * pool has no recorded change.
 */
export const BANK_EARN_RATE_HISTORY = defineProcedure({
  ...base,
  name: 'bank.earn.rateHistory',
  kind: 'query',
  path: 'earn.rateHistory',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({
    poolId: z.string().guid(),
    /** Page size. Optional so omit reaches `bank.earn_rate_history_limit_unset`; blank is not 50. */
    limit: z.number().int().min(1).max(200).optional(),
    /** Older records only: the effective time of the oldest record of the page before (exclusive). */
    before: z.string().datetime({ offset: true }).optional(),
  }),
  output: z.object({
    poolId: z.string(),
    currentBps: z.number().int(),
    changes: z.array(z.object({ rateBps: z.number().int(), effectiveAt: z.string(), reason: z.string().nullable() })),
    earlier: z.boolean(),
  }),
  samples: [
    { verdict: 'accept', input: { poolId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});

export const BANK_EARN_POSITIONS = defineProcedure({
  ...base,
  name: 'bank.earn.positions',
  kind: 'query',
  path: 'earn.positions',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z
    .object({
      /**
       * Page size. Optional so omit reaches `bank.earn_positions_list_limit_unset`
       * instead of a Zod "Required". Blank is not 50; pass 50 explicitly.
       */
      limit: z.number().int().min(1).max(200).optional(),
      /** One pool's positions only (the pool page, BK-earn-05). */
      poolId: z.string().guid().optional(),
    })
    .optional(),
  output: z.array(
    z.object({
      id: z.string(),
      poolId: z.string(),
      assetId: assetIdSchema,
      principal: amountString,
      openedAt: z.string(),
      maturesAt: z.string().nullable(),
      /** The pool's recorded rate when the position opened; null when it opened before the pool's first record. */
      rateAtOpenBps: z.number().int().nullable(),
      /** The UTC midnight the position first earns from: a day pays positions opened before it began. */
      accruesFrom: z.string(),
      /**
       * `waiting` until that day, then `accruing`, in an open or a closed pool; `unbonding` once a staking-style
       * saving is asked back (BK-earn-04); a too-small saving is paid nothing (BK-earn-01).
       */
      accrual: z.enum(['waiting', 'accruing', 'unbonding', 'below_unit']),
      /** A fixed-term saving the saver asked to renew when its term ends (BK-earn-03). */
      autoRenew: z.boolean(),
      /** How many new terms auto-renew has started; `maturesAt` is the end of the current one. */
      renewals: z.number().int(),
      /** The next UTC day the bank pays this saving's interest (a date); null when no day pays it. */
      nextPayoutOn: z.string().nullable(),
      /** Staking-style pools only (BK-earn-04): `staked`, `unbonding` or `unbonded`, by the bank's clock. */
      staking: z.enum(['staked', 'unbonding', 'unbonded']).nullable(),
      unbondingStartedAt: z.string().nullable(),
      unbondsAt: z.string().nullable(),
      /** The pool's unbonding period (BK-earn-04): taking this saving back starts it. Null: paid back at once. */
      unbondingDays: z.number().int().nullable(),
    }),
  ),
  samples: [
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: 42 },
  ],
});

/**
 * The owner's risk wording for staking-style pools (BK-earn-04): what slashing means. Blank refuses
 * `bank.earn_risk_wording_unset`, and the pool page says it is not published, never that there is no risk.
 */
export const BANK_EARN_RISK_DISCLOSURE = defineProcedure({
  ...base,
  name: 'bank.earn.riskDisclosure',
  kind: 'query',
  path: 'earn.riskDisclosure',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: NO_INPUT,
  output: z.object({ slashing: z.string(), ownership: z.string() }),
  samples: [{ verdict: 'accept' }],
});

/** The caller's interest from one pool, a row per paid day, and what every paid day sums to (J-bank-07 #5). */
export const BANK_EARN_INTEREST_HISTORY = defineProcedure({
  ...base,
  name: 'bank.earn.interestHistory',
  kind: 'query',
  path: 'earn.interestHistory',
  access: { caller: 'scope', scope: 'bank:read', module: 'bank' },
  refusals: {},
  input: z.object({
    poolId: z.string().guid(),
    /** Page size. Optional so omit reaches `bank.earn_interest_list_limit_unset`; blank is not 50. */
    limit: z.number().int().min(1).max(200).optional(),
    /** Older days only: the oldest day of the page before (a date, exclusive). */
    before: z.string().date().optional(),
  }),
  output: z.object({
    days: z.array(z.object({ date: z.string(), rateBps: z.number().int(), amount: amountString, ledgerTxId: z.string() })),
    total: amountString,
    unitemisedDays: z.number().int(),
  }),
  samples: [
    { verdict: 'accept', input: { poolId: '11111111-1111-4111-8111-111111111111' } },
    { verdict: 'refuse', input: 42 },
  ],
});
