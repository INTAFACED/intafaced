import { z } from 'zod';
import { protocolUnsignedCallSchema } from './protocol-swap.js';

/**
 * Wire types for providing liquidity (D-liquidity-01..04, J-dex-protocol-12): the fee tiers the owner publishes, whether
 * a pool exists, the quotes and unsigned calls for creating, adding, removing and swap-and-add, and a wallet's positions
 * read from the chain. Protocol Plane only: the person's wallet signs every call, the shares are the pool's own ERC-20
 * token, and nothing here posts to the ledger. Token amounts are base-unit decimal strings, never numbers.
 */
export const AMM_FEE_TIERS_UNSET = 'amm.fee_tiers_unset' as const;
export const AMM_FEE_OUT_OF_RANGE = 'amm.fee_out_of_range' as const;
export const LIQUIDITY_ROUTER_UNSET = 'protocol.liquidity_router_unset' as const;
export const LIQUIDITY_BOUNDS_UNSET = 'protocol.bounds_unset' as const;
export const LIQUIDITY_POOL_EXISTS = 'amm.pool_exists' as const;
export const LIQUIDITY_NOT_A_POOL = 'protocol.not_factory_pool' as const;
export const LIQUIDITY_FEES_COMPOUND = 'protocol.fees_compound' as const;
/** The highest swap fee a pool can be created with, in bps: the pool contract's own cap (10%). */
export const POOL_FEE_CAP_BPS = 1000;

const units = z.string().regex(/^(0|[1-9][0-9]*)$/);
const signedUnits = z.string().regex(/^(0|-?[1-9][0-9]*)$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const feeBps = z.number().int().min(0).max(POOL_FEE_CAP_BPS);

export const liquidityTokenSchema = z.object({ address, name: z.string(), symbol: z.string(), decimals: z.number().int() }).strict();
export type LiquidityToken = z.infer<typeof liquidityTokenSchema>;

/** `amm.feeTiers`: the owner's published tiers, in bps, lowest first. Blank refuses `amm.fee_tiers_unset`. */
export const liquidityFeeTiersOutputSchema = z.object({ tiers: z.array(feeBps), capBps: z.literal(POOL_FEE_CAP_BPS) }).strict();

export const liquidityPoolExistsInputSchema = z.object({ tokenA: address, tokenB: address, feeBps });
/** `amm.poolExists`: the factory's pool for the pair and fee, or the address it would get. */
export const liquidityPoolExistsOutputSchema = z.object({ exists: z.boolean(), pool: address, blockNumber: units }).strict();

export const liquidityCreateInputSchema = z.object({
  owner: address,
  tokenA: address,
  tokenB: address,
  feeBps: z.number().int(),
  amountA: units,
  amountB: units,
});
/** `amm.buildCreateAndSeed`: one call that creates the pool and makes its first deposit, which sets its price. */
export const liquidityCreateOutputSchema = z
  .object({
    call: protocolUnsignedCallSchema,
    /** The router the person approves for both tokens before the call. */
    router: address,
    pool: address,
    minShares: units,
    deadline: z.number().int(),
  })
  .strict();

export const liquidityQuoteAddInputSchema = z.object({ pool: address, amount0Desired: units, amount1Desired: units });
/** `amm.quoteAddLiquidity`: what an add deposits (the pool's ratio of what was offered) and mints, read now. */
export const liquidityQuoteAddOutputSchema = z
  .object({
    pool: address,
    token0: liquidityTokenSchema,
    token1: liquidityTokenSchema,
    reserve0: units,
    reserve1: units,
    amount0: units,
    amount1: units,
    shares: units,
    totalSupply: units,
    /** The share of the pool the minted shares would be, in bps of the supply after the add. */
    shareOfPoolBps: z.number().int(),
    blockNumber: units,
    /** How long this quote may be used before it must be read again (the owner's quote lifetime). */
    quoteTtlSeconds: z.number().int().positive(),
    router: address,
  })
  .strict();

export const liquidityBuildAddInputSchema = liquidityQuoteAddInputSchema.extend({ owner: address, minShares: units });
export const liquidityBuildAddOutputSchema = z
  .object({ call: protocolUnsignedCallSchema, router: address, amount0Min: units, amount1Min: units, deadline: z.number().int() })
  .strict();

export const liquidityQuoteSwapAddInputSchema = z.object({ pool: address, tokenIn: address, amountIn: units });
/** `amm.quoteSwapAndAdd`: how much of the one token is swapped first, what that gives, and the shares then minted. */
export const liquidityQuoteSwapAddOutputSchema = z
  .object({
    swapped: units,
    received: units,
    shares: units,
    blockNumber: units,
    quoteTtlSeconds: z.number().int().positive(),
    router: address,
  })
  .strict();
export const liquidityBuildSwapAddInputSchema = liquidityQuoteSwapAddInputSchema.extend({ owner: address, minShares: units });
export const liquidityBuildSwapAddOutputSchema = z
  .object({ call: protocolUnsignedCallSchema, router: address, deadline: z.number().int() })
  .strict();

export const liquidityBuildRemoveInputSchema = z.object({ owner: address, pool: address, shares: units });
/** `amm.buildRemoveLiquidity`: burns shares for both tokens pro rata; the minimums are the owner's slippage under now. */
export const liquidityBuildRemoveOutputSchema = z
  .object({
    call: protocolUnsignedCallSchema,
    router: address,
    amount0: units,
    amount1: units,
    amount0Min: units,
    amount1Min: units,
    deadline: z.number().int(),
  })
  .strict();

export const liquiditySendSharesInputSchema = z.object({ owner: address, pool: address, to: address, shares: units });
export const liquiditySendSharesOutputSchema = z.object({ call: protocolUnsignedCallSchema }).strict();

export const liquidityPositionsInputSchema = z.object({ account: address });
export const liquidityPositionRowSchema = z
  .object({
    pool: address,
    token0: liquidityTokenSchema,
    token1: liquidityTokenSchema,
    feeBps,
    shares: units,
    totalSupply: units,
  })
  .strict();
/** `amm.positions`: every factory pool the account holds shares in, read from the pools at one block. */
export const liquidityPositionsOutputSchema = z
  .object({ account: address, blockNumber: units, positions: z.array(liquidityPositionRowSchema) })
  .strict();

export const liquidityPositionInputSchema = z.object({ pool: address, account: address });
/**
 * `amm.position`: one account's shares in one pool, what they are worth now, and, when every share it holds came from
 * its own deposits, what it put in. Fees stay in the pool and compound, so "fees earned" is an estimate from the pool's
 * growth per share since the deposits. A share that arrived by transfer has no entry: `entry`, `feesEarned` and
 * `impermanentLoss` are null and the page says "Entry unknown".
 */
export const liquidityPositionOutputSchema = z
  .object({
    pool: address,
    account: address,
    token0: liquidityTokenSchema,
    token1: liquidityTokenSchema,
    feeBps,
    shares: units,
    totalSupply: units,
    shareOfPoolBps: z.number().int(),
    reserve0: units,
    reserve1: units,
    /** What the shares are worth now, in each token. */
    amount0: units,
    amount1: units,
    entry: z.object({ amount0: units, amount1: units, shares: units }).strict().nullable(),
    feesEarned: z.object({ amount0: units, amount1: units }).strict().nullable(),
    impermanentLoss: z
      .object({
        /** The entry amounts for the shares still held: what holding the tokens instead would have now. */
        held0: units,
        held1: units,
        now0: units,
        now1: units,
        diff0: signedUnits,
        diff1: signedUnits,
        /** Both sides valued in token1 at the pool's price now, and their difference in bps of the held value. */
        valueHeld1: units,
        valueNow1: units,
        diffBps: z.number().int(),
        /** The constant-product loss for this price move alone (fees left out): 2·√r / (1 + r) − 1, in bps. */
        closedFormBps: z.number().int(),
      })
      .strict()
      .nullable(),
    feeModel: z.literal('compounding'),
    blockNumber: units,
  })
  .strict();

export const liquidityExplainInputSchema = z.object({ from: address, to: address, data: z.string().regex(/^0x([0-9a-fA-F]{2})*$/) });
/** `amm.explainLiquidityCall`: the call run against the chain now; when it reverts, the contract's own error name. */
export const liquidityExplainOutputSchema = z.object({ reverts: z.boolean(), error: z.string().nullable(), blockNumber: units }).strict();

export type LiquidityFeeTiers = z.infer<typeof liquidityFeeTiersOutputSchema>;
export type LiquidityPoolExists = z.infer<typeof liquidityPoolExistsOutputSchema>;
export type LiquidityCreate = z.infer<typeof liquidityCreateOutputSchema>;
export type LiquidityQuoteAdd = z.infer<typeof liquidityQuoteAddOutputSchema>;
export type LiquidityBuildAdd = z.infer<typeof liquidityBuildAddOutputSchema>;
export type LiquidityQuoteSwapAdd = z.infer<typeof liquidityQuoteSwapAddOutputSchema>;
export type LiquidityBuildSwapAdd = z.infer<typeof liquidityBuildSwapAddOutputSchema>;
export type LiquidityBuildRemove = z.infer<typeof liquidityBuildRemoveOutputSchema>;
export type LiquiditySendShares = z.infer<typeof liquiditySendSharesOutputSchema>;
export type LiquidityPositions = z.infer<typeof liquidityPositionsOutputSchema>;
export type LiquidityPositionRow = z.infer<typeof liquidityPositionRowSchema>;
export type LiquidityPosition = z.infer<typeof liquidityPositionOutputSchema>;
export type LiquidityExplain = z.infer<typeof liquidityExplainOutputSchema>;
