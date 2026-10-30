import { z } from 'zod';

/**
 * Wire types for the self-custody swap (D-swap-01, -02, -04): the pools the app's network trades, the swap settings the
 * owner publishes, a quote read from one pool's live reserves, and the unsigned calls the person's wallet signs.
 * Token amounts are base-unit decimal strings, never numbers. Nothing here posts to the ledger.
 */
export const SWAP_SETTINGS_UNSET = 'protocol.swap_settings_unset' as const;

const units = z.string().regex(/^(0|[1-9][0-9]*)$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

export const protocolSwapTokenSchema = z
  .object({
    address,
    name: z.string(),
    symbol: z.string(),
    decimals: z.number().int().min(0).max(36),
  })
  .strict();
export type ProtocolSwapToken = z.infer<typeof protocolSwapTokenSchema>;

export const protocolSwapPoolSchema = z
  .object({
    pool: address,
    token0: address,
    token1: address,
    feeBps: z.number().int().min(0).max(1000),
    reserve0: units,
    reserve1: units,
    /** The pool's own last-touch time (seconds), not the head block's. */
    blockTimestampLast: z.number().int().nonnegative(),
  })
  .strict();
export type ProtocolSwapPool = z.infer<typeof protocolSwapPoolSchema>;

/** `protocol.amm.pairs`: every pool the configured factory lists and the tokens they trade, read at one block. */
export const protocolSwapPairsOutputSchema = z
  .object({
    factory: address,
    blockNumber: units,
    tokens: z.array(protocolSwapTokenSchema),
    pools: z.array(protocolSwapPoolSchema),
    /** Pools the factory lists that were left out: the pool, or one of its tokens, did not answer as one. */
    skipped: z.number().int().nonnegative(),
  })
  .strict();
export type ProtocolSwapPairs = z.infer<typeof protocolSwapPairsOutputSchema>;

/**
 * `protocol.amm.swapSettings`: what the owner set. A blank one refuses `protocol.swap_settings_unset` (or the slippage
 * refusal) and the form keeps Swap off; nothing is defaulted.
 */
export const protocolSwapSettingsOutputSchema = z
  .object({
    /** The most a minimum may sit under the quote, in basis points; the slippage ceiling. */
    slippageCeilingBps: z.number().int().min(0).max(5000),
    /** How long a quote may be used before it must be read again. */
    quoteTtlSeconds: z.number().int().positive(),
    /** Blocks on top of the swap's own before the form calls it filled. */
    confirmations: z.number().int().min(0),
  })
  .strict();
export type ProtocolSwapSettings = z.infer<typeof protocolSwapSettingsOutputSchema>;

/** `protocol.amm.quoteFromPool`: a quote from the pool's reserves as read now. */
export const protocolPoolQuoteOutputSchema = z.object({
  amountOut: units,
  priceImpactBps: z.number().int(),
  reserveIn: units,
  reserveOut: units,
  feeBps: z.number().int(),
  reservesFromChain: z.literal(true),
  blockTimestampLast: z.number().int(),
});
export type ProtocolPoolQuote = z.infer<typeof protocolPoolQuoteOutputSchema>;

/** A call the person's wallet signs and sends. `value` is always "0": nothing this service builds moves native value. */
export const protocolUnsignedCallSchema = z.object({
  to: address,
  data: z.string().regex(/^0x([0-9a-fA-F]{2})*$/),
  value: z.string(),
  summary: z.string(),
});
export type ProtocolUnsignedCall = z.infer<typeof protocolUnsignedCallSchema>;

/** `protocol.amm.checkApproval`. */
export const protocolApprovalCheckOutputSchema = z.object({
  needsApproval: z.boolean(),
  resetFirst: z.boolean(),
  current: units,
  blockNumber: units,
  unlimited: z.boolean(),
  calls: z.array(protocolUnsignedCallSchema),
});
export type ProtocolApprovalCheck = z.infer<typeof protocolApprovalCheckOutputSchema>;

/** A blank `PROTOCOL_SWAP_MAX_FEE_PER_GAS_WEI`: no fee level is offered and Swap stays off. */
export const SWAP_FEE_CAP_UNSET = 'protocol.swap_fee_cap_unset' as const;
/** The node reports no base fee or no priority-fee history (no EIP-1559 fee market), so no level can be priced. */
export const FEE_MARKET_UNREAD = 'protocol.fee_market_unread' as const;

/** One network fee level: what the wallet is asked to offer per unit of gas, in wei. */
export const protocolSwapFeeLevelSchema = z
  .object({
    maxFeePerGasWei: units,
    maxPriorityFeePerGasWei: units,
    /** The level's most per gas is above the owner's fee cap: it cannot be chosen. */
    overCap: z.boolean(),
  })
  .strict();
export type ProtocolSwapFeeLevel = z.infer<typeof protocolSwapFeeLevelSchema>;

const percentile = z.number().int().min(0).max(100);

/**
 * `protocol.amm.feeLevels` (D-swap-11): Slow, Normal and Fast from the owner percentiles of the last blocks' priority
 * fees, the next block's base fee, and the owner's fee cap. A blank cap or percentile setting refuses; nothing defaults.
 */
export const protocolSwapFeesOutputSchema = z
  .object({
    asOf: z.string().datetime(),
    chainId: z.number().int().positive(),
    /** How many recent blocks the levels are read from, and at which percentiles (owner settings). */
    blocks: z.number().int().positive(),
    percentiles: z.tuple([percentile, percentile, percentile]),
    /** The base fee of the next block, as the node reports it. */
    baseFeePerGasWei: units,
    /** The most per gas any level or custom fee may offer (owner setting). */
    feeCapWei: units,
    levels: z.object({ slow: protocolSwapFeeLevelSchema, normal: protocolSwapFeeLevelSchema, fast: protocolSwapFeeLevelSchema }).strict(),
    /** True only when a paymaster pays the fee for the person. None is wired here, so the person pays. */
    sponsored: z.boolean(),
  })
  .strict();
export type ProtocolSwapFees = z.infer<typeof protocolSwapFeesOutputSchema>;

/** One live allowance the owner has given: `spender` may move up to `allowance` base units of `token`. */
export const protocolAllowanceRowSchema = z
  .object({
    token: address,
    spender: address,
    allowance: units,
    /** The allowance is the largest possible amount (an "unlimited" approval). */
    unlimited: z.boolean(),
    /** Set when the spender is a pool the factory lists, with the pair it trades. */
    pool: z.object({ token0: address, token1: address }).strict().nullable(),
  })
  .strict();
export type ProtocolAllowanceRow = z.infer<typeof protocolAllowanceRowSchema>;

/**
 * `protocol.amm.allowances`: the owner's live allowances for the tokens the factory's pools trade, every value read at
 * one block. Candidates are each listed pool (for both its tokens) and every spender named in the owner's Approval logs
 * from `logsFromBlock`; only a non-zero `allowance()` read at `blockNumber` becomes a row. Nothing is listed from config.
 */
export const protocolAllowancesOutputSchema = z
  .object({
    owner: address,
    blockNumber: units,
    /** The first block the Approval logs were read from: a read bound, so an older approval to a non-pool spender is not found. */
    logsFromBlock: units,
    /** The node refused the Approval log read: only the pools were checked, so an approval to another spender may be missing. */
    approvalLogsUnread: z.boolean(),
    tokens: z.array(protocolSwapTokenSchema),
    rows: z.array(protocolAllowanceRowSchema),
    /** Candidates whose token did not answer `allowance()`: not shown, and counted so the page can say so. */
    unread: z.number().int().nonnegative(),
    /** More candidates than one read checks: the rest are not shown. */
    truncated: z.boolean(),
  })
  .strict();
export type ProtocolAllowances = z.infer<typeof protocolAllowancesOutputSchema>;

export const PRICE_SETTINGS_UNSET = 'protocol.price_settings_unset' as const;

/** One token's USD price from the pools, or why it has none. `usd` is a decimal string, never a number. */
export const protocolTokenPriceSchema = z
  .object({
    address,
    usd: z
      .string()
      .regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/)
      .nullable(),
    /** reference: an owner reference token (one dollar); pool: from its deepest reference pool; one_hop: through one priced token. */
    basis: z.enum(['reference', 'pool', 'one_hop']).nullable(),
    /** thin_reserve: every pool against a priced token is under the owner's minimum reserve; no_route: no pool leads to a dollar. */
    reason: z.enum(['thin_reserve', 'no_route']).nullable(),
  })
  .strict();
export type ProtocolTokenPrice = z.infer<typeof protocolTokenPriceSchema>;

/** `protocol.amm.prices`: every listed token's USD price, read at one block, with that block's time. */
export const protocolTokenPricesOutputSchema = z
  .object({
    blockNumber: units,
    asOf: z.string().datetime(),
    prices: z.array(protocolTokenPriceSchema),
  })
  .strict();
export type ProtocolTokenPrices = z.infer<typeof protocolTokenPricesOutputSchema>;

/**
 * One leg of `protocol.amm.routes`: a factory pool for the pair, as one venue's ranked legs (D-swap-05 takes the pool
 * venue beside the books from this shape). `best` is the highest output among usable legs; `lost` names its shortfall;
 * `excluded` is a leg the person turned off; `unavailable` names why it cannot be used (`stale`: the pool's recorded
 * reserves differ from the tokens it holds, an unsynced pool whose quote cannot be trusted; `no_liquidity`).
 */
export const protocolRouteLegSchema = z
  .object({
    pool: address,
    feeBps: z.number().int().nonnegative(),
    /** Null when the leg is unavailable: no quote is shown for a pool that cannot be used. */
    amountOut: units.nullable(),
    priceImpactBps: z.number().int().nullable(),
    status: z.enum(['best', 'lost', 'excluded', 'unavailable']),
    /** For `lost`: how much less it gives than the best leg, in the output token's base units. */
    shortfall: units.nullable(),
    reason: z.enum(['stale', 'no_liquidity']).nullable(),
  })
  .strict();
export type ProtocolRouteLeg = z.infer<typeof protocolRouteLegSchema>;

/** `protocol.amm.routes`: every factory pool for a pair ranked for one amount at one block, best first, none dropped. */
export const protocolRouteOptionsOutputSchema = z
  .object({
    venue: z.literal('pool'),
    blockNumber: units,
    tokenIn: address,
    tokenOut: address,
    amountIn: units,
    legs: z.array(protocolRouteLegSchema),
  })
  .strict();
export type ProtocolRouteOptions = z.infer<typeof protocolRouteOptionsOutputSchema>;
