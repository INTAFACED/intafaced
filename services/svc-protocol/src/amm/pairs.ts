import type { Address } from 'viem';
import type { ProtocolSwapPairs } from '@intafaced/contracts';

/** The reads `listPairs` needs; `ChainClient` provides them, tests stand them in. */
export interface PairsChain {
  headBlock(): Promise<bigint>;
  factoryPools(factory: Address, limit: number, blockNumber: bigint): Promise<Address[]>;
  poolSnapshot(
    pool: Address,
    blockNumber: bigint,
  ): Promise<{ token0: Address; token1: Address; feeBps: number; reserve0: bigint; reserve1: bigint; blockTimestampLast: number }>;
  tokenBasics(token: Address): Promise<{ name: string; symbol: string; decimals: number }>;
}

/**
 * The most pools one read lists. A read bound for one request, not a product limit: a factory with more pools than this
 * lists its first ones, in its own order.
 */
export const PAIRS_READ_LIMIT = 200;

/** A refusal that means the chain itself could not be read: then nothing honest can be listed. */
const CHAIN_DOWN = new Set(['protocol.chain_unreachable', 'protocol.chain_id_mismatch', 'protocol.chain_not_configured']);
const chainDown = (reason: unknown) =>
  typeof reason === 'object' && reason !== null && CHAIN_DOWN.has(String((reason as { code?: unknown }).code));

/**
 * Every pool the factory lists with the tokens they trade (D-swap-01), all read at one block. Each value comes from the
 * pool or token contract itself; nothing is echoed from the caller. The factory is permissionless, so one pool or token
 * that does not answer as one (a reverting token, an address with no code) is left out and counted in `skipped`, never
 * allowed to take the list down for everyone. A chain that cannot be read refuses the whole answer.
 */
export async function listPairs(chain: PairsChain, factory: Address, blockNumber?: bigint): Promise<ProtocolSwapPairs> {
  const block = blockNumber ?? (await chain.headBlock());
  const addresses = await chain.factoryPools(factory, PAIRS_READ_LIMIT, block);
  const snapshots = await Promise.allSettled(addresses.map((pool) => chain.poolSnapshot(pool, block)));
  const down = snapshots.find((entry) => entry.status === 'rejected' && chainDown(entry.reason));
  if (down && down.status === 'rejected') throw down.reason;
  const read = snapshots.flatMap((entry, index) =>
    entry.status === 'fulfilled'
      ? [
          {
            pool: addresses[index]!,
            token0: entry.value.token0,
            token1: entry.value.token1,
            feeBps: entry.value.feeBps,
            reserve0: entry.value.reserve0.toString(),
            reserve1: entry.value.reserve1.toString(),
            blockTimestampLast: entry.value.blockTimestampLast,
          },
        ]
      : [],
  );
  const unique = [...new Map(read.flatMap((row) => [row.token0, row.token1]).map((a) => [a.toLowerCase(), a])).values()];
  const basics = await Promise.allSettled(unique.map((address) => chain.tokenBasics(address)));
  const tokenDown = basics.find((entry) => entry.status === 'rejected' && chainDown(entry.reason));
  if (tokenDown && tokenDown.status === 'rejected') throw tokenDown.reason;
  const tokens = basics.flatMap((entry, index) => (entry.status === 'fulfilled' ? [{ address: unique[index]!, ...entry.value }] : []));
  const known = new Set(tokens.map((token) => token.address.toLowerCase()));
  const pools = read.filter((row) => known.has(row.token0.toLowerCase()) && known.has(row.token1.toLowerCase()));
  return { factory, blockNumber: block.toString(), tokens, pools, skipped: addresses.length - pools.length };
}

/**
 * `listPairs` once per block: the answer is the same until a new block, so every caller in that block shares one read,
 * and callers that arrive while it is in flight wait for it instead of starting their own.
 */
export function pairsReader(chain: PairsChain) {
  let last: { key: string; answer: Promise<ProtocolSwapPairs> } | null = null;
  return async (factory: Address): Promise<ProtocolSwapPairs> => {
    const block = await chain.headBlock();
    const key = `${factory.toLowerCase()}:${block}`;
    if (last?.key !== key) {
      const answer = listPairs(chain, factory, block);
      last = { key, answer };
      // A refused read is not kept: the next caller reads again.
      answer.catch(() => {
        if (last?.key === key) last = null;
      });
    }
    return last.answer;
  };
}
