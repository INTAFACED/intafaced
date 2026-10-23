/**
 * Resting trigger orders (D-limit-dca-02).
 *
 * Rows live in `dex.orders.json` and attempts in `dex.order_attempts.json` under
 * one directory, scoped by the edge principal on each row. This is not a balance
 * and not a second ledger. Funds stay in the maker's vault. A new process opens
 * the same directory and resumes an executing row from the stored hash.
 */

import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatAmount, parseAmount } from '@intafaced/ledger-client/money';
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
  /** True once a tx hash is stored, or `send` has returned unknown. */
  uncertain: boolean;
}

interface FillRecord {
  round: number;
  key: string;
  amountIn: bigint;
  amountOut: bigint;
  minOut: bigint;
  txHash: string;
}

interface Row {
  orderHash: string;
  principalUserId: string;
  readers: Set<string>;
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
  fills: FillRecord[];
  executing: Executing | null;
}

interface StoredExecuting {
  round: number;
  key: string;
  take: string;
  floor: string;
  quotedOut: string;
  txHash: string | null;
  uncertain: boolean;
}

interface StoredOrder {
  orderHash: string;
  principalUserId: string;
  readers: string[];
  variant: TriggerVariant;
  maker: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  remaining: string;
  triggerPrice: string;
  minOut: string;
  expiry: string;
  slippageBps: number;
  signature: string;
  state: OrderState;
  nextRound: number;
  fills: Array<{ round: number; key: string; amountIn: string; amountOut: string; minOut: string; txHash: string }>;
  executing: StoredExecuting | null;
}

const VARIANTS: readonly TriggerVariant[] = ['buy_above', 'buy_below', 'sell_above', 'sell_below'];
const STATES: readonly OrderState[] = ['open', 'executing', 'filled', 'expired'];

/**
 * Idempotency identity for one economic order. The signature is recovered apart
 * from this hash; the hash does not include it and is not a random id.
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

export function poolKey(tokenIn: string, tokenOut: string): string {
  return `${tokenIn}:${tokenOut}`;
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

function atomicWrite(path: string, body: string): void {
  const tmp = `${path}.${process.pid}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeFileSync(fd, body);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

function money(raw: unknown, label: string): bigint {
  if (typeof raw !== 'string' || raw.trim() === '') throw new Error(`dex.orders ${label} is missing`);
  return parseAmount(raw);
}

function variantOf(raw: unknown): TriggerVariant {
  if (typeof raw !== 'string' || !(VARIANTS as readonly string[]).includes(raw)) throw new Error('dex.orders variant is unreadable');
  return raw as TriggerVariant;
}

function stateOf(raw: unknown): OrderState {
  if (typeof raw !== 'string' || !(STATES as readonly string[]).includes(raw)) throw new Error('dex.orders state is unreadable');
  return raw as OrderState;
}

function intOf(raw: unknown, label: string): number {
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw)) throw new Error(`dex.orders ${label} is unreadable`);
  return raw;
}

function loadExecuting(raw: unknown): Executing | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object') throw new Error('dex.orders executing is unreadable');
  const row = raw as Record<string, unknown>;
  const txHash = row.txHash;
  if (txHash !== null && typeof txHash !== 'string') throw new Error('dex.orders tx hash is unreadable');
  if (typeof row.uncertain !== 'boolean') throw new Error('dex.orders executing flag is unreadable');
  if (typeof row.key !== 'string' || row.key.trim() === '') throw new Error('dex.orders fill key is missing');
  return {
    round: intOf(row.round, 'round'),
    key: row.key,
    take: money(row.take, 'take'),
    floor: money(row.floor, 'floor'),
    quotedOut: money(row.quotedOut, 'quotedOut'),
    txHash,
    uncertain: row.uncertain,
  };
}

function loadOrder(raw: unknown): Row {
  if (raw === null || typeof raw !== 'object') throw new Error('dex.orders row is unreadable');
  const row = raw as Record<string, unknown>;
  if ('balance' in row) throw new Error('dex.orders must not store a balance');
  const principal = typeof row.principalUserId === 'string' ? row.principalUserId : '';
  if (principal.trim() === '') throw new Error('dex.orders principal is missing');
  const readers = new Set<string>();
  if (!Array.isArray(row.readers)) throw new Error('dex.orders readers are missing');
  for (const reader of row.readers) {
    if (typeof reader !== 'string' || reader.trim() === '') throw new Error('dex.orders reader is blank');
    readers.add(reader);
  }
  readers.add(principal);
  if (!Array.isArray(row.fills)) throw new Error('dex.orders fills are missing');
  const fills: FillRecord[] = row.fills.map((fill) => {
    if (fill === null || typeof fill !== 'object') throw new Error('dex.orders fill is unreadable');
    const item = fill as Record<string, unknown>;
    if (typeof item.key !== 'string' || typeof item.txHash !== 'string') throw new Error('dex.orders fill is unreadable');
    return {
      round: intOf(item.round, 'fill round'),
      key: item.key,
      amountIn: money(item.amountIn, 'fill amountIn'),
      amountOut: money(item.amountOut, 'fill amountOut'),
      minOut: money(item.minOut, 'fill minOut'),
      txHash: item.txHash,
    };
  });
  const orderHash = typeof row.orderHash === 'string' ? row.orderHash : '';
  if (orderHash.trim() === '') throw new Error('dex.orders hash is missing');
  return {
    orderHash,
    principalUserId: principal,
    readers,
    variant: variantOf(row.variant),
    maker: typeof row.maker === 'string' ? row.maker : '',
    tokenIn: typeof row.tokenIn === 'string' ? row.tokenIn : '',
    tokenOut: typeof row.tokenOut === 'string' ? row.tokenOut : '',
    amountIn: money(row.amountIn, 'amountIn'),
    remaining: money(row.remaining, 'remaining'),
    triggerPrice: money(row.triggerPrice, 'triggerPrice'),
    minOut: money(row.minOut, 'minOut'),
    expiry: typeof row.expiry === 'string' ? row.expiry : '',
    slippageBps: intOf(row.slippageBps, 'slippageBps'),
    signature: typeof row.signature === 'string' ? row.signature : '',
    state: stateOf(row.state),
    nextRound: intOf(row.nextRound, 'nextRound'),
    fills,
    executing: loadExecuting(row.executing),
  };
}

function storeExecuting(exec: Executing | null): StoredExecuting | null {
  if (!exec) return null;
  return {
    round: exec.round,
    key: exec.key,
    take: formatAmount(exec.take),
    floor: formatAmount(exec.floor),
    quotedOut: formatAmount(exec.quotedOut),
    txHash: exec.txHash,
    uncertain: exec.uncertain,
  };
}

function storeOrder(row: Row): StoredOrder {
  return {
    orderHash: row.orderHash,
    principalUserId: row.principalUserId,
    readers: [...row.readers],
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
    signature: row.signature,
    state: row.state,
    nextRound: row.nextRound,
    fills: row.fills.map((fill) => ({
      round: fill.round,
      key: fill.key,
      amountIn: formatAmount(fill.amountIn),
      amountOut: formatAmount(fill.amountOut),
      minOut: formatAmount(fill.minOut),
      txHash: fill.txHash,
    })),
    executing: storeExecuting(row.executing),
  };
}

export class OrderBook {
  readonly directory: string;
  private readonly ordersPath: string;
  private readonly attemptsPath: string;
  private readonly rows = new Map<string, Row>();
  private readonly attemptByKey = new Map<string, AttemptView>();
  private readonly attemptsByOrder = new Map<string, AttemptView[]>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly busy = new Set<string>();
  private tickRunning = false;

  /** `dir` omitted: a private temp directory. Pass the same directory to resume after a restart. */
  constructor(dir?: string) {
    this.directory = dir ?? mkdtempSync(join(tmpdir(), 'dex-orders-'));
    mkdirSync(this.directory, { recursive: true });
    this.ordersPath = join(this.directory, 'dex.orders.json');
    this.attemptsPath = join(this.directory, 'dex.order_attempts.json');
    this.load();
  }

  get size(): number {
    return this.rows.size;
  }

  ids(): string[] {
    return [...this.rows.keys()];
  }

  /** True while a keeper tick has entered and not yet finished. */
  tickOpen(): boolean {
    return this.tickRunning;
  }

  /** One tick at a time. A second caller gets false and must not scan. */
  beginTick(): boolean {
    if (this.tickRunning) return false;
    this.tickRunning = true;
    return true;
  }

  endTick(): void {
    this.tickRunning = false;
  }

  isBusy(orderHash: string): boolean {
    return this.busy.has(orderHash);
  }

  /**
   * Sum of executing takes on this pair, from the loaded rows. Not a balance.
   * Stays until `applyFill` or `clearExecuting`, including after a restart.
   */
  reserved(pair: string): bigint {
    let total = 0n;
    for (const row of this.rows.values()) {
      const exec = row.executing;
      if (row.state !== 'executing' || !exec) continue;
      if (poolKey(row.tokenIn, row.tokenOut) !== pair) continue;
      total += exec.take;
    }
    return total;
  }

  /** One order at a time. The next caller waits until `fn` finishes, including its awaits. */
  async exclusive<T>(orderHash: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(orderHash) ?? Promise.resolve();
    let release!: () => void;
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.tails.set(orderHash, done);
    this.busy.add(orderHash);
    await prev;
    try {
      return await fn();
    } finally {
      this.busy.delete(orderHash);
      release();
    }
  }

  principalOf(orderHash: string): string | undefined {
    return this.rows.get(orderHash)?.principalUserId;
  }

  allows(orderHash: string, principal: string): boolean {
    return this.rows.get(orderHash)?.readers.has(principal) ?? false;
  }

  /** A session that presented the recovered signature may read the row. */
  grant(orderHash: string, principal: string): void {
    const row = this.rows.get(orderHash);
    if (!row || row.readers.has(principal)) return;
    row.readers.add(principal);
    this.persist();
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
      readers: new Set([order.principalUserId]),
      remaining: order.amountIn,
      state: 'open',
      nextRound: 1,
      fills: [],
      executing: null,
    };
    this.rows.set(order.orderHash, row);
    this.persist();
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
    this.persist();
  }

  markExpired(orderHash: string): boolean {
    const row = this.rows.get(orderHash);
    if (!row || row.state !== 'open') return false;
    row.state = 'expired';
    this.persist();
    return true;
  }

  /**
   * Intent before any send. The round is consumed here, and the row is on disk
   * before `send` is called, so a crash cannot open round 1 again.
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
      uncertain: false,
    };
    row.executing = executing;
    row.state = 'executing';
    this.persist();
    return executing;
  }

  /** Persist the hash before `send` returns, and mark the row uncertain. A repeat is a no-op. */
  noteTx(orderHash: string, txHash: string): void {
    const row = this.rows.get(orderHash);
    if (!row?.executing) return;
    if (row.executing.txHash) return;
    if (txHash.trim() === '') return;
    row.executing.txHash = txHash;
    row.executing.uncertain = true;
    this.persist();
  }

  /** `send` returned unknown and stored no hash. A crash after this stays executing. */
  markUncertain(orderHash: string): void {
    const exec = this.rows.get(orderHash)?.executing;
    if (!exec || exec.uncertain || exec.txHash) return;
    exec.uncertain = true;
    this.persist();
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
    this.persist();
    return true;
  }

  /** Definite non-fill. Only when no broadcast is outstanding. */
  clearExecuting(orderHash: string): void {
    const row = this.rows.get(orderHash);
    if (!row || row.state !== 'executing') return;
    row.executing = null;
    row.state = 'open';
    this.persist();
  }

  private load(): void {
    if (existsSync(this.ordersPath)) {
      const parsed: unknown = JSON.parse(readFileSync(this.ordersPath, 'utf8'));
      if (parsed === null || typeof parsed !== 'object' || !Array.isArray((parsed as { orders?: unknown }).orders)) {
        throw new Error('dex.orders is unreadable');
      }
      for (const item of (parsed as { orders: unknown[] }).orders) {
        const row = loadOrder(item);
        if (this.rows.has(row.orderHash)) throw new Error('dex.orders has a duplicate hash');
        this.rows.set(row.orderHash, row);
      }
    }
    if (!existsSync(this.attemptsPath)) return;
    const parsed: unknown = JSON.parse(readFileSync(this.attemptsPath, 'utf8'));
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray((parsed as { attempts?: unknown }).attempts)) {
      throw new Error('dex.order_attempts is unreadable');
    }
    for (const item of (parsed as { attempts: unknown[] }).attempts) {
      if (item === null || typeof item !== 'object') throw new Error('dex.order_attempts row is unreadable');
      const row = item as Record<string, unknown>;
      if (typeof row.key !== 'string' || typeof row.orderHash !== 'string' || typeof row.tick !== 'string') {
        throw new Error('dex.order_attempts row is unreadable');
      }
      if (typeof row.reason !== 'string' || typeof row.at !== 'string') throw new Error('dex.order_attempts row is unreadable');
      if (this.attemptByKey.has(row.key)) continue;
      const attempt: AttemptView = { key: row.key, orderHash: row.orderHash, tick: row.tick, reason: row.reason, at: row.at };
      this.attemptByKey.set(attempt.key, attempt);
      const list = this.attemptsByOrder.get(attempt.orderHash) ?? [];
      list.push(attempt);
      this.attemptsByOrder.set(attempt.orderHash, list);
    }
  }

  private persist(): void {
    const attempts = [...this.attemptByKey.values()];
    atomicWrite(this.attemptsPath, JSON.stringify({ attempts }));
    const orders = [...this.rows.values()].map(storeOrder);
    atomicWrite(this.ordersPath, JSON.stringify({ orders }));
  }
}
