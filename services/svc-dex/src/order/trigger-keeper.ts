/**
 * Keeper tick for resting price-trigger orders (D-limit-dca-02, VLT-5).
 *
 * A stale or disagreeing price does not fill. The intent row is `executing` before `send`.
 * An unknown send stays `executing` until `read` answers; only that path leaves `executing`
 * after a send. The shipped ports never send.
 */

import { attemptReasons, refuseTrigger, triggerOrderCodes, type AttemptReason } from './trigger-error.js';
import { minOutForFill, triggerReached } from './trigger-math.js';
import { OrderBook } from './order-book.js';
import type { FillPort, FillSend, PricePort } from './trigger-ports.js';
import type { TriggerSettings } from './trigger-settings.js';

export interface KeeperDeps {
  readonly now: () => Date;
  readonly settings: TriggerSettings;
  readonly price: PricePort;
  readonly fill: FillPort;
}

function blank(value: string | undefined): boolean {
  return value === undefined || value.trim() === '';
}

export async function runKeeperTick(book: OrderBook, deps: KeeperDeps, tickId: string): Promise<{ scanned: number }> {
  if (blank(tickId)) refuseTrigger(triggerOrderCodes.tickUnset, 'a keeper tick needs an id; none is invented');
  const ids = book.ids();
  for (const id of ids) {
    await book.exclusive(id, async () => {
      await tickLocked(book, deps, tickId, id);
    });
  }
  return { scanned: ids.length };
}

async function tickLocked(book: OrderBook, deps: KeeperDeps, tickId: string, orderHash: string): Promise<void> {
  const row = book.live(orderHash);
  if (!row || row.state === 'filled' || row.state === 'expired') return;
  const now = deps.now();
  if (row.state === 'executing') {
    await reconcile(book, deps, tickId, orderHash, now);
    const after = book.live(orderHash);
    if (after && after.state === 'open' && Date.parse(after.expiry) <= now.getTime()) book.markExpired(orderHash);
    return;
  }
  if (Date.parse(row.expiry) <= now.getTime()) {
    book.markExpired(orderHash);
    return;
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

  const quote = await deps.fill.quote({
    orderHash: row.orderHash,
    maker: row.maker,
    tokenIn: row.tokenIn,
    tokenOut: row.tokenOut,
    amountIn: row.remaining,
  });
  if (quote.status === 'unwired') return note(book, orderHash, tickId, attemptReasons.railCrypto, now);
  if (quote.status === 'insufficient_liquidity') return note(book, orderHash, tickId, attemptReasons.insufficientLiquidity, now);
  if (quote.status === 'reverted') return note(book, orderHash, tickId, attemptReasons.reverted, now);
  if (quote.take <= 0n || quote.take > row.remaining) return note(book, orderHash, tickId, attemptReasons.insufficientLiquidity, now);
  const floor = minOutForFill(quote.take, row.amountIn, row.minOut);
  if (quote.out < floor) return note(book, orderHash, tickId, attemptReasons.insufficientLiquidity, now);

  const exec = book.beginFill(orderHash, quote.take, floor, quote.out);
  if (!exec) return;
  let sent: FillSend;
  try {
    sent = await deps.fill.send({
      key: exec.key,
      orderHash: row.orderHash,
      maker: row.maker,
      tokenIn: row.tokenIn,
      tokenOut: row.tokenOut,
      take: exec.take,
      minOut: floor,
    });
  } catch {
    // The port may have broadcast before throwing. Stay `executing` and reconcile by key.
    return;
  }
  if (sent.status === 'unknown') return;
  if (sent.status === 'rejected') {
    book.clearExecuting(orderHash);
    note(book, orderHash, tickId, sent.reason === 'reverted' ? attemptReasons.reverted : attemptReasons.insufficientLiquidity, now);
    return;
  }
  if (sent.status === 'unwired') {
    // Quote said the port was wired and send says nothing went out. No hash exists.
    book.clearExecuting(orderHash);
    note(book, orderHash, tickId, attemptReasons.railCrypto, now);
    return;
  }
  book.noteTx(orderHash, sent.txHash);
  await reconcile(book, deps, tickId, orderHash, now);
}

async function reconcile(book: OrderBook, deps: KeeperDeps, tickId: string, orderHash: string, now: Date): Promise<void> {
  const row = book.live(orderHash);
  const exec = row?.executing;
  if (!row || !exec) return;
  let txHash = exec.txHash;
  if (!txHash) {
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
      });
    } catch {
      return;
    }
    if (sent.status === 'unknown' || sent.status === 'unwired') return;
    if (sent.status === 'rejected') {
      book.clearExecuting(orderHash);
      note(book, orderHash, tickId, sent.reason === 'reverted' ? attemptReasons.reverted : attemptReasons.insufficientLiquidity, now);
      return;
    }
    txHash = sent.txHash;
    book.noteTx(orderHash, txHash);
  }
  const receipt = await deps.fill.read(txHash);
  if (receipt === 'pending' || receipt === 'unwired') return;
  if (receipt === 'reverted') {
    book.clearExecuting(orderHash);
    note(book, orderHash, tickId, attemptReasons.reverted, now);
    return;
  }
  book.applyFill(orderHash);
}

function note(book: OrderBook, orderHash: string, tickId: string, reason: AttemptReason, now: Date): void {
  book.addAttempt(orderHash, tickId, reason, now.toISOString());
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
    n += 1;
    const tick = `${input.deps.now().toISOString()}:${n}`;
    void runKeeperTick(input.book, input.deps, tick).catch((err) => input.onError?.(err));
  }, input.intervalMs);
  return () => clearInterval(timer);
}
