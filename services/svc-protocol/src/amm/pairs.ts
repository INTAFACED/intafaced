import type { Address } from 'viem';
import type { ProtocolSwapPairs } from '@intafaced/contracts';

/** The reads `listPairs` needs; `ChainClient` provides them, tests stand them in. */
export interface PairsChain {
  factoryPools(factory: Address, limit: number): Promise<{ pools: Address[]; blockNumber: bigint }>;
  poolToken0(pool: Address): Promise<Address>;
  poolToken1(pool: Address): Promise<Address>;
  poolFeeBps(pool: Address): Promise<number>;
  poolReserves(pool: Address): Promise<{ reserve0: bigint; reserve1: bigint; blockTimestampLast: number }>;
  tokenBasics(token: Address): Promise<{ name: string; symbol: string; decimals: number }>;
}

/**
 * The most pools one read lists. A read bound for one request, not a product limit: a factory with more pools than this
 * lists its first ones, in its own order, and says how many it holds through `pools.length` never exceeding it.
 */
export const PAIRS_READ_LIMIT = 200;

/**
 * Every pool the factory lists with the tokens they trade (D-swap-01). Each value comes from the pool or token contract
 * itself; nothing is echoed from the caller. A read that fails refuses the whole answer (the client's typed chain
 * refusal), so the form never shows a partial list as if it were complete.
 */
export async function listPairs(chain: PairsChain, factory: Address): Promise<ProtocolSwapPairs> {
  const { pools, blockNumber } = await chain.factoryPools(factory, PAIRS_READ_LIMIT);
  const read = await Promise.all(
    pools.map(async (pool) => {
      const [token0, token1, feeBps, reserves] = await Promise.all([
        chain.poolToken0(pool),
        chain.poolToken1(pool),
        chain.poolFeeBps(pool),
        chain.poolReserves(pool),
      ]);
      return {
        pool,
        token0,
        token1,
        feeBps,
        reserve0: reserves.reserve0.toString(),
        reserve1: reserves.reserve1.toString(),
        blockTimestampLast: reserves.blockTimestampLast,
      };
    }),
  );
  const addresses = [...new Map(read.flatMap((row) => [row.token0, row.token1]).map((a) => [a.toLowerCase(), a])).values()];
  const tokens = await Promise.all(addresses.map(async (address) => ({ address, ...(await chain.tokenBasics(address)) })));
  return { factory, blockNumber: blockNumber.toString(), tokens, pools: read };
}
