import { SCALE, add, compare, dec, ratio, sub, sumOf, str, times, toFixedString, type Scaled } from '../../../data/decimal';
import type { SampleBot, SampleBotFrequency, SampleBotsRows } from '../../../preview/fixtures/bots';

/**
 * The sums behind the Trading bots Preview: grid lines, DCA budgets, TWAP slices and running times. Everything is a decimal string or a
 * scaled bigint (data/decimal.ts); no money value becomes a JS number. The only plain numbers are counts and pixel positions.
 */

export const GRID_MIN = 2;
export const GRID_MAX = 100;

export type GridProblem = 'range' | 'grids' | 'invest' | null;

export interface GridLevel {
  /** Price of the line as a decimal string. */
  readonly price: string;
  /** Where it sits between the bottom (0) and top (1) of the range, for drawing only. */
  readonly position: number;
  readonly side: 'buy' | 'sell' | 'at';
}

export interface GridPlan {
  readonly problem: GridProblem;
  /** Gap between two neighbouring orders in USD. */
  readonly step: string | null;
  /** The same gap as a ratio of the sample price. */
  readonly stepRatio: string | null;
  /** USD in each order. */
  readonly perOrder: string | null;
  readonly levels: readonly GridLevel[];
  readonly buys: number;
  readonly sells: number;
  /** Where the sample price sits in the range for drawing (can fall outside 0 to 1), or null. */
  readonly pricePosition: number | null;
  readonly priceInRange: boolean;
}

const EMPTY_GRID: GridPlan = {
  problem: null,
  step: null,
  stepRatio: null,
  perOrder: null,
  levels: [],
  buys: 0,
  sells: 0,
  pricePosition: null,
  priceInRange: false,
};

/** A whole number from a typed field ("24"), or null when it is not one. */
export function wholeNumber(value: string): number | null {
  return /^\d{1,6}$/.test(value.trim()) ? Number(value.trim()) : null;
}

/** A pixel fraction from two scaled values. Drawing only: never shown as money. */
function fraction(part: Scaled, whole: Scaled): number {
  const r = ratio(part, whole);
  return r === null ? 0 : Number(r / 10n ** 12n) / 1e6;
}

export function planGrid(input: { low: string; high: string; grids: string; invest: string; price: string }): GridPlan {
  const low = dec(input.low);
  const high = dec(input.high);
  const price = dec(input.price);
  const grids = wholeNumber(input.grids);
  const invest = dec(input.invest);
  if (low === null || high === null || low <= 0n || compare(high, low) <= 0) return { ...EMPTY_GRID, problem: 'range' };
  if (grids === null || grids < GRID_MIN || grids > GRID_MAX) return { ...EMPTY_GRID, problem: 'grids' };
  if (invest === null || invest <= 0n) return { ...EMPTY_GRID, problem: 'invest' };

  const count = dec(String(grids)) as Scaled;
  const span = sub(high, low);
  const stepValue = ratio(span, count) as Scaled;
  const levels: GridLevel[] = [];
  let buys = 0;
  let sells = 0;
  for (let i = 0; i <= grids; i += 1) {
    const at = i === grids ? high : add(low, times(stepValue, dec(String(i)) as Scaled));
    const side = price === null ? 'at' : compare(at, price) < 0 ? 'buy' : compare(at, price) > 0 ? 'sell' : 'at';
    if (side === 'buy') buys += 1;
    if (side === 'sell') sells += 1;
    levels.push({ price: toFixedString(at, 2), position: fraction(sub(at, low), span), side });
  }
  const mid = price ?? add(low, ratio(span, 2n * SCALE) as Scaled);
  return {
    problem: null,
    step: toFixedString(stepValue, 2),
    stepRatio: str(ratio(stepValue, mid) as Scaled),
    perOrder: toFixedString(ratio(invest, count) as Scaled, 2),
    levels,
    buys,
    sells,
    pricePosition: price === null ? null : fraction(sub(price, low), span),
    priceInRange: price !== null && compare(price, low) >= 0 && compare(price, high) <= 0,
  };
}

export interface DcaPlan {
  readonly problem: 'perBuy' | 'buys' | null;
  readonly total: string | null;
  readonly buys: number;
  /** Whole days from the first buy to the last, for the one-line summary. */
  readonly days: number;
}

const FREQUENCY_HOURS: Readonly<Record<SampleBotFrequency, number>> = { hourly: 1, daily: 24, weekly: 24 * 7, monthly: 24 * 30 };

export function planDca(input: { perBuy: string; buys: string; frequency: SampleBotFrequency }): DcaPlan {
  const perBuy = dec(input.perBuy);
  const buys = wholeNumber(input.buys);
  if (perBuy === null || perBuy <= 0n) return { problem: 'perBuy', total: null, buys: 0, days: 0 };
  if (buys === null || buys < 1 || buys > 1000) return { problem: 'buys', total: null, buys: 0, days: 0 };
  const total = times(perBuy, dec(String(buys)) as Scaled);
  const hours = (buys - 1) * FREQUENCY_HOURS[input.frequency];
  return { problem: null, total: toFixedString(total, 2), buys, days: Math.ceil(hours / 24) };
}

export interface TwapPlan {
  readonly problem: 'total' | 'hours' | 'interval' | null;
  readonly slices: number;
  readonly perSlice: string | null;
}

export function planTwap(input: { total: string; hours: string; intervalMinutes: string }): TwapPlan {
  const total = dec(input.total);
  const hours = wholeNumber(input.hours);
  const interval = wholeNumber(input.intervalMinutes);
  if (total === null || total <= 0n) return { problem: 'total', slices: 0, perSlice: null };
  if (hours === null || hours < 1 || hours > 72) return { problem: 'hours', slices: 0, perSlice: null };
  if (interval === null || interval < 1 || interval > hours * 60) return { problem: 'interval', slices: 0, perSlice: null };
  const slices = Math.max(1, Math.round((hours * 60) / interval));
  return { problem: null, slices, perSlice: toFixedString(ratio(total, dec(String(slices)) as Scaled) as Scaled, 2) };
}

/** Is `amount` more than `balance`? Both are decimal strings; an empty or broken amount is not "more". */
export function exceeds(amount: string | null, balance: string): boolean {
  const a = dec(amount);
  const b = dec(balance);
  return a !== null && b !== null && compare(a, b) > 0;
}

/** Whole days, hours and minutes between two timestamps, as { days, hours, minutes }. Never negative. */
export function elapsed(from: string, to: string): { days: number; hours: number; minutes: number } {
  const ms = Math.max(0, Date.parse(to) - Date.parse(from));
  const minutes = Math.floor(ms / 60000);
  return { days: Math.floor(minutes / 1440), hours: Math.floor((minutes % 1440) / 60), minutes: minutes % 60 };
}

export interface Totals {
  readonly invested: string;
  readonly profit: string;
  /** Profit as a ratio of money invested in bots that report a profit (a TWAP does not). Null when nothing is invested. */
  readonly profitRatio: string | null;
  readonly running: number;
  readonly fills: number;
}

/** The sums over a list of bots. TWAP money counts as invested but has no profit, so it stays out of the ratio. */
export function totals(bots: readonly SampleBot[]): Totals {
  const invested = sumOf(bots.map((bot) => dec(bot.invested) ?? 0n));
  const profit = sumOf(bots.map((bot) => (bot.profit === null ? 0n : (dec(bot.profit) ?? 0n))));
  const earning = sumOf(bots.filter((bot) => bot.profit !== null).map((bot) => dec(bot.invested) ?? 0n));
  const r = earning === 0n ? null : ratio(profit, earning);
  return {
    invested: toFixedString(invested, 2),
    profit: toFixedString(profit, 2),
    profitRatio: r === null ? null : str(r),
    running: bots.filter((bot) => bot.state === 'running').length,
    fills: bots.reduce((sum, bot) => sum + bot.fills, 0),
  };
}

/** One bot's profit as a ratio of what it put in, or null when it has no profit figure. */
export function botRatio(bot: SampleBot): string | null {
  const profit = dec(bot.profit);
  const invested = dec(bot.invested);
  if (profit === null || invested === null) return null;
  const r = ratio(profit, invested);
  return r === null ? null : str(r);
}

export function marketFor(rows: SampleBotsRows, pair: string) {
  return rows.markets.find((market) => market.pair === pair) ?? rows.markets[0]!;
}
