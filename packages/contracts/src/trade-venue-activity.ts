import { z } from 'zod';
import type { ServiceName } from './service-keys.js';

/**
 * A person's own venue spot trading, for their profit and loss indicator (J-cex-spot-01 #11). Asked by svc-tax and
 * answered by svc-trade, which holds the user-venue door. svc-tax never reads svc-trade's tables and never talks to the
 * venue itself.
 *
 * WHICH VENUE ACCOUNTS ARE THE PERSON'S. A venue account is keyed by its owner wallet's address, and the door reads any
 * address it is given. For this answer svc-trade lists only the venue accounts whose owner wallet signed an action this
 * person prepared through the door: svc-trade checked that signature recovers to the owner before it stored it, so the
 * person controls that wallet. An account this person only looked at is not theirs here.
 *
 * THE VENUE'S FIGURES, NEVER A SECOND BOOK. Every balance and fill is the venue's own, read at the moment of the call
 * with the venue's as-of time, and nothing is stored. INTAFACED holds none of it and the ledger posts nothing for it.
 *
 * ONE QUESTION, NO WRITE. A POST to a tRPC mutation only because the caller signs the body, as `spaces.ownedAccounts`.
 */

/** The tRPC path on svc-trade's root router. */
export const TRADE_VENUE_ACTIVITY_PROCEDURE = 'venue.ownActivity' as const;

/** The only service allowed to call it. */
export const TRADE_VENUE_ACTIVITY_CALLERS: readonly ServiceName[] = ['svc-tax'];

export const tradeVenueActivityInputSchema = z
  .object({
    /** The person whose venue accounts are read. */
    userId: z.string().min(1).max(128),
  })
  .strict();
export type TradeVenueActivityInput = z.infer<typeof tradeVenueActivityInputSchema>;

/** A decimal string, never a JSON number. */
const decimal = z.string().regex(/^-?\d+(\.\d+)?$/);

export const tradeVenueSpotFillSchema = z
  .object({
    /** The venue's own stable trade id. */
    fillId: z.string().min(1),
    /** The venue's market, e.g. `BTC-USDC`, with the coin bought or sold (`base`) and the coin paid in (`quote`). */
    symbol: z.string().min(1),
    base: z.string().min(1),
    quote: z.string().min(1),
    side: z.enum(['buy', 'sell']),
    price: decimal,
    amount: decimal,
    /** Everything the venue charged on this fill (its own fee and any builder fee), in `feeAsset`. */
    fee: decimal,
    feeAsset: z.string().min(1),
    filledAt: z.string().datetime(),
  })
  .strict();
export type TradeVenueSpotFill = z.infer<typeof tradeVenueSpotFillSchema>;

export const tradeVenueAccountActivitySchema = z
  .object({
    venueId: z.string().min(1),
    /** The owner wallet's address, lowercase. */
    owner: z.string().regex(/^0x[0-9a-f]{40}$/),
    subAccount: z.string().nullable(),
    /** What the account holds of each coin, as the venue reports it (free and locked together). */
    balances: z.array(z.object({ asset: z.string().min(1), total: decimal }).strict()),
    /** Every spot fill of the account, oldest first. Perpetual fills are not coins held, so they are not listed. */
    fills: z.array(tradeVenueSpotFillSchema),
    /** The venue's own time for the read (the later of the balances' and the fills'). */
    asOf: z.string().datetime(),
  })
  .strict();
export type TradeVenueAccountActivity = z.infer<typeof tradeVenueAccountActivitySchema>;

export const tradeVenueActivitySchema = z.discriminatedUnion('state', [
  /** The user-venue door is off on this deployment: there is no venue account to read. */
  z.object({ state: z.literal('off') }).strict(),
  z
    .object({
      state: z.literal('read'),
      /** True for the TEST venue: every figure from it is TEST. */
      test: z.boolean(),
      accounts: z.array(tradeVenueAccountActivitySchema),
    })
    .strict(),
]);
export type TradeVenueActivity = z.infer<typeof tradeVenueActivitySchema>;

/** What a caller sees: the answer, or no answer. An unreachable venue is never read as "no trades". */
export type TradeVenueActivityResult =
  TradeVenueActivity | { readonly state: 'unavailable'; readonly code: 'trade.venue_activity_unavailable' };

/** The port svc-tax depends on. The HTTP client implements it; tests inject a fake. */
export interface TradeVenueActivityPort {
  read(input: TradeVenueActivityInput): Promise<TradeVenueActivityResult>;
}
