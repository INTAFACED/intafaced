/**
 * Keeper tick for resting price-trigger orders (D-limit-dca-02, VLT-5).
 *
 * A stale or disagreeing price does not fill. The intent is on disk before `send`.
 * Quoted size is the sum of executing takes on the pair. It stays until `applyFill`
 * or `clearExecuting`, including when `fill.read` is pending or unwired, and when
 * a tick throws before the queued send runs. The next tick reconciles that row.
 * A terminal read clears it. Uncertain is set only once `noteTx` stores a hash,
 * or `send` returns unknown. A throw, rejection, or unwired answer with no stored
 * hash clears the row and does not start the next round. One tick at a time.
 */

import { attemptReasons, refuseTrigger, triggerOrderCodes, type AttemptReason } from './trigger-error.js';
import { minOutForFill, triggerReached } from './trigger-math.js';
import { OrderBook, poolKey } from './order-book.js';
import type { FillPort, FillSend, PricePort } from './trigger-ports.js';
import type { TriggerSettings } from './trigger-settings.js';

export interface KeeperDeps {
  readonly now: () => Date;
  readonly settings: TriggerSettings;
  readonly price: PricePort;
  readonly fill: FillPort;
}

export interface KeeperTickResult {
  readonly scanned: number;
  readonly started: boolean;
}

function blank(value: string | undefined): boolean {
  return value === undefined || value.trim() === '';
}

export async function runKeeperTick(book: OrderBook, deps: KeeperDeps, tickId: string): Promise<KeeperTickResult> {
  if (blank(tickId)) refuseTrigger(triggerOrderCodes.tickUnset, 'a keeper tick needs an id; none is invented');
  if (!book.beginTick()) return { scanned: 0, started: false };
  const sends: Array<() => Promise<void>> = [];
  try {
    const ids = book.ids();
    for (const id of ids) {
      if (book.isBusy(id)) continue;
      await book.exclusive(id, async () => {
        const job = await prepare(book, deps, tickId, id);
        if (job) sends.push(job);
      });
    }
    await Promise.all(sends.map((run) => run()));
    return { scanned: ids.length, started: true };
  } finally {
    book.endTick();
  }
}

async function prepare(book: OrderBook, deps: KeeperDeps, tickId: string, orderHash: string): Promise<null | (() => Promise<void>)> {
  const row = book.live(orderHash);
  if (!row || row.state === 'filled' || row.state === 'expired') return null;
  const now = deps.now();
  if (row.state === 'executing') {
    await reconcile(book, deps, tickId, orderHash, now);
    const after = book.live(orderHash);
    if (after && after.state === 'open' && Date.parse(after.expiry) <= now.getTime()) book.markExpired(orderHash);
    return null;
  }
  if (Date.parse(row.expiry) <= now.getTime()) {
    book.markExpired(orderHash);
    return null;
  }

  const price = await deps.price.read({ tokenIn: row.tokenIn, tokenOut: row.tokenOut, at: now });
  if (price.status === 'unwired') return note(book, orderHash, tickId, attemptReasons.feedMarket, now);
  if (price.status === 'disagree') return note(book, orderHash, tickId, attemptReasons.oracleDisagree, now);
  if (price.status === 'stale') return note(book, orderHash, tickId, attemptReasons.oracleStale, now);
  if (deps.settings.oracleMaxAgeMs === undefined) return note(book, orderHash, tickId, attemptReasons.oracleMaxAgeUnset, now);
  const observed = Date.parse(price.observedAt);
  const age = now.getTime() - observed;
  if (!Number.isFinite(observed) || age < 0 || age > deps.settings.oracleMaxAgeMs) {
    return note(book, orderHash, tickId, attemptReasons.oracleStale, now);
  }
  if (!triggerReached(row.variant, price.price, row.triggerPrice)) {
    return note(book, orderHash, tickId, attemptReasons.predicateFalse, now);
  }

  const pair = poolKey(row.tokenIn, row.tokenOut);
  const quote = await deps.fill.quote({
    orderHash: row.orderHash,
    maker: row.maker,
    tokenIn: row.tokenIn,
    tokenOut: row.tokenOut,
    amountIn: row.remaining,
    reserved: book.reserved(pair),
  });
  if (quote.status === 'unwired') return note(book, orderHash, tickId, attemptReasons.railCrypto, now);
  if (quote.status === 'insufficient_liquidity') return note(book, orderHash, tickId, attemptReasons.insufficientLiquidity, now);
  if (quote.status === 'reverted') return note(book, orderHash, tickId, attemptReasons.reverted, now);
  if (quote.take <= 0n || quote.take > row.remaining) return note(book, orderHash, tickId, attemptReasons.insufficientLiquidity, now);
  const floor = minOutForFill(quote.take, row.amountIn, row.minOut);
  if (quote.out < floor) return note(book, orderHash, tickId, attemptReasons.insufficientLiquidity, now);

  const exec = book.beginFill(orderHash, quote.take, floor, quote.out);
  if (!exec) return null;
  return async () => {
    await broadcast(book, deps, tickId, orderHash, now);
  };
}

function note(book: OrderBook, orderHash: string, tickId: string, reason: AttemptReason, now: Date): null {
  book.addAttempt(orderHash, tickId, reason, now.toISOString());
  return null;
}

/** No hash was stored, so nothing was broadcast. Clears the intent and does not begin another round. */
function abandonUnsent(book: OrderBook, orderHash: string, tickId: string, now: Date, reason: AttemptReason): void {
  const exec = book.live(orderHash)?.executing;
  if (!exec || exec.txHash) return;
  book.clearExecuting(orderHash);
  note(book, orderHash, tickId, reason, now);
}

async function broadcast(book: OrderBook, deps: KeeperDeps, tickId: string, orderHash: string, now: Date): Promise<void> {
  const row = book.live(orderHash);
  const exec = row?.executing;
  if (!row || !exec) return;
  let sent: FillSend;
  try {
    sent = await deps.fill.send({
      key: exec.key,
      orderHash: row.orderHash,
      maker: row.maker,
      tokenIn: row.tokenIn,
      tokenOut: row.tokenOut,
      take: exec.take,
      minOut: exec.floor,
      noteTx: (txHash) => book.noteTx(orderHash, txHash),
    });
  } catch {
    // A hash means `noteTx` ran, so the broadcast may have happened. Only `fill.read` may finish it.
    if (book.live(orderHash)?.executing?.txHash) return;
    abandonUnsent(book, orderHash, tickId, now, attemptReasons.reverted);
    return;
  }
  if (sent.status === 'unknown') {
    if (sent.txHash) book.noteTx(orderHash, sent.txHash);
    else book.markUncertain(orderHash);
    return;
  }
  const hash = book.live(orderHash)?.executing?.txHash;
  if (sent.status === 'rejected' || sent.status === 'unwired') {
    // A stored hash means the broadcast already happened, so only fill.read may clear it.
    if (hash) {
      await readStored(book, deps, tickId, orderHash, now);
      return;
    }
    abandonUnsent(
      book,
      orderHash,
      tickId,
      now,
      sent.status === 'unwired'
        ? attemptReasons.railCrypto
        : sent.reason === 'reverted'
          ? attemptReasons.reverted
          : attemptReasons.insufficientLiquidity,
    );
    return;
  }
  book.noteTx(orderHash, sent.txHash);
  await readStored(book, deps, tickId, orderHash, now);
}

async function reconcile(book: OrderBook, deps: KeeperDeps, tickId: string, orderHash: string, now: Date): Promise<void> {
  const row = book.live(orderHash);
  const exec = row?.executing;
  if (!row || !exec) return;
  if (exec.txHash) {
    await readStored(book, deps, tickId, orderHash, now);
    return;
  }
  // No hash: a send was never confirmed. Past expiry, do not broadcast.
  if (Date.parse(row.expiry) <= now.getTime()) {
    if (!exec.uncertain) {
      book.clearExecuting(orderHash);
      book.markExpired(orderHash);
    }
    return;
  }
  await broadcast(book, deps, tickId, orderHash, now);
}

async function readStored(book: OrderBook, deps: KeeperDeps, tickId: string, orderHash: string, now: Date): Promise<void> {
  const exec = book.live(orderHash)?.executing;
  if (!exec?.txHash) return;
  const receipt = await deps.fill.read(exec.txHash);
  if (receipt === 'pending' || receipt === 'unwired') return;
  if (receipt === 'reverted') {
    book.clearExecuting(orderHash);
    note(book, orderHash, tickId, attemptReasons.reverted, now);
    return;
  }
  book.applyFill(orderHash);
}

export function startTriggerKeeper(input: {
  readonly book: OrderBook;
  readonly deps: KeeperDeps;
  readonly intervalMs: number | undefined;
  readonly onError?: (err: unknown) => void;
}): () => void {
  if (input.intervalMs === undefined) return () => {};
  let n = 0;
  const timer = setInterval(() => {
    if (input.book.tickOpen()) return;
    n += 1;
    const tick = `${input.deps.now().toISOString()}:${n}`;
    void runKeeperTick(input.book, input.deps, tick).catch((err) => input.onError?.(err));
  }, input.intervalMs);
  return () => clearInterval(timer);
}
