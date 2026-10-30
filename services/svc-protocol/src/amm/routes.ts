import type { Address } from 'viem';
import type { ProtocolPoolQuote, ProtocolRouteLeg, ProtocolRouteOptions, ProtocolSwapPairs } from '@intafaced/contracts';
import { quoteExactIn } from './build.js';

/** The read `routeOptions` needs beyond the pairs; `ProtocolChain` provides it, tests stand it in. */
export interface RoutesChain {
  /** `holder`'s balance of `token` at `blockNumber`. */
  tokenBalanceAt(token: Address, holder: Address, blockNumber: bigint): Promise<bigint>;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * How far a pool's holdings may run past its recorded reserves before its price is stale, in basis points of the
 * reserve. A surplus is credited to the next swapper and never hurts them, so a small one (anyone can send a pool one
 * unit) leaves the pool usable; a shortfall of any size is stale, since the pool cannot pay out what it prices from.
 * This is how the reading is judged, not a market magnitude: no price, fee or limit comes from it.
 */
export const STALE_SURPLUS_BPS = 100n;

/** Whether `held` no longer matches `reserve` closely enough to price from the reserve. */
export function isStale(held: bigint, reserve: bigint): boolean {
  if (held < reserve) return true;
  return (held - reserve) * 10_000n > reserve * STALE_SURPLUS_BPS;
}

/**
 * Holdings reads shared within one block: every call for the pairs' block reuses what an earlier call read, and a new
 * block starts afresh. The pairs are already shared the same way, so repeat route reads in one block cost nothing.
 */
export function blockBalances(chain: RoutesChain, maxEntries = 4_096): RoutesChain {
  let block = -1n;
  const seen = new Map<string, Promise<bigint>>();
  return {
    tokenBalanceAt(token, holder, blockNumber) {
      if (blockNumber !== block) {
        if (blockNumber < block) return chain.tokenBalanceAt(token, holder, blockNumber);
        block = blockNumber;
        seen.clear();
      }
      const key = `${token.toLowerCase()}:${holder.toLowerCase()}`;
      const hit = seen.get(key);
      if (hit) return hit;
      const read = chain.tokenBalanceAt(token, holder, blockNumber);
      // A failed read is not kept: the next call asks the chain again.
      read.catch(() => seen.delete(key));
      if (seen.size < maxEntries) seen.set(key, read);
      return read;
    },
  };
}

type Leg = Omit<ProtocolRouteLeg, 'status' | 'shortfall'> & { usable: boolean };

/**
 * Route options for one pair and amount (J-dex-protocol-02 #4): every factory pool trading the pair, read at the pairs'
 * block, ranked by the output its own reserves and fee give. A pool whose holdings fall short of its reserves, or run
 * well past them, is listed `unavailable: stale`; an empty side, or an amount that would get nothing out, is
 * `no_liquidity`; a pool the chain did not answer for is `unreadable`. None is dropped, and one bad pool never refuses
 * the others. An excluded pool keeps its place and is marked; the best usable leg leads, every other usable leg says how
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
  const legs: Leg[] = await Promise.all(
    pools.map(async (pool): Promise<Leg> => {
      const base = { pool: pool.pool, feeBps: pool.feeBps, quote: null, usable: false };
      const unavailable = (reason: 'stale' | 'no_liquidity' | 'unreadable'): Leg => ({ ...base, reason });
      let held0: bigint, held1: bigint;
      try {
        [held0, held1] = await Promise.all([
          chain.tokenBalanceAt(pool.token0 as Address, pool.pool as Address, block),
          chain.tokenBalanceAt(pool.token1 as Address, pool.pool as Address, block),
        ]);
      } catch {
        return unavailable('unreadable');
      }
      const reserve0 = BigInt(pool.reserve0);
      const reserve1 = BigInt(pool.reserve1);
      if (isStale(held0, reserve0) || isStale(held1, reserve1)) return unavailable('stale');
      const inIs0 = same(pool.token0, input.tokenIn);
      const reserveIn = inIs0 ? reserve0 : reserve1;
      const reserveOut = inIs0 ? reserve1 : reserve0;
      if (reserveIn === 0n || reserveOut === 0n) return unavailable('no_liquidity');
      let quoted: { amountOut: bigint; priceImpactBps: number };
      try {
        quoted = quoteExactIn({ amountIn: input.amountIn, reserveIn, reserveOut, feeBps: pool.feeBps });
      } catch {
        return unavailable('unreadable');
      }
      if (quoted.amountOut === 0n) return unavailable('no_liquidity');
      const quote: ProtocolPoolQuote = {
        amountOut: quoted.amountOut.toString(),
        priceImpactBps: quoted.priceImpactBps,
        reserveIn: reserveIn.toString(),
        reserveOut: reserveOut.toString(),
        feeBps: pool.feeBps,
        reservesFromChain: true,
        blockTimestampLast: pool.blockTimestampLast,
      };
      return { ...base, quote, usable: true, reason: null };
    }),
  );
  const out = (leg: Leg) => (leg.quote ? BigInt(leg.quote.amountOut) : -1n);
  legs.sort((a, b) => (out(a) === out(b) ? a.pool.localeCompare(b.pool) : out(a) > out(b) ? -1 : 1));
  const excluded = new Set(input.exclude.map((pool) => pool.toLowerCase()));
  const usable = legs.filter((leg) => leg.usable && !excluded.has(leg.pool.toLowerCase()));
  const best = usable[0] ? out(usable[0]) : null;
  const answer: ProtocolRouteLeg[] = legs.map(({ usable: ok, ...leg }) => {
    if (!ok) return { ...leg, status: 'unavailable', shortfall: null };
    if (excluded.has(leg.pool.toLowerCase())) return { ...leg, status: 'excluded', shortfall: null };
    if (leg.pool === usable[0]!.pool) return { ...leg, status: 'best', shortfall: null };
    return { ...leg, status: 'lost', shortfall: (best! - BigInt(leg.quote!.amountOut)).toString() };
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
