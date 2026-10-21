import { formatAmount } from '@intafaced/ledger-client';
import type { FinalizedInbound } from './evm-chain.js';
import { signPayload } from './webhook-signature.js';

/**
 * Chain watcher — the fourth owner-obtainable from the README, as code.
 *
 * Polls the live chain port, and when an inbound transfer to a watched
 * acceptance address reaches `minConfirmations`, POSTs a signed webhook to
 * svc-pay's own `/webhooks/crypto-native` endpoint. The adapter's
 * `verifyWebhook` is what authenticates it; the payment core's
 * `handleWebhook` is what books it. Nothing here moves ledger money.
 *
 * The cursor is last-seen (block, tx hash, log index) — not a deposit. A crash
 * that re-drains the same finalization must not POST it again. Webhook
 * `rail_event_id` still dedupes at the book; this store is the watcher-side
 * half so replay does not even attempt a second credit.
 */

/** Production / tests share this id so a restarted process resumes the same row. */
export const CRYPTO_NATIVE_WATCHER_ID = 'crypto-native';

/**
 * Inclusive last-seen position on the inbound log.
 *
 * `blockNumber` is a decimal string (never a JSON number — block identity is
 * not money, but `number` still loses integers past 2^53). `logIndex` is the
 * EVM log index, or the transaction index for native value transfers.
 */
export interface ChainWatcherCursor {
  readonly blockNumber: string;
  readonly txHash: string;
  readonly logIndex: number;
}

export interface ChainWatcherCursorStore {
  load(watcherId: string): Promise<ChainWatcherCursor | null>;
  /** Monotonic: a cursor at or before the stored one is a no-op. */
  save(watcherId: string, cursor: ChainWatcherCursor): Promise<void>;
}

export function parseWatcherBlockNumber(raw: string): bigint {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`chain watcher cursor blockNumber must be a decimal string (got ${JSON.stringify(raw)})`);
  }
  return BigInt(raw);
}

export function compareChainWatcherCursor(a: ChainWatcherCursor, b: ChainWatcherCursor): number {
  const ab = parseWatcherBlockNumber(a.blockNumber);
  const bb = parseWatcherBlockNumber(b.blockNumber);
  if (ab < bb) return -1;
  if (ab > bb) return 1;
  if (a.logIndex !== b.logIndex) return a.logIndex < b.logIndex ? -1 : 1;
  if (a.txHash === b.txHash) return 0;
  return a.txHash < b.txHash ? -1 : 1;
}

export function cursorOf(item: FinalizedInbound): ChainWatcherCursor {
  return {
    blockNumber: item.blockNumber.toString(),
    txHash: item.transfer.txHash,
    logIndex: item.logIndex,
  };
}

/** In-memory cursor — tests and single-process local runners. Not crash-safe. */
export class MemoryChainWatcherCursorStore implements ChainWatcherCursorStore {
  private readonly map = new Map<string, ChainWatcherCursor>();

  async load(watcherId: string): Promise<ChainWatcherCursor | null> {
    return this.map.get(watcherId) ?? null;
  }

  async save(watcherId: string, cursor: ChainWatcherCursor): Promise<void> {
    assertCursor(cursor);
    const existing = this.map.get(watcherId);
    if (existing && compareChainWatcherCursor(cursor, existing) <= 0) return;
    this.map.set(watcherId, cursor);
  }
}

/**
 * Minimal postgres.js surface used by the durable cursor (keeps tests mockable).
 * Call signature is intentionally loose so real `postgres.Sql` is assignable.
 */
export type WatcherSql = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (strings: TemplateStringsArray, ...values: any[]): Promise<readonly any[]>;
};

type CursorRow = {
  last_block: string;
  last_tx_hash: string;
  last_log_index: number;
};

/**
 * Postgres-backed cursor for crash-safe inbound watching.
 *
 * A restarted replica loads the last successfully delivered position and
 * skips anything at or before it. Save is monotonic so two replicas cannot
 * rewind each other onto an already-booked deposit.
 */
export class PostgresChainWatcherCursorStore implements ChainWatcherCursorStore {
  constructor(private readonly sql: WatcherSql) {}

  async load(watcherId: string): Promise<ChainWatcherCursor | null> {
    const rows = (await this.sql`
      SELECT last_block, last_tx_hash, last_log_index
        FROM pay.chain_watcher_cursors
       WHERE watcher_id = ${watcherId}
    `) as ReadonlyArray<CursorRow>;
    const row = rows[0];
    if (!row) return null;
    return {
      blockNumber: row.last_block,
      txHash: row.last_tx_hash,
      logIndex: row.last_log_index,
    };
  }

  async save(watcherId: string, cursor: ChainWatcherCursor): Promise<void> {
    assertCursor(cursor);
    await this.sql`
      INSERT INTO pay.chain_watcher_cursors (watcher_id, last_block, last_tx_hash, last_log_index)
      VALUES (${watcherId}, ${cursor.blockNumber}, ${cursor.txHash}, ${cursor.logIndex})
      ON CONFLICT (watcher_id) DO UPDATE SET
        last_block = EXCLUDED.last_block,
        last_tx_hash = EXCLUDED.last_tx_hash,
        last_log_index = EXCLUDED.last_log_index,
        updated_at = now()
      WHERE (EXCLUDED.last_block::numeric > pay.chain_watcher_cursors.last_block::numeric)
         OR (
           EXCLUDED.last_block = pay.chain_watcher_cursors.last_block
           AND EXCLUDED.last_log_index > pay.chain_watcher_cursors.last_log_index
         )
         OR (
           EXCLUDED.last_block = pay.chain_watcher_cursors.last_block
           AND EXCLUDED.last_log_index = pay.chain_watcher_cursors.last_log_index
           AND EXCLUDED.last_tx_hash > pay.chain_watcher_cursors.last_tx_hash
         )
    `;
  }
}

function assertCursor(cursor: ChainWatcherCursor): void {
  parseWatcherBlockNumber(cursor.blockNumber);
  if (!Number.isInteger(cursor.logIndex) || cursor.logIndex < 0) {
    throw new Error(`chain watcher cursor logIndex must be a non-negative integer (got ${cursor.logIndex})`);
  }
  if (!cursor.txHash) {
    throw new Error('chain watcher cursor txHash must be non-empty');
  }
}

/**
 * An inbound the watcher gave up delivering after the owner-published number of attempts. The record is the
 * hand-off to a person: the chain saw the transfer, the book never accepted the webhook. Not money.
 */
export interface ChainWatcherDeadLetter {
  readonly deliveryId: string;
  readonly watcherId: string;
  readonly address: string;
  readonly txHash: string;
  readonly logIndex: number;
  readonly blockNumber: string;
  readonly attempts: number;
  /** HTTP status of the last attempt, or null when it threw before a response. */
  readonly lastStatus: number | null;
  readonly lastError: string | null;
}

export interface ChainWatcherDeadLetterStore {
  /** Idempotent on `deliveryId`. */
  record(entry: ChainWatcherDeadLetter): Promise<void>;
  list(): Promise<ChainWatcherDeadLetter[]>;
}

export class MemoryChainWatcherDeadLetterStore implements ChainWatcherDeadLetterStore {
  private readonly rows = new Map<string, ChainWatcherDeadLetter>();

  async record(entry: ChainWatcherDeadLetter): Promise<void> {
    if (!this.rows.has(entry.deliveryId)) this.rows.set(entry.deliveryId, entry);
  }

  async list(): Promise<ChainWatcherDeadLetter[]> {
    return [...this.rows.values()];
  }
}

type DeadLetterRow = {
  delivery_id: string;
  watcher_id: string;
  address: string;
  tx_hash: string;
  log_index: number;
  block_number: string;
  attempts: number;
  last_status: number | null;
  last_error: string | null;
};

export class PostgresChainWatcherDeadLetterStore implements ChainWatcherDeadLetterStore {
  constructor(private readonly sql: WatcherSql) {}

  async record(entry: ChainWatcherDeadLetter): Promise<void> {
    await this.sql`
      INSERT INTO pay.chain_watcher_dead_letters
        (delivery_id, watcher_id, address, tx_hash, log_index, block_number, attempts, last_status, last_error)
      VALUES (${entry.deliveryId}, ${entry.watcherId}, ${entry.address}, ${entry.txHash}, ${entry.logIndex},
              ${entry.blockNumber}, ${entry.attempts}, ${entry.lastStatus}, ${entry.lastError})
      ON CONFLICT (delivery_id) DO NOTHING
    `;
  }

  async list(): Promise<ChainWatcherDeadLetter[]> {
    const rows = (await this.sql`
      SELECT delivery_id, watcher_id, address, tx_hash, log_index, block_number, attempts, last_status, last_error
        FROM pay.chain_watcher_dead_letters
       ORDER BY dead_lettered_at, delivery_id
    `) as ReadonlyArray<DeadLetterRow>;
    return rows.map((r) => ({
      deliveryId: r.delivery_id,
      watcherId: r.watcher_id,
      address: r.address,
      txHash: r.tx_hash,
      logIndex: r.log_index,
      blockNumber: r.block_number,
      attempts: r.attempts,
      lastStatus: r.last_status,
      lastError: r.last_error,
    }));
  }
}

/**
 * The webhook event id for one inbound. The log index is part of it: two logs of one transaction to one address
 * (a batched transfer) are two deposits, and one id would have the book drop the second as a duplicate.
 */
export function chainDeliveryId(item: FinalizedInbound): string {
  return `chain:${item.transfer.txHash}:${item.address}:${item.logIndex}`;
}

/** The slice of EvmLiveChain the watcher actually calls. */
export interface ChainWatcherChain {
  refresh(): Promise<void>;
  drainFinalized(): readonly FinalizedInbound[];
  markFinalizedEmitted(address: string): void;
  /** Every re-read inbound with its depth, for the deposit record's progress. Optional: a chain without it has no progress. */
  observedInbound?(): readonly FinalizedInbound[];
  /** Inbounds that were seen and then no longer appear in a receipt (dropped, replaced or reverted). Optional. */
  droppedInbound?(): readonly FinalizedInbound[];
}

export interface ChainWatcherOptions {
  readonly chain: ChainWatcherChain;
  readonly secret: string;
  /** Where to POST — typically `http://127.0.0.1:${HTTP_PORT}/webhooks/crypto-native`. */
  readonly webhookUrl: string;
  readonly pollIntervalMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => Date;
  readonly log?: (msg: string, extra?: Record<string, unknown>) => void;
  /** Called after `chain.refresh()` returns. The crypto rail uses this to refresh lastContact. */
  readonly onAlive?: () => void;
  /** Crash-safe last-seen position. Defaults to in-memory (not multi-replica). */
  readonly cursorStore?: ChainWatcherCursorStore;
  /** Store key. Production uses `crypto-native`. */
  readonly watcherId?: string;
  /**
   * Owner-published: how many failed attempts at one inbound before it is dead-lettered. Unset means never
   * dead-letter (no invented limit): the inbound is retried every tick, without blocking other addresses.
   */
  readonly maxDeliveryAttempts?: number;
  /** Where dead letters are recorded. Required for `maxDeliveryAttempts` to take effect. */
  readonly deadLetters?: ChainWatcherDeadLetterStore;
  /**
   * Called each tick, before delivery, with every re-read inbound (finalized or not). The deposit record keeps progress from
   * it. A throw is logged and never stops delivery.
   */
  readonly onObserved?: (items: readonly FinalizedInbound[]) => Promise<void>;
  /**
   * Called each tick with every inbound that was seen and is no longer in a receipt. The deposit record reverses a credit it
   * made for one of them. A throw is logged and never stops delivery.
   */
  readonly onDropped?: (items: readonly FinalizedInbound[]) => Promise<void>;
}

interface DeliveryResult {
  readonly ok: boolean;
  readonly status: number | null;
  readonly error: string | null;
}

export class CryptoChainWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly log: (msg: string, extra?: Record<string, unknown>) => void;
  private readonly cursors: ChainWatcherCursorStore;
  private readonly watcherId: string;
  private readonly attempts = new Map<string, number>();

  constructor(private readonly options: ChainWatcherOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => undefined);
    this.cursors = options.cursorStore ?? new MemoryChainWatcherCursorStore();
    this.watcherId = options.watcherId ?? CRYPTO_NATIVE_WATCHER_ID;
  }

  start(): void {
    if (this.timer) return;
    const interval = this.options.pollIntervalMs ?? 2_000;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), interval);
    // Do not keep the process alive solely for the watcher in tests.
    if (typeof this.timer === 'object' && this.timer && 'unref' in this.timer) {
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      await this.options.chain.refresh();
      this.options.onAlive?.();
      await this.reportObserved();
      const cursor = await this.cursors.load(this.watcherId);
      const finalized = [...this.options.chain.drainFinalized()].sort((a, b) => compareChainWatcherCursor(cursorOf(a), cursorOf(b)));
      // One failed delivery blocks only its own address (the chain marks per address, earliest first, so a later
      // inbound there must wait) and freezes the cursor, so a restart retries it. Everyone else carries on; an
      // inbound delivered past the frozen cursor is deduped at the book by its delivery id if a restart repeats it.
      const blocked = new Set<string>();
      let cursorFrozen = false;
      for (const item of finalized) {
        const addressKey = item.address.toLowerCase();
        if (blocked.has(addressKey)) continue;
        const position = cursorOf(item);
        if (cursor && compareChainWatcherCursor(position, cursor) <= 0) {
          // Already delivered in a previous process. Mark so this process
          // stops draining it; do not POST again.
          this.options.chain.markFinalizedEmitted(item.address);
          continue;
        }
        const id = chainDeliveryId(item);
        const result = await this.deliver(item.address, item.transfer, item.logIndex, id);
        let handled = result.ok;
        if (!result.ok) {
          const attempts = (this.attempts.get(id) ?? 0) + 1;
          this.attempts.set(id, attempts);
          handled = await this.deadLetterIfDue(item, id, attempts, result);
        }
        if (!handled) {
          // Do not advance the cursor or mark: next tick retries this position (M226-03).
          blocked.add(addressKey);
          cursorFrozen = true;
          continue;
        }
        this.attempts.delete(id);
        if (!cursorFrozen) await this.cursors.save(this.watcherId, position);
      }
      return finalized.length;
    } catch (err) {
      this.log('chain watcher tick failed', {
        err: err instanceof Error ? err.message : String(err),
      });
      return 0;
    } finally {
      this.running = false;
    }
  }

  private async reportObserved(): Promise<void> {
    const observe = this.options.onObserved;
    const items = this.options.chain.observedInbound?.();
    if (observe && items && items.length > 0) {
      try {
        await observe(items);
      } catch (err) {
        this.log('chain watcher could not report observed inbounds', { err: err instanceof Error ? err.message : String(err) });
      }
    }
    const drop = this.options.onDropped;
    const dropped = this.options.chain.droppedInbound?.();
    if (drop && dropped && dropped.length > 0) {
      try {
        await drop(dropped);
      } catch (err) {
        this.log('chain watcher could not report dropped inbounds', { err: err instanceof Error ? err.message : String(err) });
      }
    }
  }

  /** Records the dead letter and releases the inbound once the published attempts are used up. */
  private async deadLetterIfDue(item: FinalizedInbound, id: string, attempts: number, result: DeliveryResult): Promise<boolean> {
    const max = this.options.maxDeliveryAttempts;
    const store = this.options.deadLetters;
    if (max === undefined || store === undefined || attempts < max) return false;
    try {
      await store.record({
        deliveryId: id,
        watcherId: this.watcherId,
        address: item.address,
        txHash: item.transfer.txHash,
        logIndex: item.logIndex,
        blockNumber: item.blockNumber.toString(),
        attempts,
        lastStatus: result.status,
        lastError: result.error,
      });
    } catch (err) {
      this.log('chain watcher dead letter not recorded; inbound stays pending', {
        deliveryId: id,
        err: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
    this.options.chain.markFinalizedEmitted(item.address);
    this.log('chain watcher dead-lettered an inbound', { deliveryId: id, address: item.address, attempts });
    return true;
  }

  private async deliver(
    address: string,
    transfer: { txHash: string; assetId: string; amount: bigint; from: string; confirmations: number },
    logIndex: number,
    id: string,
  ): Promise<DeliveryResult> {
    const at = this.now();
    const payload = {
      id,
      type: 'captured',
      ref: address,
      amount: formatAmount(transfer.amount),
      assetId: transfer.assetId,
      occurredAt: at.toISOString(),
      txHash: transfer.txHash,
      logIndex,
      from: transfer.from,
      confirmations: transfer.confirmations,
    };
    const body = JSON.stringify(payload);
    const timestamp = Math.floor(at.getTime() / 1000).toString();
    const signature = signPayload(this.options.secret, timestamp, body);

    let res: Response;
    try {
      res = await this.fetchImpl(this.options.webhookUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-chain-signature': signature,
          'x-chain-timestamp': timestamp,
        },
        body,
      });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.log('chain watcher delivery failed', { error, address, txHash: transfer.txHash });
      return { ok: false, status: null, error };
    }

    if (!res.ok && res.status !== 202) {
      // Do not mark emitted — next tick re-drains and retries (M226-03).
      this.log('chain watcher delivery rejected', { status: res.status, address, txHash: transfer.txHash });
      return { ok: false, status: res.status, error: null };
    }
    this.options.chain.markFinalizedEmitted(address);
    this.log('chain watcher delivered', { address, txHash: transfer.txHash, status: res.status });
    return { ok: true, status: res.status, error: null };
  }
}
