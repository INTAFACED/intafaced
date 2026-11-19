import { z } from 'zod';
import { assetIdSchema } from './asset-id.js';
import { defineProcedure, NO_INPUT, type Refusals, type RefusalStatus } from './procedure.js';

/**
 * svc-mining-pool's whole call surface, one record per call. The service mounts each from here (`mountRecords`), so its
 * path, guard, input, output and named refusals are this file, not its router. Every app caller (`api.call`, the admin
 * desk) takes its path and reply parser from the same record.
 */

/** A minimum difficulty as a rig sets it: a positive whole number, at most 38 digits. svc-mining-pool's settings use it too. */
export const MINING_DIFFICULTY = /^[1-9]\d{0,37}$/;
/** A rig name: letters, digits, dash and underscore, 1 to 64. svc-mining-pool's miner door uses it too. */
export const MINING_WORKER_NAME = /^[A-Za-z0-9_-]{1,64}$/;

const decimal = z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/);
const money = z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/);
/**
 * A list limit or hashrate window as sent. The service judges the value itself and refuses a bad one by name
 * (`mining.*_list_limit_unset`, `mining.hashrate_window_unset`), so the wire takes any JSON scalar here.
 */
const sentNumber = z.union([z.number(), z.string(), z.boolean(), z.null()]);

const CUSTOMER = { caller: 'scope', scope: 'ledger:read', module: 'mining-pool' } as const;
const OPERATOR = { caller: 'scope', scope: 'admin:read', module: 'mining-pool' } as const;
/** A rig setting is the account's own trading-side write; a read-only key cannot change it. */
const RIG = { caller: 'scope', scope: 'trade:write', module: 'mining-pool' } as const;
/** Signed in, no scope, then the same mining-pool fiat jurisdiction check as `workers.mine`. */
const SIGNED = { caller: 'signedIn', module: 'mining-pool' } as const;

/** A `MiningError` leaves as PRECONDITION_FAILED, except a bad cursor or share range (BAD_REQUEST); `router.ts`. */
const refuse = (...codes: string[]): Refusals =>
  Object.freeze(
    Object.fromEntries(
      codes.map((c): [string, RefusalStatus] => [
        c,
        c === 'mining.cursor_invalid' || c === 'mining.share_range_invalid' ? 'BAD_REQUEST' : 'PRECONDITION_FAILED',
      ]),
    ),
  );

const base = { service: 'svc-mining-pool', module: 'mining', transport: 'trpc' } as const;

const shareFilter = z.object({
  windowId: z.string().max(200).optional(),
  from: z.string().max(80).optional(),
  to: z.string().max(80).optional(),
});

const shareReport = z.object({
  asOf: z.string(),
  windows: z.array(
    z.object({
      windowId: z.string(),
      acceptedCount: z.number().int().nonnegative(),
      rejectedCount: z.number().int().nonnegative(),
      soloCount: z.number().int().nonnegative(),
      acceptedWeight: decimal.nullable(),
    }),
  ),
});

const page = z.object({ limit: sentNumber.optional(), cursor: z.string().max(512).optional() });
const SHARE_SAMPLES = [
  { verdict: 'accept', input: {} },
  { verdict: 'accept', input: { windowId: 'w-1', from: '2026-01-01T00:00:00Z' } },
  { verdict: 'refuse', input: { windowId: 7 } },
] as const;
const PAGE_SAMPLES = [
  { verdict: 'accept', input: { limit: 20 } },
  { verdict: 'accept', input: {} },
  { verdict: 'refuse', input: { cursor: 7 } },
] as const;

/** A worker row: a hashrate, or none with its reason; never both, never neither. */
const workerRow = <H extends z.ZodType, R extends z.ZodType>(hashrate: H, hashrateReason: R) =>
  z.object({
    id: z.string(),
    name: z.string(),
    createdAt: z.string(),
    hashrate,
    hashrateReason,
    minDifficulty: decimal.nullable(),
    mode: z.enum(['pooled', 'solo']),
  });

export const MINING_WORKERS_MINE = defineProcedure({
  ...base,
  name: 'mining.workers.mine',
  kind: 'query',
  path: 'workers.mine',
  access: CUSTOMER,
  refusals: refuse('mining.hashrate_window_unset', 'mining.workers_list_limit_unset', 'mining.cursor_invalid', 'mining.pg_unavailable'),
  input: z.object({
    windowMinutes: sentNumber.optional(),
    limit: sentNumber.optional(),
    cursor: z.string().max(512).optional(),
    name: z.string().max(64).optional(),
  }),
  output: z.object({
    asOf: z.string(),
    windowMinutes: z.number().int(),
    defaultDifficulty: decimal.nullable(),
    defaultDifficultyReason: z.enum(['mining.default_difficulty_unset', 'mining.default_difficulty_invalid']).nullable(),
    nextCursor: z.string().nullable(),
    workers: z.array(z.union([workerRow(decimal, z.null()), workerRow(z.null(), z.enum(['no_shares_in_window']))])),
  }),
  samples: [
    { verdict: 'accept', input: { windowMinutes: 60, limit: 20 } },
    { verdict: 'accept', input: {} },
    { verdict: 'refuse', input: { name: 7 } },
  ],
});

export const MINING_WORKERS_SET_DIFFICULTY = defineProcedure({
  ...base,
  name: 'mining.workers.setDifficulty',
  kind: 'mutation',
  path: 'workers.setDifficulty',
  access: RIG,
  refusals: refuse('mining.worker_not_found', 'mining.pg_unavailable'),
  input: z.object({ workerId: z.string().min(1).max(200), minDifficulty: z.string().regex(MINING_DIFFICULTY).nullable() }),
  output: z.object({ id: z.string(), minDifficulty: decimal.nullable() }),
  samples: [
    { verdict: 'accept', input: { workerId: 'w-1', minDifficulty: '1024' } },
    { verdict: 'accept', input: { workerId: 'w-1', minDifficulty: null } },
    { verdict: 'refuse', input: { workerId: 'w-1', minDifficulty: '0' } },
    { verdict: 'refuse', input: { workerId: '', minDifficulty: null } },
  ],
});

export const MINING_WORKERS_SET_MODE = defineProcedure({
  ...base,
  name: 'mining.workers.setMode',
  kind: 'mutation',
  path: 'workers.setMode',
  access: RIG,
  refusals: refuse('mining.worker_not_found', 'mining.mode_change_in_window', 'mining.mode_invalid', 'mining.pg_unavailable'),
  input: z.object({ name: z.string().regex(MINING_WORKER_NAME), mode: z.enum(['pooled', 'solo']) }),
  output: z.object({ id: z.string(), name: z.string(), mode: z.enum(['pooled', 'solo']) }),
  samples: [
    { verdict: 'accept', input: { name: 'rig-1', mode: 'solo' } },
    { verdict: 'refuse', input: { name: 'rig 1', mode: 'solo' } },
    { verdict: 'refuse', input: { name: 'rig-1', mode: 'both' } },
  ],
});

/** A solo rig's credit: always refused today (`mining.emission_unpublished`), as the payout job refuses a solo window. */
export const MINING_WORKERS_SOLO_CREDIT = defineProcedure({
  ...base,
  name: 'mining.workers.soloCredit',
  kind: 'query',
  path: 'workers.soloCredit',
  access: CUSTOMER,
  refusals: refuse('mining.emission_unpublished'),
  input: NO_INPUT,
  output: z.never(),
  samples: [{ verdict: 'accept' }],
});

export const MINING_OPS_WORKERS = defineProcedure({
  ...base,
  name: 'mining.ops.workers',
  kind: 'query',
  path: 'ops.workers',
  access: OPERATOR,
  refusals: refuse('mining.workers_list_limit_unset', 'mining.cursor_invalid'),
  input: page,
  output: z.object({
    asOf: z.string(),
    workers: z.array(z.object({ id: z.string(), userId: z.string(), name: z.string(), createdAt: z.string() })),
    nextCursor: z.string().nullable(),
  }),
  samples: PAGE_SAMPLES,
});

export const MINING_OPS_SHARES = defineProcedure({
  ...base,
  name: 'mining.ops.shares',
  kind: 'query',
  path: 'ops.shares',
  access: OPERATOR,
  refusals: refuse(),
  input: shareFilter,
  output: shareReport,
  samples: SHARE_SAMPLES,
});

export const MINING_OPS_WINDOWS = defineProcedure({
  ...base,
  name: 'mining.ops.windows',
  kind: 'query',
  path: 'ops.windows',
  access: OPERATOR,
  refusals: refuse(),
  input: NO_INPUT,
  output: z.object({
    asOf: z.string(),
    windows: z.array(
      z.object({
        windowId: z.string(),
        assetId: assetIdSchema,
        status: z.enum(['open', 'paid', 'no_credit']),
        reward: money.nullable(),
        feeBps: z.number().int().nullable(),
        shareCount: z.number().int().nonnegative(),
        totalWeight: decimal.nullable(),
        paidAt: z.string().nullable(),
      }),
    ),
  }),
  samples: [{ verdict: 'accept' }],
});

export const MINING_SHARES_MINE = defineProcedure({
  ...base,
  name: 'mining.shares.mine',
  kind: 'query',
  path: 'shares.mine',
  access: CUSTOMER,
  refusals: refuse(),
  input: shareFilter,
  output: shareReport,
  samples: SHARE_SAMPLES,
});

export const MINING_WINDOWS_PENDING = defineProcedure({
  ...base,
  name: 'mining.windows.pending',
  kind: 'query',
  path: 'windows.pending',
  access: CUSTOMER,
  refusals: refuse(),
  input: NO_INPUT,
  output: z.object({
    asOf: z.string(),
    windows: z.array(
      z.object({
        windowId: z.string(),
        assetId: assetIdSchema,
        callerWeight: decimal,
        totalWeight: decimal.nullable(),
        reward: money.nullable(),
        feeBps: z.number().int().nullable(),
        estimate: z.object({ estimate: z.literal(true), estimatedGross: money }).nullable(),
      }),
    ),
  }),
  samples: [{ verdict: 'accept' }],
});

export const MINING_PAYOUTS_MINE = defineProcedure({
  ...base,
  name: 'mining.payouts.mine',
  kind: 'query',
  path: 'payouts.mine',
  access: CUSTOMER,
  refusals: refuse('mining.payouts_list_limit_unset', 'mining.cursor_invalid'),
  input: page,
  output: z.object({
    asOf: z.string(),
    nextCursor: z.string().nullable(),
    payouts: z.array(
      z.object({
        windowId: z.string(),
        minerId: z.string(),
        assetId: assetIdSchema,
        amount: money.nullable(),
        amountReason: z.string().nullable(),
        paidAt: z.string().nullable(),
        ledgerTransactionId: z.string().nullable(),
        ledgerReason: z.enum(['mining.ledger_unavailable', 'mining.ledger_tx_unrecorded']).nullable(),
      }),
    ),
  }),
  samples: PAGE_SAMPLES,
});

/** The pool's fee and window size; blank values carry their reason. Signed in, no scope and no jurisdiction check. */
export const MINING_TERMS = defineProcedure({
  ...base,
  name: 'mining.terms',
  kind: 'query',
  path: 'terms',
  access: { caller: 'signedIn' },
  refusals: refuse(),
  input: NO_INPUT,
  output: z.object({
    feeBps: z.number().int().min(0).max(9999).nullable(),
    feeReason: z.enum(['fee_unconfigured']).nullable(),
    windowSize: z.number().int().positive().nullable(),
    windowSizeReason: z.enum(['window_size_unconfigured']).nullable(),
  }),
  samples: [{ verdict: 'accept' }],
});

/** The owner's published pool sections. A blank section is null; a wholly blank overview refuses. */
export const MINING_OVERVIEW = defineProcedure({
  ...base,
  name: 'mining.overview',
  kind: 'query',
  path: 'overview',
  access: SIGNED,
  refusals: refuse('mining.overview_unset'),
  input: NO_INPUT,
  output: z.object({
    version: z.string().min(1),
    what: z.string().nullable(),
    coin: z.string().nullable(),
    hardware: z.string().nullable(),
    revenueSplit: z.string().nullable(),
    notSupported: z.string().nullable(),
  }),
  samples: [{ verdict: 'accept' }],
});

/** When the caller's miner secret was issued, or null. Never the secret. */
export const MINING_MINER_SECRET_STATUS = defineProcedure({
  ...base,
  name: 'mining.minerSecret.status',
  kind: 'query',
  path: 'minerSecret.status',
  access: CUSTOMER,
  refusals: refuse('mining.pg_unavailable'),
  input: NO_INPUT,
  output: z.object({ issuedAt: z.string().nullable() }),
  samples: [{ verdict: 'accept' }],
});

/** A new miner secret, replacing the old one, returned this once; the pool keeps only its SHA-256. A rig setting. */
export const MINING_MINER_SECRET_ISSUE = defineProcedure({
  ...base,
  name: 'mining.minerSecret.issue',
  kind: 'mutation',
  path: 'minerSecret.issue',
  access: RIG,
  refusals: refuse('mining.pg_unavailable'),
  input: NO_INPUT,
  output: z.object({ secret: z.string(), issuedAt: z.string() }),
  samples: [{ verdict: 'accept' }],
});

/** The published host and port, and the signed account's own id. A blank host or port refuses. */
export const MINING_CONNECTION = defineProcedure({
  ...base,
  name: 'mining.connection',
  kind: 'query',
  path: 'connection',
  access: SIGNED,
  refusals: refuse('mining.connection_unset'),
  input: NO_INPUT,
  output: z.object({
    host: z.string().min(1),
    port: z.string().regex(/^[1-9]\d{0,4}$/),
    secureUrl: z.string().nullable(),
    accountId: z.string().min(1),
    workerNamePattern: z.string().nullable(),
  }),
  samples: [{ verdict: 'accept' }],
});

/** The pool's proof-of-work parameters as published: a TEST testnet set, or blank. A mainnet set is never served. */
export const MINING_POW = defineProcedure({
  ...base,
  name: 'mining.pow',
  kind: 'query',
  path: 'pow',
  access: SIGNED,
  refusals: refuse('audit.external'),
  input: NO_INPUT,
  output: z.discriminatedUnion('status', [
    z.object({ status: z.literal('published'), dimension: z.number().int(), targetBits: z.number().int(), testnet: z.literal(true) }),
    z.object({ status: z.literal('unset'), code: z.literal('mining.pow_spec_unset') }),
  ]),
  samples: [{ verdict: 'accept' }],
});

/** One TCP connect from the pool's network to its own published address. Stores nothing; counts against a limit. */
export const MINING_PROBE = defineProcedure({
  ...base,
  name: 'mining.probe',
  kind: 'query',
  path: 'probe',
  access: SIGNED,
  refusals: refuse('mining.probe_limit_unset', 'mining.probe_timeout_unset', 'mining.probe_limit_reached', 'mining.connection_unset'),
  input: NO_INPUT,
  output: z.object({
    result: z.enum(['reachable', 'refused', 'timed_out']),
    roundTripMs: z.string().regex(/^(0|[1-9]\d*)$/),
    viewpoint: z.literal('pool_network'),
  }),
  samples: [{ verdict: 'accept' }],
});

export const MINING_PROCEDURES = [
  MINING_WORKERS_MINE,
  MINING_WORKERS_SET_DIFFICULTY,
  MINING_WORKERS_SET_MODE,
  MINING_WORKERS_SOLO_CREDIT,
  MINING_OPS_WORKERS,
  MINING_OPS_SHARES,
  MINING_OPS_WINDOWS,
  MINING_SHARES_MINE,
  MINING_WINDOWS_PENDING,
  MINING_PAYOUTS_MINE,
  MINING_TERMS,
  MINING_OVERVIEW,
  MINING_MINER_SECRET_STATUS,
  MINING_MINER_SECRET_ISSUE,
  MINING_CONNECTION,
  MINING_POW,
  MINING_PROBE,
] as const;
