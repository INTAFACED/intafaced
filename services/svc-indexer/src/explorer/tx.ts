import { ChainDataError, type ChainTx, type ChainTxLog } from '../chain/source.js';

/**
 * D-explorer-02. How long a hash we already saw in the mempool may stay
 * unseen before it is `dropped`. Blank is unpublished — never a guessed window.
 */
export const INDEXER_TX_DROP_WINDOW_UNSET = 'indexer.tx_drop_window_unset' as const;

/** A clock can apply this. Larger than 100 years is not a usable window. */
const DROP_WINDOW_MAX_SECONDS = 3_153_600_000;

export type DropWindow = { ok: true; seconds: number } | { ok: false; code: typeof INDEXER_TX_DROP_WINDOW_UNSET };

export function parseTxDropWindow(raw: string | undefined): DropWindow {
  const t = raw?.trim() ?? '';
  if (!/^\d+$/.test(t)) return { ok: false, code: INDEXER_TX_DROP_WINDOW_UNSET };
  const n = Number(t);
  if (!Number.isSafeInteger(n) || n < 1 || n > DROP_WINDOW_MAX_SECONDS) {
    return { ok: false, code: INDEXER_TX_DROP_WINDOW_UNSET };
  }
  return { ok: true, seconds: n };
}

/** A hash the node still has, either in the mempool or already mined. */
export type LiveTx =
  | {
      kind: 'pending';
      from: string;
      to: string | null;
      valueWei: bigint;
      nonce: number;
      gasLimit: bigint;
      gasPriceWei: bigint | null;
      input: string;
    }
  | { kind: 'mined'; tx: ChainTx };

export interface IndexedExplorerTx {
  readonly tx: ChainTx;
  readonly blockStatus: 'canonical' | 'orphaned';
  /** Set when this hash sits on an orphan and a canonical same-sender nonce replaced it. */
  readonly replacementHash: string | null;
  readonly orphaned: { reason: string } | null;
}

export interface TxBody {
  index: number | null;
  from: string;
  to: string | null;
  value: string;
  nonce: number;
  gasLimit: string;
  gasPrice: string | null;
  input: string;
}

export interface TxReceipt {
  status: 'success' | 'failed';
  gasConsumed: string | null;
  revertReason: string | null;
  createdContract: string | null;
}

export interface TxLogWire {
  logIndex: number;
  address: string;
  topics: string[];
  data: string;
}

export interface TxAnswer {
  status: 'success' | 'failed' | 'pending' | 'dropped' | 'replaced';
  replacingHash: string | null;
  transaction: TxBody | null;
  receipt: TxReceipt | null;
  logs: TxLogWire[];
  orphaned: { reason: string } | null;
  /** True only when this answer is a mempool hit that should be remembered. */
  recordPending: boolean;
}

export type TxDecision =
  { kind: 'refuse'; code: typeof INDEXER_TX_DROP_WINDOW_UNSET } | { kind: 'missing' } | { kind: 'answer'; answer: TxAnswer };

/** What `indexer.explorer.tx.get` reads. The store and the node stay behind this. */
export interface ExplorerTxSource {
  readonly dropWindow: DropWindow;
  indexed(hash: string): Promise<IndexedExplorerTx | null>;
  pendingSince(hash: string): Promise<Date | null>;
  notePending(hash: string, at: Date): Promise<void>;
  lookup(hash: string): Promise<LiveTx | null>;
}

function wei(value: bigint, what: string): string {
  if (typeof value !== 'bigint' || value < 0n) {
    throw new ChainDataError(`${what} must be a non-negative wei bigint`, 'indexer.bad_amount');
  }
  return value.toString();
}

function bodyOf(tx: ChainTx): TxBody {
  return {
    index: tx.index,
    from: tx.from,
    to: tx.to,
    value: wei(tx.valueWei, 'tx value'),
    nonce: tx.nonce,
    gasLimit: wei(tx.gasLimit, 'tx gas limit'),
    gasPrice: tx.gasPriceWei === null ? null : wei(tx.gasPriceWei, 'tx gas price'),
    input: tx.input,
  };
}

function receiptOf(tx: ChainTx): TxReceipt {
  return {
    status: tx.status,
    gasConsumed: tx.gasConsumed === null ? null : wei(tx.gasConsumed, 'tx gas consumed'),
    revertReason: tx.revertReason,
    createdContract: tx.createdContract,
  };
}

function logsOf(logs: readonly ChainTxLog[]): TxLogWire[] {
  return logs.map((log) => ({
    logIndex: log.logIndex,
    address: log.address,
    topics: [...log.topics],
    data: log.data,
  }));
}

function mined(tx: ChainTx, orphaned: { reason: string } | null, status: TxAnswer['status'], replacingHash: string | null): TxAnswer {
  return {
    status,
    replacingHash,
    transaction: bodyOf(tx),
    receipt: receiptOf(tx),
    logs: logsOf(tx.logs),
    orphaned,
    recordPending: false,
  };
}

/**
 * One decision for `indexer.explorer.tx.get`.
 * A hash the node has never had is missing (`protocol.not_found` at the door).
 * Dropped is only a hash we already saw pending, after the owner window.
 * A blank window refuses — it does not become dropped or pending.
 */
export function classifyExplorerTx(input: {
  indexed: IndexedExplorerTx | null;
  live: LiveTx | null;
  pendingSince: Date | null;
  now: Date;
  dropWindow: DropWindow;
}): TxDecision {
  const indexed = input.indexed;
  if (indexed && indexed.blockStatus === 'orphaned' && indexed.replacementHash) {
    return { kind: 'answer', answer: mined(indexed.tx, indexed.orphaned, 'replaced', indexed.replacementHash) };
  }
  if (indexed) {
    return { kind: 'answer', answer: mined(indexed.tx, indexed.orphaned, indexed.tx.status, null) };
  }
  const live = input.live;
  if (live?.kind === 'mined') {
    return { kind: 'answer', answer: mined(live.tx, null, live.tx.status, null) };
  }
  if (live?.kind === 'pending') {
    return {
      kind: 'answer',
      answer: {
        status: 'pending',
        replacingHash: null,
        transaction: {
          index: null,
          from: live.from,
          to: live.to,
          value: wei(live.valueWei, 'tx value'),
          nonce: live.nonce,
          gasLimit: wei(live.gasLimit, 'tx gas limit'),
          gasPrice: live.gasPriceWei === null ? null : wei(live.gasPriceWei, 'tx gas price'),
          input: live.input,
        },
        receipt: null,
        logs: [],
        orphaned: null,
        recordPending: true,
      },
    };
  }
  if (input.pendingSince) {
    if (!input.dropWindow.ok) return { kind: 'refuse', code: input.dropWindow.code };
    const elapsed = input.now.getTime() - input.pendingSince.getTime();
    if (elapsed >= input.dropWindow.seconds * 1000) {
      return {
        kind: 'answer',
        answer: {
          status: 'dropped',
          replacingHash: null,
          transaction: null,
          receipt: null,
          logs: [],
          orphaned: null,
          recordPending: false,
        },
      };
    }
    return {
      kind: 'answer',
      answer: {
        status: 'pending',
        replacingHash: null,
        transaction: null,
        receipt: null,
        logs: [],
        orphaned: null,
        recordPending: false,
      },
    };
  }
  return { kind: 'missing' };
}

/** One row of `indexer.explorer.txs.list`: newest first, orphans kept with their reason. */
export interface ExplorerTxListFact {
  readonly hash: string;
  readonly blockHeight: number;
  readonly blockHash: string;
  readonly index: number;
  readonly from: string;
  readonly to: string | null;
  readonly valueWei: bigint;
  readonly status: 'success' | 'failed';
  readonly timestamp: number;
  readonly orphaned: { reason: string } | null;
}

/** Keyset position: the last row a page returned. */
export interface ExplorerTxCursor {
  readonly height: number;
  readonly index: number;
  readonly hash: string;
}

/** WHERE (height, index, hash) < cursor ORDER BY height DESC, index DESC, hash DESC LIMIT limit + 1. */
export type ExplorerTxList = (q: { cursor?: ExplorerTxCursor; blockHash?: string; limit: number }) => Promise<ExplorerTxListFact[]>;

/** One page and the cursor for the next, or null when this page is the last. */
export async function listTxPage(
  list: ExplorerTxList,
  q: { cursor?: ExplorerTxCursor; blockHash?: string; limit: number },
): Promise<{ rows: ExplorerTxListFact[]; nextCursor: ExplorerTxCursor | null }> {
  const fetched = await list(q);
  const rows = fetched.slice(0, q.limit);
  const last = rows[rows.length - 1];
  const nextCursor = fetched.length > q.limit && last ? { height: last.blockHeight, index: last.index, hash: last.hash } : null;
  return { rows, nextCursor };
}
