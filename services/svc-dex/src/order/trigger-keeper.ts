/**
 * Keeper tick for resting price-trigger orders (D-limit-dca-02, VLT-5).
 *
 * A stale or disagreeing price does not fill. The intent is on disk before `send`.
 * The tx hash is recorded by `noteTx` before `send` resolves or rejects. A throw or
 * `unknown` stays `executing` until `fill.read` on that hash returns `reverted` or
 * success. A later rejected or unwired answer does not clear the row. One tick at
 * a time. Quoted size is reserved across orders until each send settles.
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
  book.hold(pair, exec.take);
  const take = exec.take;
  return async () => {
    try {
      await broadcast(book, deps, tickId, orderHash, now);
    } finally {
      book.release(pair, take);
    }
  };
}

function note(book: OrderBook, orderHash: string, tickId: string, reason: AttemptReason, now: Date): null {
  book.addAttempt(orderHash, tickId, reason, now.toISOString());
  return null;
}

async function broadcast(book: OrderBook, deps: KeeperDeps, tickId: string, orderHash: string, now: Date): Promise<void> {
  const row = book.live(orderHash);
  const exec = row?.executing;
  if (!row || !exec) return;
  book.noteSendStarted(orderHash);
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
    // The port may have broadcast before throwing. `noteTx` already persisted the hash when it had one.
    return;
  }
  if (sent.status === 'unknown') {
    if (sent.txHash) book.noteTx(orderHash, sent.txHash);
    return;
  }
  const hash = book.live(orderHash)?.executing?.txHash;
  if (sent.status === 'rejected' || sent.status === 'unwired') {
    // This answer is the send just started. A stored hash means the broadcast
    // already happened, so only fill.read may clear it. No hash: nothing went out.
    if (hash) {
      await readStored(book, deps, tickId, orderHash, now);
      return;
    }
    book.clearExecuting(orderHash);
    note(
      book,
      orderHash,
      tickId,
      sent.status === 'unwired'
        ? attemptReasons.railCrypto
        : sent.reason === 'reverted'
          ? attemptReasons.reverted
          : attemptReasons.insufficientLiquidity,
      now,
    );
    return;
  }
  book.noteTx(orderHash, sent.txHash);
  await readStored(book, deps, tickId, orderHash, now);
}

async function reconcile(book: OrderBook, deps: KeeperDeps, tickId: string, orderHash: string, now: Date): Promise<void> {
  const exec = book.live(orderHash)?.executing;
  if (!exec) return;
  if (exec.txHash) {
    await readStored(book, deps, tickId, orderHash, now);
    return;
  }
  if (exec.uncertain) {
    await retryUncertain(book, deps, tickId, orderHash, now);
    return;
  }
  await broadcast(book, deps, tickId, orderHash, now);
}

/** Same fill key only. A rejected or unwired retry does not open a new round. */
async function retryUncertain(book: OrderBook, deps: KeeperDeps, tickId: string, orderHash: string, now: Date): Promise<void> {
  const row = book.live(orderHash);
  const exec = row?.executing;
  if (!row || !exec || exec.txHash) return;
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
    return;
  }
  if (sent.status === 'sent') {
    book.noteTx(orderHash, sent.txHash);
    await readStored(book, deps, tickId, orderHash, now);
    return;
  }
  if (sent.status === 'unknown' && sent.txHash) book.noteTx(orderHash, sent.txHash);
  const hash = book.live(orderHash)?.executing?.txHash;
  if (hash) await readStored(book, deps, tickId, orderHash, now);
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
