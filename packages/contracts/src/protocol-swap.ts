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
