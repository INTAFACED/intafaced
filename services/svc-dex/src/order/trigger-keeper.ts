/**
 * Keeper tick for resting price-trigger orders (D-limit-dca-02, VLT-5).
 *
 * A stale or disagreeing price does not fill. The intent is on disk before `send`.
 * Quoted size is the sum of executing takes on the pair. It stays until `applyFill`
 * or `clearExecuting`, including when `fill.read` is pending or unwired, and when
 * a tick throws before the queued send runs. The next tick reconciles that row.
 * Uncertain is set when `noteTx` stores a hash, `send` returns unknown, or `send`
 * returns sent with a blank hash. A throw, rejection, or unwired answer clears the
 * row only while it is not uncertain and no hash is stored, and it does not start
 * the next round. Once uncertain, those answers leave the row executing on the same
 * key. A repeat of `send` only recovers that hash, including after expiry. Only
 * `fill.read` may apply the fill or clear it. One tick at a time.
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

/** A blank or whitespace hash was not stored. It is not evidence that send never ran. */
function storedHash(txHash: string | undefined): string | undefined {
  if (txHash === undefined) return undefined;
  const trimmed = txHash.trim();
  return trimmed === '' ? undefined : trimmed;
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

/**
 * Nothing was broadcast. Clears the intent and does not begin another round.
 * Once `uncertain` is set, or a hash is stored, a later throw, rejection, or
 * unwired answer must not clear: round 1 may already have been broadcast.
 */
function abandonUnsent(book: OrderBook, orderHash: string, tickId: string, now: Date, reason: AttemptReason): void {
  const exec = book.live(orderHash)?.executing;
  if (!exec || exec.txHash || exec.uncertain) return;
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
    // A hash means `noteTx` ran. Uncertain means a broadcast may already have happened.
    // Either way only `fill.read` may finish the row, and only after a hash is stored.
    if (book.live(orderHash)?.executing?.txHash) return;
    abandonUnsent(book, orderHash, tickId, now, attemptReasons.reverted);
    return;
  }
  if (sent.status === 'unknown') {
    const hash = storedHash(sent.txHash);
    if (hash) book.noteTx(orderHash, hash);
    else book.markUncertain(orderHash);
    return;
  }
  if (sent.status === 'rejected' || sent.status === 'unwired') {
    // A stored hash means the broadcast already happened, so only fill.read may clear it.
    if (book.live(orderHash)?.executing?.txHash) {
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
  const delivered = storedHash(sent.txHash);
  if (delivered) book.noteTx(orderHash, delivered);
  // A blank hash is not "send never ran". Do not let expiry clear it.
  if (!book.live(orderHash)?.executing?.txHash) {
    book.markUncertain(orderHash);
    return;
  }
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
  // No hash and not uncertain: send was never entered. Past expiry, do not broadcast.
  if (Date.parse(row.expiry) <= now.getTime() && !exec.uncertain) {
    book.clearExecuting(orderHash);
    book.markExpired(orderHash);
    return;
  }
  // Same key, including after expiry when the row is uncertain and still has no hash.
  // A repeat recovers the original hash and must not broadcast a new fill.
  // A rejected or thrown repeat does not clear, so round 2 cannot start.
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
