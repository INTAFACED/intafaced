// hand-declared-ok: svc-indexer's explorer output schemas are declared in its router, not in @intafaced/contracts.
import { z } from 'zod';
import type { ApiClient } from '../../../shared/api';

/**
 * Read-only wire shapes for the pool pages (D-explorer-05), mirroring svc-indexer's `explorer.pools.list`, `.get` and
 * `.swaps` output and keeping only what the pages render. Amounts are raw base units as decimal strings; each token says
 * its own decimals, or null when it never answered.
 */
const tokenSchema = z.object({
  address: z.string(),
  symbol: z.string().nullable(),
  name: z.string().nullable(),
  decimals: z.number().int().nullable(),
});

const cursorSchema = z.object({ height: z.number().int(), index: z.number().int(), logIndex: z.number().int() });

export const poolSchema = z.object({
  chainId: z.number().int(),
  address: z.string(),
  token0: tokenSchema,
  token1: tokenSchema,
  feeBps: z.number().int(),
  createdHeight: z.number().int(),
  createdTx: z.string(),
  reserves: z.object({ reserve0: z.string(), reserve1: z.string(), height: z.number().int() }).nullable(),
});

const poolsPageSchema = z.object({ rows: z.array(poolSchema), nextCursor: cursorSchema.nullable(), asOf: z.string() });

const candleSchema = z.object({
  start: z.number().int(),
  open: z.string(),
  high: z.string(),
  low: z.string(),
  close: z.string(),
  volume1: z.string(),
  swaps: z.number().int(),
});

const poolDaySchema = z.object({
  pool: poolSchema,
  window: z.object({ since: z.string(), seconds: z.number().int() }),
  volume1: z.string(),
  swaps: z.number().int(),
  candles: z.array(candleSchema).nullable(),
  asOf: z.string(),
});

const swapsPageSchema = z.object({
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
  nextCursor: cursorSchema.nullable(),
  asOf: z.string(),
});

export type Pool = z.infer<typeof poolSchema>;
export type PoolToken = Pool['token0'];
export type PoolCandle = z.infer<typeof candleSchema>;
export type PoolDay = z.infer<typeof poolDaySchema>;
export type PoolSwapsPage = z.infer<typeof swapsPageSchema>;
export type PoolCursor = z.infer<typeof cursorSchema>;
export type CandleInterval = '5m' | '1h';

/** An address the owner's factory did not create, as the indexer answers it. */
export const isNotAPool = (code: string | undefined) => code === 'NOT_FOUND' || code === 'indexer.not_a_pool';

export function createPoolsApi(api: ApiClient) {
  return {
    /** The owner factory's pools, newest first, in pages of the owner's list limit. A blank factory refuses by name. */
    list: (chainId: number, signal?: AbortSignal, cursor?: PoolCursor) =>
      api.query('indexer', 'explorer.pools.list', { chainId, ...(cursor ? { cursor } : {}) }, poolsPageSchema, { signal }),
    /** One pool's facts, its last day's volume and swaps, and that day's candles at the asked width. */
    day: (chainId: number, address: string, interval: CandleInterval, signal?: AbortSignal) =>
      api.query('indexer', 'explorer.pools.get', { chainId, address, interval }, poolDaySchema, { signal }),
    /** The pool's swaps, newest first, each a buy or sell from the first token's side. */
    swaps: (chainId: number, address: string, signal?: AbortSignal, cursor?: PoolCursor) =>
      api.query('indexer', 'explorer.pools.swaps', { chainId, address, ...(cursor ? { cursor } : {}) }, swapsPageSchema, { signal }),
  };
}
export type PoolsApi = ReturnType<typeof createPoolsApi>;
