/**
 * THE ORDER KEEPER (D-limit-dca-02 to -04): a platform process with no custody. It reads the oracle price, checks each
 * open order's trigger, sizes the largest fill the pool pays at least the order's minimum for, and calls the vault's
 * `fill`, which checks everything again on chain. It only ever calls `fill`, `poke` (a trailing watermark) and nothing
 * that touches a maker's credit otherwise.
 *
 * Saga (ENGINE SAGA-1..5): the intent row (`pending`, key `dex.order.fill:<orderId>:<round>`) is written before the
 * send; a stored hash is finished only by its receipt; a send that may have happened keeps the row `executing`; a retry
 * reuses the same key. Just before a send the stored state is read again, so a cancel that landed in the same second
 * refuses the fill ("Fill refused: the order was cancelled") and nothing is sent.
 *
 * An attempt is logged only when its reason changes, or when the keeper first checks a new version (an edit), so the log
 * says why an order is still open without filling with repeats.
 */

import type { Hex } from 'viem';
import type { VaultChain } from './chain.js';
import { FINAL_STATES, ZERO32, type ChainOrder, type OrderPair, type WalletOrder } from './model.js';
import { amountText, priceText, tokenIn } from './orders.js';
import { keepAttempts, type WalletOrderStore } from './store.js';

const BPS = 10_000n;

export interface KeeperDeps {
  readonly store: WalletOrderStore;
  readonly chain: VaultChain;
  readonly pairs: readonly OrderPair[] | undefined;
  readonly now: () => Date;
}

/** Ceiling of minOut * take / amountIn: the least one fill may pay. */
export function floorFor(order: ChainOrder, take: bigint): bigint {
  const f = (order.minOut * take + order.amountIn - 1n) / order.amountIn;
  return f === 0n ? 1n : f;
}

/** What a constant-product pool pays for `x` in (the pool's own integer formula). */
export function poolOut(x: bigint, reserveIn: bigint, reserveOut: bigint, feeBps: bigint): bigint {
  if (x <= 0n || reserveIn <= 0n || reserveOut <= 0n) return 0n;
  const withFee = x * (BPS - feeBps);
  return (withFee * reserveOut) / (reserveIn * BPS + withFee);
}

/** The largest input up to `limit` the pool pays at least the order's pro-rata floor for; zero when none. */
export function largestTake(order: ChainOrder, limit: bigint, reserveIn: bigint, reserveOut: bigint, feeBps: bigint): bigint {
  const ok = (x: bigint) => poolOut(x, reserveIn, reserveOut, feeBps) >= floorFor(order, x);
  if (limit <= 0n || !ok(1n)) return 0n;
  if (ok(limit)) return limit;
  let lo = 1n;
  let hi = limit;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (ok(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** The least input whose output reaches `want`, at most `limit` (the whole limit when even that falls short). */
export function smallestTakeFor(want: bigint, limit: bigint, reserveIn: bigint, reserveOut: bigint, feeBps: bigint): bigint {
  if (poolOut(limit, reserveIn, reserveOut, feeBps) < want) return limit;
  let lo = 0n;
  let hi = limit;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (poolOut(mid, reserveIn, reserveOut, feeBps) >= want) hi = mid;
    else lo = mid;
  }
  return hi;
}

const REASON_OF: Record<string, string> = {
  TriggerNotReached: 'predicate_false',
  Stale: 'oracle_stale',
  MissingReport: 'oracle_stale',
  Disagreement: 'oracle_disagree',
  InsufficientCredit: 'insufficient_credit',
  BelowMinOut: 'insufficient_liquidity',
  InsufficientOutput: 'insufficient_liquidity',
  InsufficientLiquidity: 'insufficient_liquidity',
  OrderExpired: 'expired',
  OrderCancelled: 'cancelled',
  StaleVersion: 'stale_version',
  Overfill: 'nothing_left',
};

export class OrderKeeper {
  private running = false;

  constructor(private readonly deps: KeeperDeps) {}

  private attempt(row: WalletOrder, reason: string, extra: { trigger?: string; price?: string } = {}): void {
    const version = Number(row.order.version);
    const last = row.attempts.at(-1);
    if (last && last.reason === reason && last.version === version) return;
    row.attempts.push({ at: this.deps.now().toISOString(), reason, version, ...extra });
    keepAttempts(row);
  }

  /** One pass over every order that is not final. Never two passes at once. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const pair = this.deps.pairs?.[0];
      for (const row of this.deps.store.all()) {
        try {
          await this.serve(row, pair);
        } catch (err) {
          this.attempt(row, 'reverted', { trigger: err instanceof Error ? err.message.slice(0, 80) : undefined });
        }
      }
      this.deps.store.save();
    } finally {
      this.running = false;
    }
  }

  private async serve(row: WalletOrder, pair: OrderPair | undefined): Promise<void> {
    const { chain } = this.deps;
    // A cancel recorded since the last pass: this pass is refused by the stored state, once, and nothing is sent.
    if (row.cancelRequested && !row.events.some((e) => e.type === 'cancel_refused_fill') && !row.pending) {
      if (row.state !== 'executing') {
        row.events.push({ at: this.deps.now().toISOString(), type: 'cancel_refused_fill', version: Number(row.order.version) });
        return;
      }
    }
    if (FINAL_STATES.has(row.state) && !row.pending) return;
    if (!chain.wired || !pair) return this.attempt(row, 'rail.crypto');

    if (row.pending) return this.reconcile(row);

    const now = await chain.now();
    if (now > row.order.expiry) {
      row.state = 'expired';
      row.updatedAt = this.deps.now().toISOString();
      row.events.push({ at: row.updatedAt, type: 'expired' });
      return;
    }

    if (row.state === 'waiting') {
      if (!row.parentId || (await chain.boughtOut(row.parentId)) === 0n) return;
      row.state = 'open';
      row.events.push({ at: this.deps.now().toISOString(), type: 'activated' });
    }

    const read = await chain.price(row.order.base, row.order.quote);
    if (read.status === 'stale') return this.attempt(row, 'oracle_stale');
    if (read.status === 'disagree') return this.attempt(row, 'oracle_disagree');
    if (read.status !== 'ok') return this.attempt(row, read.status === 'unwired' ? 'rail.crypto' : 'reverted');
    const price = read.priceWad;

    // A trailing order: its watermark follows the price in the holder's favour, on chain.
    let trigger = row.order.triggerWad;
    if (row.order.trailBps > 0n) {
      const mark = await chain.watermark(row.order);
      const better = mark === 0n || (row.order.above ? price < mark : price > mark);
      if (better) {
        const hash = await chain.sendPoke(row.order);
        await this.waitMined(hash);
      }
      const wm = better ? price : mark;
      trigger = row.order.above ? (wm * (BPS + row.order.trailBps)) / BPS : (wm * (BPS - row.order.trailBps)) / BPS;
    }

    const version = Number(row.order.version);
    if (row.checkedVersion !== version) {
      row.checkedVersion = version;
      row.attempts.push({
        at: this.deps.now().toISOString(),
        reason: 'checked',
        version,
        trigger: priceText(trigger),
        price: priceText(price),
      });
      keepAttempts(row);
    }

    const reached = row.order.above ? price >= trigger : price <= trigger;
    if (!reached) return this.attempt(row, 'predicate_false', { trigger: priceText(trigger), price: priceText(price) });

    const remaining = await chain.remaining(row.order);
    // A buy is done once it bought the base amount asked for; what it did not spend stays as vault credit.
    const boughtAll = row.order.isBuy && row.filledOut >= row.amountBase;
    if (remaining === 0n || boughtAll) return this.settleGroup(row);
    const credit = await chain.credit(row.order.maker, tokenIn(row.order));
    if (credit === 0n) return this.attempt(row, 'insufficient_credit');
    const limit = remaining < credit ? remaining : credit;
    const pool = await chain.pool(pair.pool, tokenIn(row.order));
    let take = largestTake(row.order, limit, pool.reserveIn, pool.reserveOut, pool.feeBps);
    if (row.order.isBuy && take > 0n) {
      const cap = smallestTakeFor(row.amountBase - row.filledOut, take, pool.reserveIn, pool.reserveOut, pool.feeBps);
      if (cap < take) take = cap;
    }
    if (take === 0n) return this.attempt(row, 'insufficient_liquidity', { price: priceText(price) });

    const sim = await chain.simulateFill(row.order, row.signature, take, pair.pool);
    if (!sim.ok) return this.attempt(row, REASON_OF[sim.reason] ?? 'reverted');

    // Intent before the send; the stored state is read once more right before it.
    const round = row.round + 1;
    row.pending = { key: `dex.order.fill:${row.id}:${round}`, round, take, txHash: null };
    row.state = 'executing';
    this.deps.store.save();
    if (row.cancelRequested) {
      row.pending = null;
      row.state = 'cancelled';
      row.events.push({ at: this.deps.now().toISOString(), type: 'cancel_refused_fill', version });
      return;
    }
    const hash = await chain.sendFill(row.order, row.signature, take, pair.pool);
    row.pending = { ...row.pending, txHash: hash };
    this.deps.store.save();
    await this.waitMined(hash);
    await this.reconcile(row);
  }

  private async waitMined(hash: Hex): Promise<void> {
    for (let i = 0; i < 20; i += 1) {
      const r = await this.deps.chain.receipt(hash);
      if (r.status !== 'pending') return;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  /** A stored hash is finished only by its receipt: success applies the fill, a revert clears the intent. */
  private async reconcile(row: WalletOrder): Promise<void> {
    const pending = row.pending;
    if (!pending) return;
    if (!pending.txHash) {
      // The process stopped between the intent and the send: nothing was broadcast with this key, so it is cleared.
      row.pending = null;
      row.state = row.cancelRequested ? 'cancelled' : 'open';
      return;
    }
    const r = await this.deps.chain.receipt(pending.txHash);
    if (r.status === 'pending') return;
    row.pending = null;
    if (r.status === 'reverted' || !r.filled) {
      row.state = row.cancelRequested ? 'cancelled' : 'open';
      return this.attempt(row, 'reverted');
    }
    const pair = this.deps.pairs![0]!;
    row.round = pending.round;
    row.filledIn += r.filled.amountIn;
    row.filledOut += r.filled.amountOut;
    const left = await this.deps.chain.remaining(row.order);
    const full = left === 0n || (row.order.isBuy && row.filledOut >= row.amountBase);
    const label =
      row.kind === 'take_profit' || row.kind === 'bracket_take_profit'
        ? 'take-profit'
        : row.kind === 'stop' || row.kind === 'bracket_stop'
          ? 'stop'
          : row.kind === 'trailing_stop'
            ? 'trailing'
            : full
              ? 'full'
              : 'partial';
    const outDecimals = row.order.isBuy ? pair.base.decimals : pair.quote.decimals;
    const inDecimals = row.order.isBuy ? pair.quote.decimals : pair.base.decimals;
    row.updatedAt = this.deps.now().toISOString();
    row.events.push({
      at: row.updatedAt,
      type: 'fill',
      label,
      amountIn: amountText(r.filled.amountIn, inDecimals),
      amountOut: amountText(r.filled.amountOut, outDecimals),
      minOut: amountText(floorFor(row.order, r.filled.amountIn), outDecimals),
      price: priceText(r.filled.priceWad),
      txHash: pending.txHash,
      version: Number(row.order.version),
    });
    row.state = row.cancelRequested ? 'cancelled' : 'open';
    if (full) await this.settleGroup(row);
  }

  /** Nothing left in the order's group: it is filled, and every linked sibling ends "cancelled by link". */
  private async settleGroup(row: WalletOrder): Promise<void> {
    const at = this.deps.now().toISOString();
    // A bracket exit is done only once its parent can buy no more.
    if (row.parentId) {
      const parent = this.deps.store.get(row.parentId);
      if (parent && !FINAL_STATES.has(parent.state)) return;
    }
    if (!FINAL_STATES.has(row.state)) {
      row.state = row.filledIn > 0n ? 'filled' : 'cancelled_by_link';
      if (row.state === 'cancelled_by_link') row.events.push({ at, type: 'cancelled_by_link' });
      row.updatedAt = at;
    }
    if (row.order.link === ZERO32) return;
    for (const id of row.siblings) {
      const sib = this.deps.store.get(id);
      if (!sib || FINAL_STATES.has(sib.state) || sib.pending) continue;
      if (sib.filledIn > 0n) {
        sib.state = 'filled';
      } else {
        sib.state = 'cancelled_by_link';
        sib.events.push({ at, type: 'cancelled_by_link' });
      }
      sib.updatedAt = at;
    }
  }
}

/** Starts the keeper on its interval; blank interval does not start it. Returns a stop function. */
export function startOrderKeeper(keeper: OrderKeeper, intervalMs: number | undefined, onError: (err: unknown) => void): () => void {
  if (!intervalMs) return () => undefined;
  const timer = setInterval(() => {
    keeper.tick().catch(onError);
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
