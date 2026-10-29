import { parseAbiItem, type Address, type PublicClient } from 'viem';
import type { TokenBasics, TokenPageData } from '@intafaced/contracts';
import { TOKENS_READ_TOO_LARGE } from '@intafaced/contracts';
import { classifyChainError } from '../chain/availability.js';
import { listPairs, PAIRS_READ_LIMIT, type PairsChain } from './pairs.js';
import { holdersFrom, MAX_LOGS, TokensReadError, type MarketSnapshot, type PoolRecord, type SwapLog, type SyncLog } from './tokens.js';

const poolCreated = parseAbiItem(
  'event PoolCreated(address indexed token0, address indexed token1, uint16 feeBps, address pool, uint256 index)',
);
const sync = parseAbiItem('event Sync(uint112 reserve0, uint112 reserve1)');
const swap = parseAbiItem(
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
);
const transfer = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const erc20Abi = [
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;
/** Burn addresses: what they hold is out of circulation but may still count in `totalSupply`. */
const BURN_ADDRESSES = ['0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dEaD'] as const;
/** How many block reads go to the node at once. */
const RPC_BATCH = 16;
/** Block times kept per process; past this the oldest are dropped and read again if asked. */
const BLOCK_TIMES_KEPT = 100_000;
/** A token's name or symbol is shown up to this many characters; a longer one is cut, never rejected. */
export const TOKEN_TEXT_LIMIT = 64;
/** The most decimals the wire takes; a token claiming more is left out of the pages with its pools. */
const MAX_DECIMALS = 36;

/** The log reads the token pages need, on top of the pool reads. Every one is a read; nothing here can sign. */
export interface TokenLogsChain extends PairsChain {
  poolCreatedLogs(factory: Address, toBlock: bigint): Promise<{ pool: Address; block: bigint; index: number }[]>;
  poolLogs(pools: Address[], toBlock: bigint): Promise<{ syncs: Omit<SyncLog, 'time'>[]; swaps: Omit<SwapLog, 'time'>[] }>;
  blockTimes(blocks: bigint[]): Promise<Map<bigint, number>>;
  transferLogs(token: Address, toBlock: bigint): Promise<{ from: Address; to: Address; value: bigint }[]>;
  totalSupply(token: Address, blockNumber: bigint): Promise<bigint>;
  balanceOf(token: Address, holder: Address, blockNumber: bigint): Promise<bigint>;
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
  const blockTime = new Map<bigint, number>();
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
            // The account the pool paid is the trader: a router or a bundler signs, but pays out to it.
            wallet: log.args.to!,
          })),
        };
      }),
    blockTimes: (blocks) =>
      read('blockTimes', async () => {
        // A block's time never changes, so each is read once per process, a few at a time.
        const missing = [...new Set(blocks)].filter((block) => !blockTime.has(block));
        for (let i = 0; i < missing.length; i += RPC_BATCH) {
          const batch = missing.slice(i, i + RPC_BATCH);
          const times = await Promise.all(
            batch.map((blockNumber) =>
              client()
                .getBlock({ blockNumber })
                .then((b) => Number(b.timestamp)),
            ),
          );
          batch.forEach((block, j) => blockTime.set(block, times[j]!));
        }
        const answer = new Map(blocks.map((block) => [block, blockTime.get(block)!]));
        for (const block of blockTime.keys()) {
          if (blockTime.size <= BLOCK_TIMES_KEPT) break;
          blockTime.delete(block);
        }
        return answer;
      }),
    transferLogs: (token, toBlock) =>
      read('transferLogs', async () => {
        const logs = await client().getLogs({ address: token, event: transfer, fromBlock: 0n, toBlock });
        tooLarge(logs.length);
        return logs.map((log) => ({ from: log.args.from!, to: log.args.to!, value: log.args.value! }));
      }),
    totalSupply: (token, blockNumber) =>
      read('totalSupply', () => client().readContract({ address: token, abi: erc20Abi, functionName: 'totalSupply', blockNumber })),
    balanceOf: (token, holder, blockNumber) =>
      read('balanceOf', () =>
        client().readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [holder], blockNumber }),
      ),
  };
}

/** Direction controls (U+200E, U+200F, U+202A–U+202E, U+2066–U+2069) would reorder the text around a name; they go. */
const BIDI_CONTROLS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;
const cut = (text: string) => [...text.replace(BIDI_CONTROLS, '')].slice(0, TOKEN_TEXT_LIMIT).join('');

/** Every pool, its history and its tokens at one block. */
export async function readMarket(chain: TokenLogsChain, factory: Address, block: bigint): Promise<MarketSnapshot> {
  const [pairs, created] = await Promise.all([listPairs(chain, factory, block), chain.poolCreatedLogs(factory, block)]);
  // The pairs read stops at PAIRS_READ_LIMIT pools; past that, a list would answer from part of the market, so refuse.
  if (created.length > PAIRS_READ_LIMIT)
    throw new TokensReadError(
      TOKENS_READ_TOO_LARGE,
      `${created.length} pools is more than this read takes (${PAIRS_READ_LIMIT}); the indexer must project them.`,
    );
  const createdBy = new Map(created.map((c) => [c.pool.toLowerCase(), c]));
  // A token's own contract says its name, symbol and decimals, so a hostile one is shaped here rather than refusing the
  // whole list: decimals past what the wire takes leave the token and its pools out; a long name or symbol is cut.
  const tokens = (pairs.tokens as TokenBasics[])
    .filter((t) => Number.isInteger(t.decimals) && t.decimals >= 0 && t.decimals <= MAX_DECIMALS)
    .map((t) => ({ ...t, name: cut(t.name), symbol: cut(t.symbol) }));
  const kept = new Set(tokens.map((t) => t.address.toLowerCase()));
  const listed = pairs.pools.filter((p) => kept.has(p.token0.toLowerCase()) && kept.has(p.token1.toLowerCase()));
  const listedPools = listed.map((p) => p.pool as Address);
  const logs = await chain.poolLogs(listedPools, block);
  const times = await chain.blockTimes([
    block,
    ...created.map((c) => c.block),
    ...logs.syncs.map((s) => s.block),
    ...logs.swaps.map((s) => s.block),
  ]);
  const pools: PoolRecord[] = listed.map((p) => {
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
    tokens,
    pools,
    syncs: logs.syncs.map((s) => ({ ...s, time: times.get(s.block)! })),
    swaps: logs.swaps.map((s) => ({ ...s, time: times.get(s.block)! })),
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

/**
 * One token's holders at a block, from every Transfer it emitted; burned is what the burn addresses hold on the chain
 * (a burn that already lowered `totalSupply` is not taken off again). The last few reads are kept, since a block's
 * holders never change.
 */
export function holdersReader(chain: TokenLogsChain) {
  const kept = new Map<string, Promise<TokenPageData['holders']>>();
  return (token: Address, block: bigint): Promise<TokenPageData['holders']> => {
    const key = `${token.toLowerCase()}:${block}`;
    let answer = kept.get(key);
    if (!answer) {
      answer = Promise.all([
        chain.transferLogs(token, block),
        chain.totalSupply(token, block),
        ...BURN_ADDRESSES.map((holder) => chain.balanceOf(token, holder, block)),
      ]).then(([transfers, supply, ...burned]) =>
        holdersFrom(
          transfers,
          supply,
          burned.reduce((a, b) => a + b, 0n),
        ),
      );
      kept.set(key, answer);
      answer.catch(() => kept.delete(key));
      if (kept.size > HOLDERS_KEPT) kept.delete(kept.keys().next().value!);
    }
    return answer;
  };
}
const HOLDERS_KEPT = 32;
