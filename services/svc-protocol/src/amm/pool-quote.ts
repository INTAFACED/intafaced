import { getAddress as toChecksum } from 'viem';
import type { Address } from 'viem';
import { quoteExactIn } from './build.js';

export interface PoolReservesRead {
  readonly reserve0: bigint;
  readonly reserve1: bigint;
  readonly blockTimestampLast: number;
}

/** The chain reads a fresh quote needs. No caller-supplied reserves. */
export interface PoolQuoteSource {
  poolReserves(pool: Address): Promise<PoolReservesRead>;
  poolToken0(pool: Address): Promise<Address>;
  poolToken1(pool: Address): Promise<Address>;
  poolFeeBps(pool: Address): Promise<number>;
}

export class PoolTokenError extends Error {
  readonly code = 'amm.token_not_in_pool' as const;

  constructor(pool: Address, tokenIn: Address, token0: Address, token1: Address) {
    super(
      `amm.token_not_in_pool: ${tokenIn} is not traded by pool ${pool}, which holds ` +
        `${token0} and ${token1}. Refusing rather than quoting the wrong side.`,
    );
    this.name = 'PoolTokenError';
  }
}

/**
 * Quote `amountIn` of `tokenIn` from the pool's own reserves, fee, and token
 * order. One observation of `getReserves`; `token0` / `feeBps` are immutable.
 */
export async function freshPoolQuote(chain: PoolQuoteSource, pool: Address, tokenIn: Address, amountIn: bigint) {
  const [reserves, token0, token1, feeBps] = await Promise.all([
    chain.poolReserves(pool),
    chain.poolToken0(pool),
    chain.poolToken1(pool),
    chain.poolFeeBps(pool),
  ]);

  const token = toChecksum(tokenIn);
  const t0 = toChecksum(token0);
  const t1 = toChecksum(token1);
  const inIsToken0 = token === t0;
  const inIsToken1 = token === t1;
  if (!inIsToken0 && !inIsToken1) {
    throw new PoolTokenError(pool, token, t0, t1);
  }

  const reserveIn = inIsToken0 ? reserves.reserve0 : reserves.reserve1;
  const reserveOut = inIsToken0 ? reserves.reserve1 : reserves.reserve0;
  const quoted = quoteExactIn({ amountIn, reserveIn, reserveOut, feeBps });
  return {
    amountOut: quoted.amountOut,
    priceImpactBps: quoted.priceImpactBps,
    reserveIn,
    reserveOut,
    feeBps,
    blockTimestampLast: reserves.blockTimestampLast,
  };
}
