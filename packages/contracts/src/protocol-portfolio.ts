import { z } from 'zod';

/**
 * `protocol.portfolio.read` (D-portfolio-wallet-04, J-dex-protocol-06): one address's holdings of the tokens the app's
 * pools list, priced from the pools, and its value history read from the chain, block by block. Public chain data: the
 * address asked about is the whole scope, and nothing here signs, posts or moves anything. Amounts are base-unit decimal
 * strings and USD figures decimal strings, never numbers.
 */
const units = z.string().regex(/^(0|[1-9][0-9]*)$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const usd = z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/);
const signedUsd = z.string().regex(/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/);

export const protocolPortfolioInputSchema = z.object({ address }).strict();
export type ProtocolPortfolioInput = z.infer<typeof protocolPortfolioInputSchema>;

/** One token the address holds now, with its price from the pools or why it has none. */
export const protocolPortfolioHoldingSchema = z
  .object({
    token: address,
    name: z.string(),
    symbol: z.string(),
    decimals: z.number().int().min(0).max(36),
    balance: units,
    /** The USD price now, as `amm.prices` reads it; null with `reason` when the pools give no honest price. */
    usd: usd.nullable(),
    reason: z.enum(['thin_reserve', 'no_route']).nullable(),
    /** balance × price; null when the token has no price, and then it is not in the total. */
    valueUsd: usd.nullable(),
    /**
     * The entry price: the average, by amount, of the token's price at each block an amount of it arrived. Null when no
     * arrival had a price. `arrivals` counts every arrival, `unpriced` those with no price at their block.
     */
    entry: z
      .object({
        usd,
        arrivals: z.number().int().nonnegative(),
        unpriced: z.number().int().nonnegative(),
        firstBlock: units,
        lastBlock: units,
      })
      .strict()
      .nullable(),
  })
  .strict();
export type ProtocolPortfolioHolding = z.infer<typeof protocolPortfolioHoldingSchema>;

/** One token transfer to or from the address, as its log says. */
export const protocolPortfolioTransferSchema = z
  .object({
    block: units,
    /** The block's own time, seconds since 1970. */
    time: z.number().int().nonnegative(),
    tx: hash,
    token: address,
    symbol: z.string(),
    decimals: z.number().int().min(0).max(36),
    direction: z.enum(['in', 'out']),
    amount: units,
    counterparty: address,
    /** The other side is one of the listed pools: a trade, not money coming in or going out. */
    pool: z.boolean(),
  })
  .strict();
export type ProtocolPortfolioTransfer = z.infer<typeof protocolPortfolioTransferSchema>;

export const protocolPortfolioOutputSchema = z
  .object({
    address,
    blockNumber: units,
    asOf: z.string().datetime(),
    /** The sum of every priced holding. A token with no price is left out and counted in `unpriced`. */
    totalUsd: usd,
    unpriced: z.number().int().nonnegative(),
    holdings: z.array(protocolPortfolioHoldingSchema),
    /**
     * Profit and loss since the address first held a listed token: the value now less what came in and plus what went
     * out, each valued at its own block's price. A trade with a pool is not money in or out. Null with no history.
     */
    pnl: z
      .object({
        usd: signedUsd,
        depositsUsd: usd,
        withdrawalsUsd: usd,
        sinceBlock: units,
      })
      .strict()
      .nullable(),
    /**
     * The largest fall of the value from a peak, with money in and out taken out (each block's change is the value's
     * move less what came in or went out). Null until the value has fallen from a peak.
     */
    drawdown: z
      .object({
        /** Percent, two decimals. */
        pct: usd,
        peakUsd: usd,
        peakBlock: units,
        troughUsd: usd,
        troughBlock: units,
      })
      .strict()
      .nullable(),
    /** The newest transfers first, up to `PORTFOLIO_TRANSFERS_SHOWN`. */
    transfers: z.array(protocolPortfolioTransferSchema),
    /** Every transfer the history read, so the page can say when it shows only the newest. */
    transferCount: z.number().int().nonnegative(),
  })
  .strict();
export type ProtocolPortfolio = z.infer<typeof protocolPortfolioOutputSchema>;

/** The most transfers one answer lists, newest first. A read bound for one page, not a product limit. */
export const PORTFOLIO_TRANSFERS_SHOWN = 100;
