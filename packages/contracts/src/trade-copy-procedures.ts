import { z } from 'zod';
import { defineProcedure, type Refusals } from './procedure.js';

/**
 * svc-trade's copy desk records (J-copy-bots-otc-06). The copy desk's older doors (`copy.follow`, `copy.leadEarnings`, …)
 * are still hand-written in its router; each new one is a record here, mounted with `mountRecord`.
 */

const base = { service: 'svc-trade', module: 'trade', transport: 'trpc' } as const;
const READ = { caller: 'scope', scope: 'trade:read', module: 'trade' } as const;

const decimal = z.string().regex(/^[0-9]+(\.[0-9]+)?$/);
const money = z.object({ amount: decimal, asset: z.string().min(1) });

/** The most copied fills one read lists. */
export const MY_COPY_FEES_MAX = 200;

/**
 * The lead's share of our builder fee on one copied fill, as svc-trade records it (src/copy/venue-fee-share.ts). It is paid
 * by INTAFACED out of our builder fee and is never charged to the follower: the follower pays the venue's fee and our
 * builder fee, as the venue reports them, and nothing else.
 * - `none`: the fill carries no builder fee of ours (the venue charges none on a spot buy), so there is nothing to share.
 * - `recording`: our builder fee on the fill is not booked in our ledger yet; the share is recorded once it is.
 * - `waiting_collection`: recorded, and owed once the venue pays us the fee it is a share of.
 * - `owed`: recorded in our ledger as owed by INTAFACED to the lead, under `ledgerKey`.
 * - `not_owed`: the owner's cap per follower, or a share that rounds to nothing, leaves nothing owed.
 */
export const copyFeeShareStateSchema = z.union([
  z.object({ state: z.literal('none') }),
  z.object({ state: z.literal('recording') }),
  z.object({ state: z.literal('waiting_collection'), share: money, shareBps: z.number().int().min(0).max(10_000) }),
  z.object({ state: z.literal('owed'), share: money, shareBps: z.number().int().min(0).max(10_000), ledgerKey: z.string().min(1) }),
  z.object({ state: z.literal('not_owed'), reason: z.enum(['cap_reached', 'zero_share']) }),
]);

/** One fill a copy made on the follower's own venue account, its fees as the venue reports them, and the lead's share. */
export const copiedFillFeesSchema = z.object({
  /** The venue's own id for the fill. */
  fillId: z.string().min(1),
  followId: z.string().min(1),
  symbol: z.string().min(1),
  side: z.enum(['buy', 'sell']),
  amount: decimal,
  price: decimal,
  filledAt: z.string(),
  /** The venue's own fee on the fill, as the venue reports it. Never posted by us. */
  venueFee: money,
  /** Our builder fee on the fill, as the venue charged it. */
  builderFee: money,
  /** The lead whose fill was copied: the listing's own name and reference, or null when the listing is gone. */
  lead: z.object({ leaderRef: z.string().nullable(), displayName: z.string().nullable() }),
  feeShare: copyFeeShareStateSchema,
});

export const myCopyFeesSchema = z.object({
  asOf: z.string(),
  /** The venue the fills are read from, by its own name; null when no copy of the caller's is on a venue. */
  venue: z.object({ name: z.string().min(1), test: z.boolean() }).nullable(),
  rows: z.array(copiedFillFeesSchema),
});

const refuse = (map: Record<string, 'BAD_REQUEST' | 'PRECONDITION_FAILED'>): Refusals => Object.freeze(map);

/** The caller's own copied venue fills, newest first: each one's fees as the venue reports them and the lead's share. */
export const COPY_MY_COPY_FEES = defineProcedure({
  ...base,
  name: 'trade.copy.myCopyFees',
  kind: 'query',
  path: 'copy.myCopyFees',
  access: READ,
  refusals: refuse({
    'trade.copy_limit_missing': 'BAD_REQUEST',
    'trade.copy_unavailable': 'PRECONDITION_FAILED',
  }),
  input: z.object({ limit: z.number().int().min(1).max(MY_COPY_FEES_MAX) }),
  output: myCopyFeesSchema,
  samples: [
    { verdict: 'accept', input: { limit: 50 } },
    { verdict: 'refuse', input: { limit: 0 } },
    { verdict: 'refuse', input: {} },
  ],
});
