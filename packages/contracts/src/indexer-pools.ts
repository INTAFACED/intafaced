import { z } from 'zod';

/**
 * Read-only wire shapes for the pool pages (D-explorer-05), mirroring svc-indexer's `explorer.pools.list`, `.get` and
 * `.swaps` output and keeping only what the pages render. Amounts are raw base units as decimal strings; each token says
 * its own decimals, or null when it never answered. Browser-safe (zod only).
 */
export const poolTokenSchema = z.object({
  address: z.string(),
  symbol: z.string().nullable(),
  name: z.string().nullable(),
  decimals: z.number().int().nullable(),
});

export const poolCursorSchema = z.object({ height: z.number().int(), index: z.number().int(), logIndex: z.number().int() });

export const poolSchema = z.object({
  chainId: z.number().int(),
  address: z.string(),
  token0: poolTokenSchema,
  token1: poolTokenSchema,
  feeBps: z.number().int(),
  createdHeight: z.number().int(),
  createdTx: z.string(),
  reserves: z.object({ reserve0: z.string(), reserve1: z.string(), height: z.number().int() }).nullable(),
});

/** A row of the list also carries the pool's last day of swaps: token1 volume in base units and the swap count. */
export const poolListRowSchema = poolSchema.extend({ volume1: z.string(), swaps: z.number().int() });
export const poolsPageSchema = z.object({ rows: z.array(poolListRowSchema), nextCursor: poolCursorSchema.nullable(), asOf: z.string() });

export const poolCandleSchema = z.object({
  start: z.number().int(),
  open: z.string(),
  high: z.string(),
  low: z.string(),
  close: z.string(),
  volume1: z.string(),
  swaps: z.number().int(),
});

export const poolDaySchema = z.object({
  pool: poolSchema,
  window: z.object({ since: z.string(), seconds: z.number().int() }),
  volume1: z.string(),
  swaps: z.number().int(),
  candles: z.array(poolCandleSchema).nullable(),
  asOf: z.string(),
});

export const poolSwapsPageSchema = z.object({
  rows: z.array(
    z.object({
      hash: z.string(),
      blockHeight: z.number().int(),
      logIndex: z.number().int(),
      timestamp: z.number().int(),
      side: z.enum(['buy', 'sell', 'both']),
      amount0In: z.string(),
      amount1In: z.string(),
      amount0Out: z.string(),
      amount1Out: z.string(),
    }),
  ),
  nextCursor: poolCursorSchema.nullable(),
  asOf: z.string(),
});

export type Pool = z.infer<typeof poolSchema>;
export type PoolListRow = z.infer<typeof poolListRowSchema>;
export type PoolToken = Pool['token0'];
export type PoolCandle = z.infer<typeof poolCandleSchema>;
export type PoolDay = z.infer<typeof poolDaySchema>;
export type PoolSwapsPage = z.infer<typeof poolSwapsPageSchema>;
export type PoolCursor = z.infer<typeof poolCursorSchema>;
