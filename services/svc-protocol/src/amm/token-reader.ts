import { parseAbiItem, type Address, type Hex, type PublicClient } from 'viem';
import type { TokenBasics, TokenPageData } from '@intafaced/contracts';
import { TOKENS_READ_TOO_LARGE } from '@intafaced/contracts';
import { classifyChainError } from '../chain/availability.js';
import { listPairs, type PairsChain } from './pairs.js';
import { holdersFrom, MAX_LOGS, TokensReadError, type MarketSnapshot, type PoolRecord, type SwapLog, type SyncLog } from './tokens.js';

const poolCreated = parseAbiItem(
  'event PoolCreated(address indexed token0, address indexed token1, uint16 feeBps, address pool, uint256 index)',
);
const sync = parseAbiItem('event Sync(uint112 reserve0, uint112 reserve1)');
const swap = parseAbiItem(
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
);
const transfer = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const totalSupplyAbi = [
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const;

/** The log reads the token pages need, on top of the pool reads. Every one is a read; nothing here can sign. */
export interface TokenLogsChain extends PairsChain {
  poolCreatedLogs(factory: Address, toBlock: bigint): Promise<{ pool: Address; block: bigint; index: number }[]>;
  poolLogs(pools: Address[], toBlock: bigint): Promise<{ syncs: Omit<SyncLog, 'time'>[]; swaps: Omit<SwapLog, 'time' | 'wallet'>[] }>;
  blockTimes(blocks: bigint[]): Promise<Map<bigint, number>>;
  signers(txs: Hex[]): Promise<Map<string, Address>>;
  transferLogs(token: Address, toBlock: bigint): Promise<{ from: Address; to: Address; value: bigint }[]>;
  totalSupply(token: Address, blockNumber: bigint): Promise<bigint>;
}

const tooLarge = (count: number) => {
  if (count > MAX_LOGS)
    throw new TokensReadError(
      TOKENS_READ_TOO_LARGE,
      `${count} logs is more than this read takes (${MAX_LOGS}); the indexer must project them.`,
    );
};

/** `TokenLogsChain` over the service's read-only `PublicClient`, looked up per read. A failed read refuses with its chain code. */
export function tokenLogsChain(pairs: PairsChain, client: () => PublicClient, rpcUrl: () => string): TokenLogsChain {
  const read = async <T>(what: string, fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof TokensReadError) throw err;
      throw classifyChainError(err, what, rpcUrl());
    }
  };
  return {
    headBlock: () => pairs.headBlock(),
    factoryPools: (factory, limit, block) => pairs.factoryPools(factory, limit, block),
    poolSnapshot: (pool, block) => pairs.poolSnapshot(pool, block),
    tokenBasics: (token) => pairs.tokenBasics(token),
    poolCreatedLogs: (factory, toBlock) =>
      read('poolCreatedLogs', async () => {
        const logs = await client().getLogs({ address: factory, event: poolCreated, fromBlock: 0n, toBlock });
        tooLarge(logs.length);
        return logs.map((log) => ({ pool: log.args.pool!, block: log.blockNumber!, index: Number(log.args.index!) }));
      }),
    poolLogs: (pools, toBlock) =>
      read('poolLogs', async () => {
        if (pools.length === 0) return { syncs: [], swaps: [] };
        const [syncs, swaps] = await Promise.all([
          client().getLogs({ address: pools, event: sync, fromBlock: 0n, toBlock }),
          client().getLogs({ address: pools, event: swap, fromBlock: 0n, toBlock }),
        ]);
        tooLarge(syncs.length + swaps.length);
        return {
          syncs: syncs.map((log) => ({
            pool: log.address,
            tx: log.transactionHash!,
            logIndex: log.logIndex!,
            block: log.blockNumber!,
            reserve0: log.args.reserve0!,
            reserve1: log.args.reserve1!,
          })),
          swaps: swaps.map((log) => ({
            pool: log.address,
            tx: log.transactionHash!,
            logIndex: log.logIndex!,
            block: log.blockNumber!,
            amount0In: log.args.amount0In!,
            amount1In: log.args.amount1In!,
            amount0Out: log.args.amount0Out!,
            amount1Out: log.args.amount1Out!,
          })),
        };
      }),
    blockTimes: (blocks) =>
      read('blockTimes', async () => {
        const unique = [...new Set(blocks)];
        const times = await Promise.all(
          unique.map((blockNumber) =>
            client()
              .getBlock({ blockNumber })
              .then((b) => Number(b.timestamp)),
          ),
        );
        return new Map(unique.map((block, i) => [block, times[i]!]));
      }),
    signers: (txs) =>
      read('signers', async () => {
        const unique = [...new Set(txs)];
        const froms = await Promise.all(
          unique.map((hash) =>
            client()
              .getTransaction({ hash })
              .then((tx) => tx.from),
          ),
        );
        return new Map(unique.map((hash, i) => [hash.toLowerCase(), froms[i]!]));
      }),
    transferLogs: (token, toBlock) =>
      read('transferLogs', async () => {
        const logs = await client().getLogs({ address: token, event: transfer, fromBlock: 0n, toBlock });
        tooLarge(logs.length);
        return logs.map((log) => ({ from: log.args.from!, to: log.args.to!, value: log.args.value! }));
      }),
    totalSupply: (token, blockNumber) =>
      read('totalSupply', () => client().readContract({ address: token, abi: totalSupplyAbi, functionName: 'totalSupply', blockNumber })),
  };
}

/** Every pool, its history and its tokens at one block. */
export async function readMarket(chain: TokenLogsChain, factory: Address, block: bigint): Promise<MarketSnapshot> {
  const [pairs, created] = await Promise.all([listPairs(chain, factory, block), chain.poolCreatedLogs(factory, block)]);
  const createdBy = new Map(created.map((c) => [c.pool.toLowerCase(), c]));
  const listedPools = pairs.pools.map((p) => p.pool as Address);
  const logs = await chain.poolLogs(listedPools, block);
  const times = await chain.blockTimes([
    block,
    ...created.map((c) => c.block),
    ...logs.syncs.map((s) => s.block),
    ...logs.swaps.map((s) => s.block),
  ]);
  const signers = await chain.signers(logs.swaps.map((s) => s.tx));
  const pools: PoolRecord[] = pairs.pools.map((p) => {
    const made = createdBy.get(p.pool.toLowerCase());
    return {
      pool: p.pool as Address,
      token0: p.token0 as Address,
      token1: p.token1 as Address,
      feeBps: p.feeBps,
      reserve0: BigInt(p.reserve0),
      reserve1: BigInt(p.reserve1),
      createdAt: made ? times.get(made.block)! : 0,
      index: made?.index ?? Number.MAX_SAFE_INTEGER,
    };
  });
  return {
    blockNumber: block,
    asOf: times.get(block)!,
    tokens: pairs.tokens as TokenBasics[],
    pools,
    syncs: logs.syncs.map((s) => ({ ...s, time: times.get(s.block)! })),
    swaps: logs.swaps.map((s) => ({ ...s, time: times.get(s.block)!, wallet: signers.get(s.tx.toLowerCase())! })),
  };
}

/**
 * The market once per block, as `pairsReader` does for the pairs: callers in one block share one read, and a refused
 * read is not kept.
 */
export function marketReader(chain: TokenLogsChain) {
  let last: { key: string; answer: Promise<MarketSnapshot> } | null = null;
  return async (factory: Address): Promise<MarketSnapshot> => {
    const block = await chain.headBlock();
    const key = `${factory.toLowerCase()}:${block}`;
    if (last?.key !== key) {
      const answer = readMarket(chain, factory, block);
      last = { key, answer };
      answer.catch(() => {
        if (last?.key === key) last = null;
      });
    }
    return last.answer;
  };
}

/** One token's holders at the snapshot's block, from every Transfer it emitted. */
export async function readHolders(chain: TokenLogsChain, token: Address, block: bigint): Promise<TokenPageData['holders']> {
  const [transfers, supply] = await Promise.all([chain.transferLogs(token, block), chain.totalSupply(token, block)]);
  return holdersFrom(transfers, supply);
}
