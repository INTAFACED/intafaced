import type { ChainTxLog } from '../chain/source.js';
import type { ExplorerTxCursor } from './tx.js';

/**
 * D-explorer-03. An address's transactions and the token search.
 *
 * A transaction belongs to an address when the address sent it, received it, or
 * is a party to one of its ERC-20 Transfer logs. Transfers are read out of the
 * stored logs, never from a second node call, so a transfer can only exist where
 * its log does.
 */

/** keccak256("Transfer(address,address,uint256)"). */
export const ERC20_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

export interface TransferFact {
  readonly logIndex: number;
  readonly token: string;
  readonly from: string;
  readonly to: string;
  /** Raw base units. */
  readonly amount: bigint;
}

const TOPIC_ADDRESS = /^0x0{24}([0-9a-f]{40})$/;

/**
 * The ERC-20 Transfer a log records, or null. ERC-721 shares the topic but puts the id in a fourth topic and has no
 * data, so only the three-topic, one-word shape counts.
 */
export function transferOf(log: ChainTxLog): TransferFact | null {
  const topics = log.topics.map((topic) => topic.toLowerCase());
  if (topics.length !== 3 || topics[0] !== ERC20_TRANSFER_TOPIC) return null;
  const from = TOPIC_ADDRESS.exec(topics[1] ?? '');
  const to = TOPIC_ADDRESS.exec(topics[2] ?? '');
  if (!from || !to || !/^0x[0-9a-fA-F]{64}$/.test(log.data)) return null;
  return {
    logIndex: log.logIndex,
    token: log.address.toLowerCase(),
    from: `0x${from[1]}`,
    to: `0x${to[1]}`,
    amount: BigInt(log.data),
  };
}

/** What a token contract said about itself. Null is "the contract did not answer", never a guess. */
export interface TokenFact {
  readonly address: string;
  readonly symbol: string | null;
  readonly name: string | null;
  readonly decimals: number | null;
}

export interface AddressTransferFact {
  /** Always the emitting contract; its symbol, name and decimals are null until (or unless) it answered. */
  readonly token: TokenFact;
  readonly from: string;
  readonly to: string;
  readonly amount: bigint;
}

/** One row of `indexer.explorer.address.txs`, newest first. */
export interface AddressTxFact {
  readonly hash: string;
  readonly blockHeight: number;
  readonly blockHash: string;
  readonly index: number;
  readonly timestamp: number;
  readonly from: string;
  readonly to: string | null;
  readonly status: 'success' | 'failed';
  readonly revertReason: string | null;
  readonly transfers: readonly AddressTransferFact[];
}

/** WHERE the address is a party AND (height, index, hash) < cursor, newest first, LIMIT limit + 1. Canonical blocks only. */
export type ExplorerAddressTxs = (q: { address: string; cursor?: ExplorerTxCursor; limit: number }) => Promise<AddressTxFact[]>;

/** Every token whose symbol is this one, ignoring case, one row per contract. LIMIT limit + 1. */
export type ExplorerTokensBySymbol = (q: { symbol: string; limit: number }) => Promise<TokenFact[]>;

export interface ExplorerAddressSource {
  readonly txs: ExplorerAddressTxs;
  readonly tokensBySymbol: ExplorerTokensBySymbol;
}

export type TransferDirection = 'in' | 'out' | 'self';

/** How a transfer moves value for the address the page is about. */
export function directionOf(transfer: { from: string; to: string }, address: string): TransferDirection {
  const self = address.toLowerCase();
  const from = transfer.from.toLowerCase() === self;
  const to = transfer.to.toLowerCase() === self;
  if (from && to) return 'self';
  return from ? 'out' : 'in';
}

/** One page and the cursor for the next, or null when this page is the last. */
export async function listAddressTxPage(
  list: ExplorerAddressTxs,
  q: { address: string; cursor?: ExplorerTxCursor; limit: number },
): Promise<{ rows: AddressTxFact[]; nextCursor: ExplorerTxCursor | null }> {
  const fetched = await list(q);
  const rows = fetched.slice(0, q.limit);
  const last = rows[rows.length - 1];
  const nextCursor = fetched.length > q.limit && last ? { height: last.blockHeight, index: last.index, hash: last.hash } : null;
  return { rows, nextCursor };
}

/** One value move inside a transaction: a call with value, a contract created with value, or a self-destruct. */
export interface InternalCallFact {
  /** The call's place in the transaction's trace tree ("0.2"). */
  readonly path: string;
  readonly kind: 'call' | 'create' | 'selfdestruct';
  readonly from: string;
  readonly to: string;
  readonly valueWei: bigint;
}

/** One row of `indexer.explorer.address.internal`: a transaction and the internal moves in it to or from the address. */
export interface AddressInternalFact {
  readonly hash: string;
  readonly blockHeight: number;
  readonly index: number;
  readonly timestamp: number;
  readonly calls: readonly InternalCallFact[];
}

/** Indexed blocks with transactions whose trace was not read: their count, height range and the codes the node gave. */
export interface TraceGapsFact {
  readonly blocks: number;
  readonly fromHeight: number | null;
  readonly toHeight: number | null;
  /** The node's codes; `indexer.trace_not_recorded` for blocks indexed before traces were read. */
  readonly reasons: readonly string[];
}

/** Blocks indexed before this service read traces carry no trace row: their trace was never asked for. */
export const TRACE_NOT_RECORDED = 'indexer.trace_not_recorded';

/** A canonical block's height and time, for "balance at". */
export interface BlockMarkFact {
  readonly height: number;
  readonly timestamp: number;
}

/** WHERE the address is a party to an internal move AND (height, index, hash) < cursor, newest first, LIMIT limit + 1. */
export type ExplorerAddressInternal = (q: { address: string; cursor?: ExplorerTxCursor; limit: number }) => Promise<AddressInternalFact[]>;

export interface ExplorerAddressReads {
  readonly internal: ExplorerAddressInternal;
  readonly traceGaps: () => Promise<TraceGapsFact>;
  /** Tokens the address sent or received in canonical blocks, by contract address, LIMIT limit + 1. */
  readonly tokens: (q: { address: string; limit: number }) => Promise<TokenFact[]>;
  /** The last canonical block whose time is before `time`. */
  readonly blockBefore: (time: Date) => Promise<BlockMarkFact | null>;
  readonly blockAt: (height: number) => Promise<BlockMarkFact | null>;
  readonly earliestHeight: () => Promise<number | null>;
}

/** Live reads of an address at a stored height: the node's own answer, pinned to a block the indexer holds. */
export interface AddressStateSource {
  readonly account: (address: string, height: number) => Promise<{ balanceWei: bigint; isContract: boolean }>;
  readonly balance: (address: string, height: number) => Promise<bigint>;
  /** Each token's `balanceOf`, in order; null where the contract did not answer as a token. */
  readonly tokenBalances: (tokens: readonly string[], address: string, height: number) => Promise<Array<bigint | null>>;
}

export interface AddressPageSource {
  readonly reads: ExplorerAddressReads;
  readonly state: AddressStateSource;
}

/** One page of internal moves and the cursor for the next, or null when this page is the last. */
export async function listAddressInternalPage(
  list: ExplorerAddressInternal,
  q: { address: string; cursor?: ExplorerTxCursor; limit: number },
): Promise<{ rows: AddressInternalFact[]; nextCursor: ExplorerTxCursor | null }> {
  const fetched = await list(q);
  const rows = fetched.slice(0, q.limit);
  const last = rows[rows.length - 1];
  const nextCursor = fetched.length > q.limit && last ? { height: last.blockHeight, index: last.index, hash: last.hash } : null;
  return { rows, nextCursor };
}

/** The end of a UTC calendar day ("2026-01-01" → 2026-01-02T00:00:00Z), or null for a date that does not exist. */
export function endOfUtcDay(date: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const start = new Date(Date.UTC(year, month - 1, day));
  if (start.getUTCFullYear() !== year || start.getUTCMonth() !== month - 1 || start.getUTCDate() !== day) return null;
  return new Date(start.getTime() + 86_400_000);
}
