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
