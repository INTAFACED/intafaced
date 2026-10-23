import type { QUANT_BACKTEST_ASSUMPTIONS, QUANT_BACKTEST_REJECT_REASONS, QuantSignalRules } from '@intafaced/contracts';
import { add, div, formatAmount, mul, parseAmount, sub, type Amount } from '@intafaced/ledger-client/money';
import { exponentialAverage, simpleAverage } from './averages.js';
import type { Bar } from './bars.js';

export type RejectReason = (typeof QUANT_BACKTEST_REJECT_REASONS)[number];
export type Assumption = (typeof QUANT_BACKTEST_ASSUMPTIONS)[number];

export interface SimulationInput {
  /** Checked by `compileSignalRules` first: every number is set and in range. */
  readonly rules: QuantSignalRules;
  /** Closed bars inside the window, oldest first. A missing interval is simply absent. */
  readonly bars: readonly Bar[];
  /** One bar interval in milliseconds: a delay is counted in intervals, so a gap counts as the time it lasted. */
  readonly spanMs: number;
  readonly cash: Amount;
  readonly feeBps: number;
  /** Basis points against the order; may carry decimals. */
  readonly slippageBps: Amount;
  /** Whole bar intervals between the signal bar's close and its fill, counted on the clock, not on the bars that traded. */
  readonly delayBars: number;
  /** A margin account (ENGINE RK-5); absent, a cash account that never spends more than it holds. */
  readonly account?: MarginAccount | null;
}

/** Leverage, and the margin-call and stop-out levels as a percent of the margin used, all checked before the run. */
export interface MarginAccount {
  readonly leverage: Amount;
  readonly marginCallPercent: Amount;
  readonly stopOutPercent: Amount;
}

export interface MarginEvent {
  readonly ts: string;
  readonly kind: 'margin_call' | 'stop_out';
  readonly price: string;
  readonly marginLevelPercent: string;
}

export interface SimulatedTrade {
  readonly ts: string;
  readonly side: 'buy' | 'sell';
  readonly reason: 'signal' | 'stop_loss' | 'take_profit' | 'stop_out';
  readonly qty: string;
  readonly barPrice: string;
  readonly price: string;
  readonly fee: string;
  readonly slippage: string;
}

export interface SimulationResult {
  readonly trades: readonly SimulatedTrade[];
  readonly rejected: readonly { readonly ts: string; readonly side: 'buy' | 'sell'; readonly reason: RejectReason }[];
  readonly assumptions: readonly Assumption[];
  readonly equity: readonly { readonly ts: string; readonly equity: string; readonly marginLevelPercent?: string | null }[];
  readonly marginEvents: readonly MarginEvent[];
  readonly totals: {
    readonly startCash: string;
    readonly gross: string;
    readonly fees: string;
    readonly slippage: string;
    readonly net: string;
    readonly endEquity: string;
    readonly openQty: string;
  };
}

const BPS = parseAmount('10000');

/** A fee in basis points of a non-negative amount, rounded up so a fee is never under-charged. */
function bpsOf(amount: Amount, bps: number): Amount {
  return (amount * BigInt(bps) + 9_999n) / 10_000n;
}

function abs(value: Amount): Amount {
  return value < 0n ? -value : value;
}
const HUNDRED = parseAmount('100');
/** Four decimal places in the scaled unit, so a margin level reads like every other percent on the result. */
const PERCENT_CUT = parseAmount('0.0001');

interface Pending {
  readonly side: 'buy' | 'sell';
  /** The earliest bar open it may fill at. */
  readonly dueMs: number;
}

/**
 * The bar loop (ENGINE BT-2), long only on spot (RK-5: no short without a published rule). For each bar, in order:
 * an order due by its open fills at the open; a held position's stop loss and take profit are matched against the bar
 * (BT-5: a gap through a level fills at the open, and when one bar reaches both the stop is taken first); the strategy
 * reads the averages up to this close and queues an order on a cross, due at the open `1 + delay` intervals later; the
 * position is marked and one equity point recorded. A missing interval has no bar, so nothing ever fills inside it:
 * an order waits for the next bar that exists (BT-3). The averages run over the bars that traded; a gap is skipped,
 * never filled forward. An order that cannot fill is listed with its reason. Deterministic: no clock, no randomness,
 * exact decimals.
 */
export function simulateSignalRules(input: SimulationInput): SimulationResult {
  const { rules, bars } = input;
  const closes = bars.map((bar) => bar.close);
  const average = rules.signal.average === 'ema' ? exponentialAverage : simpleAverage;
  const fast = average(closes, Number(rules.signal.fast));
  const slow = average(closes, Number(rules.signal.slow));
  const slip = div(input.slippageBps, BPS, 'half-up');
  const stopLoss = rules.exit.stopLossPercent ? div(parseAmount(rules.exit.stopLossPercent), HUNDRED, 'half-up') : null;
  const takeProfit = rules.exit.takeProfitPercent ? div(parseAmount(rules.exit.takeProfitPercent), HUNDRED, 'half-up') : null;

  let cash = input.cash;
  let qty = 0n;
  let entry: Amount | null = null;
  let pending: Pending | null = null;
  // Gross is the same trades at the bars' own prices, before fees and slippage.
  let grossCash = input.cash;
  let fees = 0n;
  let slippage = 0n;
  const trades: SimulatedTrade[] = [];
  const rejected: { ts: string; side: 'buy' | 'sell'; reason: RejectReason }[] = [];
  const applied = new Set<Assumption>(['long_only', 'averages_over_traded_bars']);
  const equity: { ts: string; equity: string; marginLevelPercent?: string | null }[] = [];
  const account = input.account ?? null;
  const marginEvents: MarginEvent[] = [];
  // The margin the open position took at entry, and whether this position has had its margin call.
  let used = 0n;
  let called = false;
  if (account) applied.add('margin_level_at_bar_low');

  /** Equity over the margin used, in percent, four places cut toward zero; null with no position. */
  function levelAt(price: Amount): Amount | null {
    if (!account || qty === 0n || used === 0n) return null;
    const exact = div(mul(add(cash, mul(qty, price, 'half-up')), HUNDRED, 'floor'), used, 'floor');
    return (exact / PERCENT_CUT) * PERCENT_CUT;
  }

  /** The price at which the margin level falls to `percent`: equity there is that share of the margin used. */
  function priceAtLevel(percent: Amount): Amount {
    return div(sub(mul(used, div(percent, HUNDRED, 'floor'), 'ceil'), cash), qty, 'ceil');
  }

  /** What an order's notional takes from the account: all of it on cash, one leverage-th of it on margin. */
  function marginFor(notional: Amount): Amount {
    return account ? div(notional, account.leverage, 'ceil') : notional;
  }

  function sizeAt(price: Amount): Amount {
    const value = parseAmount(rules.sizing.value);
    if (rules.sizing.kind === 'quantity') return value;
    const budget = rules.sizing.kind === 'cash' ? value : mul(cash, div(value, HUNDRED, 'floor'), 'floor');
    // The budget pays the order's margin (all of it on a cash account, one leverage-th on margin) and its fee, so the
    // whole order stays inside the budget; rounding can leave it one unit over.
    const perUnit = add(marginFor(price), bpsOf(price, input.feeBps));
    const size = div(budget, perUnit, 'floor');
    const cost = (q: Amount) => {
      const notional = mul(q, price, 'half-up');
      return add(marginFor(notional), bpsOf(notional, input.feeBps));
    };
    return cost(size) > budget ? size - 1n : size;
  }

  function fill(i: number, side: 'buy' | 'sell', reason: SimulatedTrade['reason'], barPrice: Amount, slipped: boolean): void {
    const bar = bars[i]!;
    const ts = new Date(bar.openTimeMs).toISOString();
    const move = slipped ? mul(barPrice, slip, 'ceil') : 0n;
    const price = side === 'buy' ? add(barPrice, move) : sub(barPrice, move);
    const size = side === 'buy' ? sizeAt(price) : qty;
    if (size <= 0n) {
      rejected.push({ ts, side, reason: 'no_size' });
      return;
    }
    const notional = mul(size, price, 'half-up');
    const barNotional = mul(size, barPrice, 'half-up');
    const fee = bpsOf(notional, input.feeBps);
    const margin = marginFor(notional);
    if (side === 'buy' && add(margin, fee) > cash) {
      rejected.push({ ts, side, reason: 'insufficient_cash' });
      return;
    }
    if (side === 'buy') {
      // On margin the rest of the notional is borrowed: cash goes below zero by it and equity carries the position.
      cash = sub(cash, add(notional, fee));
      used = margin;
      called = false;
      grossCash = sub(grossCash, barNotional);
      qty = add(qty, size);
      entry = price;
    } else {
      cash = add(cash, sub(notional, fee));
      grossCash = add(grossCash, barNotional);
      qty = 0n;
      entry = null;
      used = 0n;
    }
    fees = add(fees, fee);
    slippage = add(slippage, abs(sub(notional, barNotional)));
    trades.push({
      ts,
      side,
      reason,
      qty: formatAmount(size),
      barPrice: formatAmount(barPrice),
      price: formatAmount(price),
      fee: formatAmount(fee),
      slippage: formatAmount(abs(sub(notional, barNotional))),
    });
  }

  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i]!;
    // `fill` never touches `pending`, so reading it through a typed local is exact.
    const atOpen = pending as Pending | null;
    if (atOpen && bar.openTimeMs >= atOpen.dueMs) {
      fill(i, atOpen.side, 'signal', bar.open, true);
      pending = null;
    }
    // Margin, against the bar's low (the worst it reached): the margin call is recorded once per position, and a
    // stop-out closes the whole position at the price that reached its level, or at the open when the bar gapped past it.
    let stoppedOut = false;
    if (account && qty > 0n) {
      const callAt = priceAtLevel(account.marginCallPercent);
      const stopAt = priceAtLevel(account.stopOutPercent);
      const ts = new Date(bar.openTimeMs).toISOString();
      const event = (kind: MarginEvent['kind'], at: Amount) => {
        const price = bar.open <= at ? bar.open : at;
        marginEvents.push({ ts, kind, price: formatAmount(price), marginLevelPercent: formatAmount(levelAt(price) ?? 0n) });
        return price;
      };
      if (!called && bar.low <= callAt) {
        event('margin_call', callAt);
        called = true;
      }
      if (bar.low <= stopAt) {
        if (stopLoss !== null || takeProfit !== null) applied.add('stop_out_before_exits');
        // The event carries the bar price that reached the level; the sell fills there less slippage, like any order.
        fill(i, 'sell', 'stop_out', event('stop_out', stopAt), true);
        stoppedOut = true;
        // The position is closed, so a sell the strategy queued for it has nothing left to sell: it is dropped and the
        // strategy may enter again on this bar's close.
        if ((pending as Pending | null)?.side === 'sell') pending = null;
        // A bar that gaps through the stop-out can close below the margin posted; the run says so.
        if (cash < 0n) applied.add('loss_beyond_margin');
      }
    }
    // Exits on a held position. An entry at this bar's open is held for the rest of the bar.
    if (!stoppedOut && qty > 0n && entry !== null) {
      const stop = stopLoss === null ? null : sub(entry, mul(entry, stopLoss, 'half-up'));
      const target = takeProfit === null ? null : add(entry, mul(entry, takeProfit, 'half-up'));
      const stopHit = stop !== null && bar.low <= stop;
      const targetHit = target !== null && bar.high >= target;
      if (stopHit) {
        if (targetHit) applied.add('stop_loss_first');
        fill(i, 'sell', 'stop_loss', bar.open <= stop ? bar.open : stop, true);
      } else if (targetHit) {
        applied.add('take_profit_without_slippage');
        fill(i, 'sell', 'take_profit', bar.open >= target ? bar.open : target, false);
      }
    }
    // The strategy, on this close: a cross of the fast average over the slow one.
    const f: Amount | null = fast[i] ?? null;
    const s: Amount | null = slow[i] ?? null;
    const pf: Amount | null = i > 0 ? (fast[i - 1] ?? null) : null;
    const ps: Amount | null = i > 0 ? (slow[i - 1] ?? null) : null;
    if (pending === null && f !== null && s !== null && pf !== null && ps !== null) {
      const crossedUp: boolean = pf <= ps && f > s;
      const crossedDown: boolean = pf >= ps && f < s;
      const side: 'buy' | 'sell' | null = crossedUp && qty === 0n ? 'buy' : crossedDown && qty > 0n ? 'sell' : null;
      if (side) pending = { side, dueMs: bar.openTimeMs + (1 + input.delayBars) * input.spanMs };
    }
    const point = { ts: new Date(bar.openTimeMs).toISOString(), equity: formatAmount(add(cash, mul(qty, bar.close, 'half-up'))) };
    if (account) {
      const level = levelAt(bar.close);
      equity.push({ ...point, marginLevelPercent: level === null ? null : formatAmount(level) });
    } else equity.push(point);
  }
  const unfilled = pending as Pending | null;
  if (unfilled) rejected.push({ ts: new Date(unfilled.dueMs).toISOString(), side: unfilled.side, reason: 'unfilled_at_window_end' });
  if (qty > 0n) applied.add('open_position_marked_at_last_close');

  const last = bars[bars.length - 1];
  const mark = last ? mul(qty, last.close, 'half-up') : 0n;
  const endEquity = add(cash, mark);
  return {
    trades,
    rejected,
    equity,
    marginEvents,
    assumptions: [...applied],
    totals: {
      startCash: formatAmount(input.cash),
      gross: formatAmount(sub(add(grossCash, mark), input.cash)),
      fees: formatAmount(fees),
      slippage: formatAmount(slippage),
      net: formatAmount(sub(endEquity, input.cash)),
      endEquity: formatAmount(endEquity),
      openQty: formatAmount(qty),
    },
  };
}
