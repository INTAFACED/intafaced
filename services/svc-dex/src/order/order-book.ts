/**
 * Process-local book of resting trigger orders (D-limit-dca-02).
 *
 * This is not a balance and not a second ledger. Funds stay in the maker's vault,
 * which this process never holds. A restart drops the rows; the same signed order
 * creates one row again. The lock is per order hash so two ticks cannot both take
 * the remaining size.
 */

import { createHash } from 'node:crypto';
import { formatAmount } from '@intafaced/ledger-client/money';
import type { TriggerVariant } from './trigger-math.js';

export const RESTING_ORDER_COPY =
  'Your resting order is held by the platform keeper and is not visible on chain until it fills. The vault funds are on chain.';
export const RATE_COPY = 'not a guaranteed fixed rate';

export type OrderState = 'open' | 'executing' | 'filled' | 'expired';

export interface OrderFillView {
  readonly round: number;
  readonly key: string;
  readonly amountIn: string;
  readonly amountOut: string;
  readonly minOut: string;
  readonly txHash: string;
}

export interface OrderView {
  readonly orderHash: string;
  readonly state: OrderState;
  readonly variant: TriggerVariant;
  readonly maker: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amountIn: string;
  readonly remaining: string;
  readonly triggerPrice: string;
  readonly minOut: string;
  readonly expiry: string;
  readonly slippageBps: number;
  readonly version: 1;
  readonly fills: OrderFillView[];
  readonly pendingFill: null | { readonly round: number; readonly key: string; readonly txHash: string | null };
  readonly sheet: { readonly rate: typeof RATE_COPY; readonly minOut: string; readonly resting: typeof RESTING_ORDER_COPY };
}

export interface AttemptView {
  readonly key: string;
  readonly orderHash: string;
  readonly tick: string;
  readonly reason: string;
  readonly at: string;
}

export interface NewTriggerOrder {
  readonly orderHash: string;
  readonly principalUserId: string;
  readonly variant: TriggerVariant;
  readonly maker: string;
  readonly tokenIn: string;
  readonly tokenOut: string;
  readonly amountIn: bigint;
  readonly triggerPrice: bigint;
  readonly minOut: bigint;
  readonly expiry: string;
  readonly slippageBps: number;
  readonly signature: string;
}

interface Executing {
  round: number;
  key: string;
  take: bigint;
  floor: bigint;
  quotedOut: bigint;
  txHash: string | null;
}

interface Row {
  orderHash: string;
  principalUserId: string;
  variant: TriggerVariant;
  maker: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  remaining: bigint;
  triggerPrice: bigint;
  minOut: bigint;
  expiry: string;
  slippageBps: number;
  signature: string;
  state: OrderState;
  nextRound: number;
  fills: Array<{ round: number; key: string; amountIn: bigint; amountOut: bigint; minOut: bigint; txHash: string }>;
  executing: Executing | null;
}

/**
 * Idempotency identity for one economic order. Not an EIP-712 digest: this process
 * does not recover a signature and does not invent a random id.
 */
export function priceOrderHash(parts: {
  variant: TriggerVariant;
  maker: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  triggerPrice: bigint;
  minOut: bigint;
  expiry: string;
  slippageBps: number;
}): string {
  const canonical = JSON.stringify([
    'dex.order.price.v1',
    parts.variant,
    parts.maker,
    parts.tokenIn,
    parts.tokenOut,
    formatAmount(parts.amountIn),
    formatAmount(parts.triggerPrice),
    formatAmount(parts.minOut),
    parts.expiry,
    String(parts.slippageBps),
  ]);
  return `0x${createHash('sha256').update(canonical).digest('hex')}`;
}

export function fillKey(orderHash: string, round: number): string {
  return `dex.order.fill:${orderHash}:${round}`;
}

function sheet(minOut: bigint): OrderView['sheet'] {
  return { rate: RATE_COPY, minOut: formatAmount(minOut), resting: RESTING_ORDER_COPY };
}

function viewOf(row: Row): OrderView {
  return {
    orderHash: row.orderHash,
    state: row.state,
    variant: row.variant,
    maker: row.maker,
    tokenIn: row.tokenIn,
    tokenOut: row.tokenOut,
    amountIn: formatAmount(row.amountIn),
    remaining: formatAmount(row.remaining),
    triggerPrice: formatAmount(row.triggerPrice),
    minOut: formatAmount(row.minOut),
    expiry: row.expiry,
    slippageBps: row.slippageBps,
    version: 1,
    fills: row.fills.map((fill) => ({
      round: fill.round,
      key: fill.key,
      amountIn: formatAmount(fill.amountIn),
      amountOut: formatAmount(fill.amountOut),
      minOut: formatAmount(fill.minOut),
      txHash: fill.txHash,
    })),
    pendingFill: row.executing ? { round: row.executing.round, key: row.executing.key, txHash: row.executing.txHash } : null,
    sheet: sheet(row.minOut),
  };
}

export class OrderBook {
  private readonly rows = new Map<string, Row>();
  private readonly attemptByKey = new Map<string, AttemptView>();
  private readonly attemptsByOrder = new Map<string, AttemptView[]>();
  private readonly tails = new Map<string, Promise<void>>();

  get size(): number {
    return this.rows.size;
  }

  ids(): string[] {
    return [...this.rows.keys()];
  }

  /** One order at a time. The next caller waits until `fn` finishes, including its awaits. */
  async exclusive<T>(orderHash: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(orderHash) ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(orderHash, done);
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  principalOf(orderHash: string): string | undefined {
    return this.rows.get(orderHash)?.principalUserId;
  }

  view(orderHash: string): OrderView | undefined {
    const row = this.rows.get(orderHash);
    return row ? viewOf(row) : undefined;
  }

  attempts(orderHash: string): readonly AttemptView[] {
    return [...(this.attemptsByOrder.get(orderHash) ?? [])];
  }

  /** Insert only when absent. Caller holds `exclusive`. */
  insert(order: NewTriggerOrder): OrderView {
    const existing = this.rows.get(order.orderHash);
    if (existing) return viewOf(existing);
    const row: Row = {
      ...order,
      remaining: order.amountIn,
      state: 'open',
      nextRound: 1,
      fills: [],
      executing: null,
    };
    this.rows.set(order.orderHash, row);
    return viewOf(row);
  }

  has(orderHash: string): boolean {
    return this.rows.has(orderHash);
  }

  live(orderHash: string): Row | undefined {
    return this.rows.get(orderHash);
  }

  addAttempt(orderHash: string, tick: string, reason: string, at: string): void {
    const key = `dex.order.attempt:${orderHash}:${tick}:${reason}`;
    if (this.attemptByKey.has(key)) return;
    const attempt: AttemptView = { key, orderHash, tick, reason, at };
    this.attemptByKey.set(key, attempt);
    const list = this.attemptsByOrder.get(orderHash) ?? [];
    list.push(attempt);
    this.attemptsByOrder.set(orderHash, list);
  }

  markExpired(orderHash: string): boolean {
    const row = this.rows.get(orderHash);
    if (!row || row.state !== 'open') return false;
    row.state = 'expired';
    return true;
  }

  /**
   * Intent before any send. Round is consumed here so a reverted broadcast is not reused as a new send
   * under the same key, and a retry of an unknown send keeps this key.
   */
  beginFill(orderHash: string, take: bigint, floor: bigint, quotedOut: bigint): Executing | undefined {
    const row = this.rows.get(orderHash);
    if (!row || row.state !== 'open' || row.executing || take <= 0n || take > row.remaining || quotedOut < floor) return undefined;
    const round = row.nextRound;
    row.nextRound += 1;
    const executing: Executing = {
      round,
      key: fillKey(row.orderHash, round),
      take,
      floor,
      quotedOut,
      txHash: null,
    };
    row.executing = executing;
    row.state = 'executing';
    return executing;
  }

  noteTx(orderHash: string, txHash: string): void {
    const row = this.rows.get(orderHash);
    if (!row?.executing) return;
    if (row.executing.txHash && row.executing.txHash !== txHash) return;
    row.executing.txHash = txHash;
  }

  /** Credit one fill. Refuses to take more than remaining or to record an output under the floor. */
  applyFill(orderHash: string): boolean {
    const row = this.rows.get(orderHash);
    const exec = row?.executing;
    if (!row || !exec || !exec.txHash) return false;
    if (exec.take > row.remaining || exec.quotedOut < exec.floor) return false;
    row.remaining -= exec.take;
    row.fills.push({
      round: exec.round,
      key: exec.key,
      amountIn: exec.take,
      amountOut: exec.quotedOut,
      minOut: exec.floor,
      txHash: exec.txHash,
    });
    row.executing = null;
    row.state = row.remaining === 0n ? 'filled' : 'open';
    return true;
  }

  /** Definite non-fill. Only call when no broadcast is outstanding. */
  clearExecuting(orderHash: string): void {
    const row = this.rows.get(orderHash);
    if (!row || row.state !== 'executing') return;
    row.executing = null;
    row.state = 'open';
  }
}
