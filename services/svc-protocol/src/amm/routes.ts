import type { Address } from 'viem';
import type { ProtocolRouteLeg, ProtocolRouteOptions, ProtocolSwapPairs } from '@intafaced/contracts';
import { quoteExactIn } from './build.js';

/** The read `routeOptions` needs beyond the pairs; `ProtocolChain` provides it, tests stand it in. */
export interface RoutesChain {
  /** `holder`'s balance of `token` at `blockNumber`. */
  tokenBalanceAt(token: Address, holder: Address, blockNumber: bigint): Promise<bigint>;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Route options for one pair and amount (J-dex-protocol-02 #4): every factory pool trading the pair, read at the pairs'
 * block, ranked by the output its own reserves and fee give. A pool whose recorded reserves differ from the tokens it
 * holds is unsynced: its quote is not what a swap would pay, so it is listed `unavailable: stale`, never quoted and never
 * dropped. An excluded pool keeps its place and is marked; the best usable leg leads, every other usable leg says how
 * much less it gives. This is the pool venue only: the books, hops, splits and preferences of D-swap-05 are svc-dex's.
 */
export async function routeOptions(
  chain: RoutesChain,
  pairs: ProtocolSwapPairs,
  input: { tokenIn: Address; tokenOut: Address; amountIn: bigint; exclude: readonly string[] },
): Promise<ProtocolRouteOptions> {
  const block = BigInt(pairs.blockNumber);
  const pools = pairs.pools.filter(
    (pool) =>
      (same(pool.token0, input.tokenIn) && same(pool.token1, input.tokenOut)) ||
      (same(pool.token1, input.tokenIn) && same(pool.token0, input.tokenOut)),
  );
  const legs = await Promise.all(
    pools.map(async (pool) => {
      const [held0, held1] = await Promise.all([
        chain.tokenBalanceAt(pool.token0 as Address, pool.pool as Address, block),
        chain.tokenBalanceAt(pool.token1 as Address, pool.pool as Address, block),
      ]);
      const reserve0 = BigInt(pool.reserve0);
      const reserve1 = BigInt(pool.reserve1);
      const base = { pool: pool.pool, feeBps: pool.feeBps, shortfall: null };
      if (held0 !== reserve0 || held1 !== reserve1)
        return { ...base, amountOut: null, priceImpactBps: null, status: 'unavailable' as const, reason: 'stale' as const };
      const inIs0 = same(pool.token0, input.tokenIn);
      const reserveIn = inIs0 ? reserve0 : reserve1;
      const reserveOut = inIs0 ? reserve1 : reserve0;
      if (reserveIn === 0n || reserveOut === 0n)
        return { ...base, amountOut: null, priceImpactBps: null, status: 'unavailable' as const, reason: 'no_liquidity' as const };
      const quoted = quoteExactIn({ amountIn: input.amountIn, reserveIn, reserveOut, feeBps: pool.feeBps });
      return { ...base, amountOut: quoted.amountOut, priceImpactBps: quoted.priceImpactBps, status: 'lost' as const, reason: null };
    }),
  );
  const out = (leg: (typeof legs)[number]) => leg.amountOut ?? -1n;
  legs.sort((a, b) => (out(a) === out(b) ? a.pool.localeCompare(b.pool) : out(a) > out(b) ? -1 : 1));
  const excluded = new Set(input.exclude.map((pool) => pool.toLowerCase()));
  const usable = legs.filter((leg) => leg.amountOut !== null && !excluded.has(leg.pool.toLowerCase()));
  const best = usable[0]?.amountOut ?? null;
  const answer: ProtocolRouteLeg[] = legs.map((leg) => {
    const amountOut = leg.amountOut === null ? null : leg.amountOut.toString();
    if (leg.status === 'unavailable') return { ...leg, amountOut };
    if (excluded.has(leg.pool.toLowerCase())) return { ...leg, amountOut, status: 'excluded', shortfall: null };
    if (leg === usable[0]) return { ...leg, amountOut, status: 'best', shortfall: null };
    return { ...leg, amountOut, status: 'lost', shortfall: (best! - leg.amountOut!).toString() };
  });
  return {
    venue: 'pool',
    blockNumber: pairs.blockNumber,
    tokenIn: input.tokenIn,
    tokenOut: input.tokenOut,
    amountIn: input.amountIn.toString(),
    legs: answer,
  };
}
