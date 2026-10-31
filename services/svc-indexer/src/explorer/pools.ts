import type { ChainTxLog } from '../chain/source.js';
import type { TokenFact } from './address.js';

/**
 * D-explorer-05. Pools, their swaps and their reserves, read out of the stored logs.
 *
 * Any contract can emit these events, so a decoded row proves nothing on its own: a pool is listed only when the owner's
 * factory created it (`INDEXER_POOL_FACTORY_ADDRESS`), and a swap or reserve counts only for such a pool. Amounts stay
 * raw base units; a price is the pool's reserve ratio, worked out in Postgres numeric with the tokens' own decimals, never
 * a float.
 */

/** keccak256("PoolCreated(address,address,uint16,address,uint256)"), `PoolFactory.sol:17`. */
export const POOL_CREATED_TOPIC = '0xa7fe820b1195583db141064eed24e76a61598a82b80a95d2915d14bb12758172';
/** keccak256("Swap(address,uint256,uint256,uint256,uint256,address)"), `ConstantProductPool.sol:39`. */
export const POOL_SWAP_TOPIC = '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822';
/** keccak256("Sync(uint112,uint112)"), `ConstantProductPool.sol:47`. */
export const POOL_SYNC_TOPIC = '0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1';

export const INDEXER_POOL_FACTORY_UNSET = 'indexer.pool_factory_unset' as const;
export const INDEXER_NOT_A_POOL = 'indexer.not_a_pool' as const;

const TOPIC_ADDRESS = /^0x0{24}([0-9a-f]{40})$/;
const WORD_ADDRESS = /^0{24}([0-9a-f]{40})$/;

function words(data: string, count: number): string[] | null {
  if (!new RegExp(`^0x[0-9a-fA-F]{${count * 64}}$`).test(data)) return null;
  const hex = data.slice(2).toLowerCase();
  return Array.from({ length: count }, (_, i) => hex.slice(i * 64, (i + 1) * 64));
}

export interface PoolCreatedFact {
  readonly logIndex: number;
  readonly factory: string;
  readonly pool: string;
  readonly token0: string;
  readonly token1: string;
  readonly feeBps: number;
}

/** The pool a factory log announces, or null for any other log (or one of another shape). */
export function poolCreatedOf(log: ChainTxLog): PoolCreatedFact | null {
  const topics = log.topics.map((topic) => topic.toLowerCase());
  if (topics.length !== 3 || topics[0] !== POOL_CREATED_TOPIC) return null;
  const token0 = TOPIC_ADDRESS.exec(topics[1] ?? '');
  const token1 = TOPIC_ADDRESS.exec(topics[2] ?? '');
  const data = words(log.data, 3);
  if (!token0 || !token1 || !data) return null;
  const fee = BigInt(`0x${data[0]}`);
  const pool = WORD_ADDRESS.exec(data[1]!);
  if (fee > 65535n || !pool) return null;
  return {
    logIndex: log.logIndex,
    factory: log.address.toLowerCase(),
    pool: `0x${pool[1]}`,
    token0: `0x${token0[1]}`,
    token1: `0x${token1[1]}`,
    feeBps: Number(fee),
  };
}

export interface SwapLogFact {
  readonly logIndex: number;
  readonly pool: string;
  readonly sender: string;
  readonly recipient: string;
  readonly amount0In: bigint;
  readonly amount1In: bigint;
  readonly amount0Out: bigint;
  readonly amount1Out: bigint;
}

/** The swap a pool log records, or null. */
export function swapOf(log: ChainTxLog): SwapLogFact | null {
  const topics = log.topics.map((topic) => topic.toLowerCase());
  if (topics.length !== 3 || topics[0] !== POOL_SWAP_TOPIC) return null;
  const sender = TOPIC_ADDRESS.exec(topics[1] ?? '');
  const recipient = TOPIC_ADDRESS.exec(topics[2] ?? '');
  const data = words(log.data, 4);
  if (!sender || !recipient || !data) return null;
  const [amount0In, amount1In, amount0Out, amount1Out] = data.map((word) => BigInt(`0x${word}`)) as [bigint, bigint, bigint, bigint];
  return {
    logIndex: log.logIndex,
    pool: log.address.toLowerCase(),
    sender: `0x${sender[1]}`,
    recipient: `0x${recipient[1]}`,
    amount0In,
    amount1In,
    amount0Out,
    amount1Out,
  };
}

export interface SyncLogFact {
  readonly logIndex: number;
  readonly pool: string;
  readonly reserve0: bigint;
  readonly reserve1: bigint;
}

/** The reserves a pool log records after its update, or null. */
export function syncOf(log: ChainTxLog): SyncLogFact | null {
  const topics = log.topics.map((topic) => topic.toLowerCase());
  if (topics.length !== 1 || topics[0] !== POOL_SYNC_TOPIC) return null;
  const data = words(log.data, 2);
  if (!data) return null;
  return { logIndex: log.logIndex, pool: log.address.toLowerCase(), reserve0: BigInt(`0x${data[0]}`), reserve1: BigInt(`0x${data[1]}`) };
}

/**
 * Which way a swap went, from token0's side, read from what the pool paid out: only token0 left the pool for token1
 * (a buy of token0), or only token1 left it for token0 (a sell). The pool counts every token it holds above its reserves
 * as input, so a transfer made straight to the pool before a swap shows as that swap's input on the other side too; it
 * does not change what the swap paid out, so it does not change the side. A swap that paid out both tokens, or neither,
 * or paid out a token for that same token alone, is neither, and says so rather than picking one.
 */
export function swapSide(swap: { amount0In: bigint; amount1In: bigint; amount0Out: bigint; amount1Out: bigint }): 'buy' | 'sell' | 'both' {
  if (swap.amount0Out > 0n && swap.amount1Out === 0n && swap.amount1In > 0n) return 'buy';
  if (swap.amount1Out > 0n && swap.amount0Out === 0n && swap.amount0In > 0n) return 'sell';
  return 'both';
}

/** Keyset position of a pool row: the PoolCreated log's block height, transaction index and log index. */
export interface PoolCursor {
  readonly height: number;
  readonly index: number;
  readonly logIndex: number;
}

export interface ReservesFact {
  readonly reserve0: bigint;
  readonly reserve1: bigint;
  /** The block whose Sync log set these reserves. */
  readonly height: number;
}

export interface PoolFact {
  readonly pool: string;
  readonly factory: string;
  readonly token0: TokenFact;
  readonly token1: TokenFact;
  readonly feeBps: number;
  readonly createdHeight: number;
  readonly createdTx: string;
  readonly cursor: PoolCursor;
  /** Null until the pool's first Sync log in a canonical block. */
  readonly reserves: ReservesFact | null;
}

export interface PoolSwapFact {
  readonly hash: string;
  readonly blockHeight: number;
  readonly index: number;
  readonly logIndex: number;
  readonly timestamp: number;
  readonly sender: string;
  readonly recipient: string;
  readonly amount0In: bigint;
  readonly amount1In: bigint;
  readonly amount0Out: bigint;
  readonly amount1Out: bigint;
}

/** Keyset position of a swap row. */
export interface SwapCursor {
  readonly height: number;
  readonly index: number;
  readonly logIndex: number;
}

/**
 * One price candle: token0's price in token1, from the pool's reserves after each Sync inside it, in order. Volume is the
 * token1 side of the swaps inside it (what went in plus what came out), in raw base units.
 */
export interface CandleFact {
  readonly start: number;
  readonly open: string;
  readonly high: string;
  readonly low: string;
  readonly close: string;
  readonly volume1: bigint;
  readonly swaps: number;
}

export interface PoolVolumeFact {
  /** The token1 side of every swap since the window opened, raw base units. */
  readonly volume1: bigint;
  readonly swaps: number;
}

/** Candle widths the page can ask for. Structural (chart resolutions), not an owner magnitude. */
export const CANDLE_SECONDS = { '5m': 300, '1h': 3600 } as const;
export type CandleInterval = keyof typeof CANDLE_SECONDS;

/** The volume and candles cover one day, the window the page names. */
export const POOL_WINDOW_SECONDS = 86_400;

export interface ExplorerPoolReads {
  /** Pools the factory created, newest first, keyset-paged. LIMIT limit + 1. Canonical blocks only. */
  readonly list: (q: { factory: string; cursor?: PoolCursor; limit: number }) => Promise<PoolFact[]>;
  /** The pool the factory created at this address, or null. */
  readonly get: (q: { factory: string; pool: string }) => Promise<PoolFact | null>;
  /** The pool's swaps, newest first, keyset-paged. LIMIT limit + 1. */
  readonly swaps: (q: { pool: string; cursor?: SwapCursor; limit: number }) => Promise<PoolSwapFact[]>;
  /** Swaps in canonical blocks timed at or after `since`. */
  readonly volume: (q: { pool: string; since: Date }) => Promise<PoolVolumeFact>;
  /**
   * Candles of `seconds` width from `since`, oldest first. `scale` is 10^(decimals0 − decimals1) as a decimal string,
   * so a raw-unit ratio becomes token0's price in whole token1.
   */
  readonly candles: (q: { pool: string; since: Date; seconds: number; scale: string }) => Promise<CandleFact[]>;
}

/** 10^(decimals0 − decimals1) as a plain decimal string, or null when either token did not say its decimals. */
export function priceScale(decimals0: number | null, decimals1: number | null): string | null {
  if (decimals0 === null || decimals1 === null) return null;
  const exponent = decimals0 - decimals1;
  if (exponent >= 0) return `1${'0'.repeat(exponent)}`;
  return `0.${'0'.repeat(-exponent - 1)}1`;
}

/** The configured factory, lower-cased; null when blank. A value that is not an address refuses to start. */
export function parsePoolFactory(raw: string | undefined): string | null {
  const value = raw?.trim() ?? '';
  if (value === '') return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(
      'INDEXER_POOL_FACTORY_ADDRESS must be a 20-byte hex address (blank lists no pools and refuses indexer.pool_factory_unset)',
    );
  }
  return value.toLowerCase();
}
