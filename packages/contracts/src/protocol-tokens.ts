import { z } from 'zod';

/**
 * Wire types for the token pages (D-portfolio-wallet-06, -07, D-launch-listing-02, -04, D-explorer-05): the token list,
 * one token's page and the wallet leaderboard, all read from the configured pool factory's pools on the app's network.
 * Amounts are base-unit decimal strings, never numbers; a price is a decimal string in the quote token. Nothing here
 * posts to the ledger. A source that is not there is a typed refusal or a null with its reason, never a made-up figure.
 */
export const TOKENS_QUOTE_UNSET = 'protocol.tokens_quote_unset' as const;
export const TRUST_CRITERIA_UNSET = 'protocol.trust_criteria_unset' as const;
export const ORGANIC_SCORE_UNSET = 'protocol.organic_score_unset' as const;
export const TOKENS_READ_TOO_LARGE = 'protocol.tokens_read_too_large' as const;
/** The token's own Transfer logs do not add up to its supply, so no holder list from them is shown. */
export const TOKENS_HOLDERS_INCONSISTENT = 'protocol.tokens_holders_inconsistent' as const;
/** A token page is read only for a token in one of the factory's pools. */
export const TOKEN_NOT_LISTED = 'protocol.token_not_listed' as const;
/** The token claims more decimals than the pages take, so it is left out with its pools. */
export const TOKEN_UNSUPPORTED = 'protocol.token_unsupported' as const;

const units = z.string().regex(/^(0|[1-9][0-9]*)$/);
/** A decimal with at most 18 places, possibly negative. */
const decimal = z.string().regex(/^-?(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);

export const TOKEN_WINDOWS = ['5m', '1h', '6h', '24h'] as const;
export const tokenWindowSchema = z.enum(TOKEN_WINDOWS);
export type TokenWindowId = z.infer<typeof tokenWindowSchema>;
export const TOKEN_WINDOW_SECONDS: Record<TokenWindowId, number> = { '5m': 300, '1h': 3600, '6h': 21_600, '24h': 86_400 };

export const tokenBasicsSchema = z
  .object({ address, name: z.string(), symbol: z.string(), decimals: z.number().int().min(0).max(36) })
  .strict();
export type TokenBasics = z.infer<typeof tokenBasicsSchema>;

/** The better-known token a lookalike's name or symbol copies: listed earlier, read the same after normalising. */
export const tokenLookalikeSchema = z.object({ address, name: z.string(), symbol: z.string() }).strict();

export const tokenListRowSchema = z
  .object({
    token: tokenBasicsSchema,
    /** Price in the quote token from the deepest pool that prices it; null when no pool reaches the quote token. */
    price: decimal.nullable(),
    /** Price growth over the window in basis points, from the pool's own Sync history; null with no price. */
    growthBps: z.number().int().nullable(),
    /** Traded value over the window, in the quote token at today's price; "0" with no trade. */
    volume: decimal,
    /** Swaps over the window, in every pool that trades the token. */
    trades: z.number().int().nonnegative(),
    /** When its first pool was created, unix seconds. */
    listedAt: z.number().int().nonnegative(),
    lookalikeOf: tokenLookalikeSchema.nullable(),
  })
  .strict();
export type TokenListRow = z.infer<typeof tokenListRowSchema>;

export const tokensListInputSchema = z.object({ window: tokenWindowSchema }).strict();
export const tokensListOutputSchema = z
  .object({
    blockNumber: units,
    /** The head block's own time, unix seconds: every figure is as of this block. */
    asOf: z.number().int().nonnegative(),
    quote: tokenBasicsSchema,
    window: tokenWindowSchema,
    tokens: z.array(tokenListRowSchema),
  })
  .strict();
export type TokensList = z.infer<typeof tokensListOutputSchema>;

export const tokenCandleSchema = z.object({ time: z.number().int(), open: decimal, high: decimal, low: decimal, close: decimal }).strict();
export const tokenPairSchema = z
  .object({
    pool: address,
    other: tokenBasicsSchema,
    feeBps: z.number().int(),
    /** This token's reserve and the other token's, base units: liquidity in token amounts. */
    reserve: units,
    reserveOther: units,
    /** This token's amount over every swap in the pool, base units. */
    volume: units,
    /** One candle per minute with a swap, opening at that minute's first swap; prices in the other token. */
    candles: z.array(tokenCandleSchema),
  })
  .strict();
export const tokenTradeSchema = z
  .object({
    tx: hash,
    logIndex: z.number().int(),
    time: z.number().int(),
    pool: address,
    /** The account the pool paid (the swap's `to`): the trader, or whatever account the trader named. */
    wallet: address,
    side: z.enum(['buy', 'sell']),
    amount: units,
    other: tokenBasicsSchema,
    amountOther: units,
  })
  .strict();
export const tokenHolderSchema = z.object({ address, amount: units }).strict();

export const tokenPageInputSchema = z.object({ address }).strict();
export const tokenPageOutputSchema = z
  .object({
    blockNumber: units,
    asOf: z.number().int().nonnegative(),
    token: tokenBasicsSchema,
    quote: tokenBasicsSchema,
    listed: z.boolean(),
    price: decimal.nullable(),
    growthBps24h: z.number().int().nullable(),
    /** Fees paid into this token's pools, valued in the quote token at today's prices. */
    feesPaid: decimal,
    trust: z
      .object({
        /** "unknown" for a token with no trade on record; otherwise null with `tierRefusal`, since the criteria are blank. */
        tier: z.literal('unknown').nullable(),
        tierRefusal: z.literal(TRUST_CRITERIA_UNSET).nullable(),
        organicScore: z.null(),
        organicRefusal: z.literal(ORGANIC_SCORE_UNSET),
        flags: z.array(z.enum(['no_lp_lock', 'no_vesting', 'lookalike', 'no_history'])),
        lookalikeOf: tokenLookalikeSchema.nullable(),
      })
      .strict(),
    pairs: z.array(tokenPairSchema),
    trades: z.array(tokenTradeSchema),
    holders: z
      .object({
        totalSupply: units,
        /** Held by the zero address and the conventional dead address. */
        burned: units,
        supplyLessBurned: units,
        list: z.array(tokenHolderSchema),
      })
      .strict(),
  })
  .strict();
export type TokenPageData = z.infer<typeof tokenPageOutputSchema>;

export const leaderboardTradeSchema = z
  .object({
    tx: hash,
    logIndex: z.number().int(),
    time: z.number().int(),
    token: tokenBasicsSchema,
    side: z.enum(['buy', 'sell']),
    amount: units,
    /** The quote token paid or received, base units. */
    quoteAmount: units,
    /** A sell's result against the average cost of what the wallet bought before it; null for a buy or with no cost. */
    realised: decimal.nullable(),
  })
  .strict();
export const leaderboardRowSchema = z.object({ wallet: address, realised: decimal, trades: z.array(leaderboardTradeSchema) }).strict();
export const tokensLeaderboardOutputSchema = z
  .object({ blockNumber: units, asOf: z.number().int(), quote: tokenBasicsSchema, rows: z.array(leaderboardRowSchema) })
  .strict();
export type TokensLeaderboard = z.infer<typeof tokensLeaderboardOutputSchema>;
