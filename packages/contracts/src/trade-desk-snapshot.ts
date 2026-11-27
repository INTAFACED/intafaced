import { z } from 'zod';
import { defineProcedure } from './procedure.js';

/**
 * The launch desk's read of a person's own venue accounts, for svc-notify's read-only Telegram alerts and its `/positions`
 * and `/pnl` answers. Asked by svc-notify and answered by svc-trade, which holds the user-venue door; svc-notify never reads
 * svc-trade's tables and never talks to the venue itself.
 *
 * WHICH ACCOUNTS. The venue accounts whose owner wallet signed an action this person prepared through the door, as
 * `venue.ownActivity` lists them.
 *
 * THE VENUE'S FIGURES, NEVER A SECOND BOOK. Every position, fill and value is the venue's own, read at the moment of the call
 * with the venue's as-of time; nothing is stored and the ledger posts nothing. INTAFACED holds none of it.
 *
 * MARGIN USE is the margin the account's perpetual positions hold over the perpetual account's value as the venue counts
 * it, in percent. Where the venue names no perpetual account value, `accountValue` and `marginUse` are `null`: never read
 * as zero.
 *
 * THE WEEK runs from Monday 00:00 UTC. Its realised profit is the realised result the venue reports on the week's closing
 * perpetual fills, less every fee charged on the week's perpetual fills, in the perpetual account's collateral asset.
 *
 * ONE QUESTION, NO WRITE. A POST to a tRPC mutation only because the caller signs the body.
 */

/** A decimal string, never a JSON number. */
const decimal = z.string().regex(/^-?\d+(\.\d+)?$/);

export const tradeDeskSnapshotInputSchema = z
  .object({
    /** The person whose venue accounts are read. */
    userId: z.string().min(1).max(128),
    /** Fills at or after this time are listed. */
    since: z.string().datetime(),
  })
  .strict();
export type TradeDeskSnapshotInput = z.infer<typeof tradeDeskSnapshotInputSchema>;

export const tradeDeskPositionSchema = z
  .object({
    symbol: z.string().min(1),
    side: z.enum(['long', 'short']),
    size: decimal,
    entryPrice: decimal,
    markPrice: decimal,
    unrealisedPnl: decimal,
    /** The margin the venue holds for this position. */
    margin: decimal,
  })
  .strict();

export const tradeDeskAccountSchema = z
  .object({
    owner: z.string().min(1),
    subAccount: z.string().nullable(),
    /** The perpetual account's value as the venue counts it; `null` where the venue names none. */
    accountValue: decimal.nullable(),
    /** The margin every open perpetual position holds. */
    marginUsed: decimal,
    /** `marginUsed` over `accountValue`, in percent, floored to two places; `null` with no account value to divide by. */
    marginUse: decimal.nullable(),
    /** The open positions' unrealised result, summed. */
    unrealisedPnl: decimal,
    positions: z.array(tradeDeskPositionSchema),
  })
  .strict();

export const tradeDeskFillSchema = z
  .object({
    /** The venue's own stable trade id. */
    fillId: z.string().min(1),
    symbol: z.string().min(1),
    side: z.enum(['buy', 'sell']),
    price: decimal,
    amount: decimal,
    /** The realised result the venue reports on a closing fill; `null` on an opening fill. */
    realisedPnl: decimal.nullable(),
    /** Everything the venue charged on this fill, in `feeAsset`. */
    fee: decimal,
    feeAsset: z.string().min(1),
    filledAt: z.string().datetime(),
  })
  .strict();

export const tradeDeskSnapshotSchema = z.discriminatedUnion('state', [
  /** The user-venue door is off on this deployment. */
  z.object({ state: z.literal('off') }).strict(),
  z
    .object({
      state: z.literal('read'),
      /** A test venue: every figure is labelled TEST wherever it is shown. */
      test: z.boolean(),
      asOf: z.string().datetime(),
      /** Monday 00:00 UTC of the week `week` counts. */
      weekStart: z.string().datetime(),
      accounts: z.array(tradeDeskAccountSchema),
      /** Perpetual fills at or after `since`, oldest first. */
      fills: z.array(tradeDeskFillSchema),
      week: z
        .object({
          asset: z.string(),
          realisedPnl: decimal,
          fees: decimal,
          /** `realisedPnl` less `fees`. */
          profit: decimal,
        })
        .strict(),
    })
    .strict(),
]);
export type TradeDeskSnapshot = Extract<z.infer<typeof tradeDeskSnapshotSchema>, { state: 'read' }>;

/** What svc-notify's client answers: the snapshot, or the typed reason it has none. No answer is never "no positions". */
export type TradeDeskSnapshotResult =
  z.infer<typeof tradeDeskSnapshotSchema> | { readonly state: 'unavailable'; readonly code: 'trade.desk_snapshot_unavailable' };

export interface TradeDeskSnapshotPort {
  read(input: TradeDeskSnapshotInput): Promise<TradeDeskSnapshotResult>;
}

/** `venue.deskSnapshot` on svc-trade: svc-notify only. The venue down answers 503, never an empty list. */
export const TRADE_DESK_SNAPSHOT = defineProcedure({
  name: 'trade.venue.deskSnapshot',
  service: 'svc-trade',
  module: 'trade',
  transport: 'trpc',
  kind: 'mutation',
  path: 'venue.deskSnapshot',
  access: { caller: 'service', callers: ['svc-notify'] },
  refusals: { 'trade.desk_snapshot_unavailable': 'SERVICE_UNAVAILABLE' },
  input: tradeDeskSnapshotInputSchema,
  output: tradeDeskSnapshotSchema,
  samples: [
    { verdict: 'accept', input: { userId: 'user-1', since: '2026-11-23T00:00:00.000Z' } },
    { verdict: 'refuse', input: { userId: 'user-1', since: 'yesterday' } },
  ],
});
