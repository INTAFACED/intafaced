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

/**
 * One move of the person's own coins between their main venue account and one of their own sub-accounts (J-portfolio-04
 * #2), signed by their wallet on the main account, as the venue recorded it. Not a sale and not an arrival from outside:
 * the lots go with the coins.
 */
export const tradeVenueOwnMoveSchema = z
  .object({
    /** The venue's id for the move (the signed action's nonce). */
    moveId: z.string().min(1),
    /** The sub-account's venue id. */
    subAccount: z.string().min(1),
    direction: z.enum(['into_sub_account', 'out_of_sub_account']),
    asset: z.string().min(1),
    amount: decimal,
    /** The venue's own time for the move. */
    settledAt: z.string().datetime(),
  })
  .strict();
export type TradeVenueOwnMove = z.infer<typeof tradeVenueOwnMoveSchema>;

/**
 * One credit of coins into the account from outside it (a deposit, or a transfer in from another address), as the venue
 * recorded it (J-portfolio-02 #6). The venue knows no cost for it: the lot it opens has none until the person enters one.
 */
export const tradeVenueArrivalSchema = z
  .object({
    /** The venue's own id for the credit. */
    arrivalId: z.string().min(1),
    kind: z.enum(['deposit', 'transfer_in']),
    asset: z.string().min(1),
    amount: decimal,
    /** The venue's own time for the credit. */
    arrivedAt: z.string().datetime(),
  })
  .strict();
export type TradeVenueArrival = z.infer<typeof tradeVenueArrivalSchema>;

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
    /**
     * On a main account: the moves between it and its sub-accounts that the person's wallet signed through the door and
     * the venue settled, oldest first. Absent on a sub-account (a move is signed and recorded on the main account).
     */
    transfers: z.array(tradeVenueOwnMoveSchema).optional(),
    /**
     * Every credit from outside the account, oldest first (J-portfolio-02 #6). Absent when the venue's adapter does not
     * read them: a coin that arrived that way then does not reconcile in the lot book, named, never guessed.
     */
    arrivals: z.array(tradeVenueArrivalSchema).optional(),
    /** The venue's own time for the read (the latest of its balances, fills and arrivals). */
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
