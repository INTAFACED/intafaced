/**
 * Order book arithmetic: group levels by price step, running totals, depth bars and the buy/sell ratio.
 * Prices and amounts stay decimal strings; sums are bigint. Bar widths are whole permille strings (0 to 1000),
 * drawn by CSS (`scaleX(var(--depth) / 1000)`), so no float ever touches a price or an amount.
 */
import { formatAmount } from '../../../shared/money';
import { scaled } from './order-math';

/** [price, amount] as the service sends them. */
export type RawLevel = readonly [string, string];

export interface BookRow {
  price: string;
  amount: string;
  /** Running total of the base asset from the best price outward. */
  total: string;
  /** Bar width in permille of the widest row on screen, "0" to "1000". */
  depth: string;
}

export interface BookView {
  /** Highest price first, so the best (lowest) ask sits next to the mid price. */
  asks: BookRow[];
  /** Highest price first: the best bid is at the top, next to the mid price. */
  bids: BookRow[];
  bestBid: string | null;
  bestAsk: string | null;
  /** Total base asset on each side among the rows shown. */
  bidTotal: string;
  askTotal: string;
}

/** Merge levels into buckets of `group`: bids round down, asks round up, so a bucket never improves a price. */
export function groupLevels(
  levels: readonly RawLevel[],
  side: 'bid' | 'ask',
  group: string | null,
): Array<{ price: bigint; amount: bigint }> {
  const step = group === null ? null : scaled(group);
  const out = new Map<bigint, bigint>();
  const order: bigint[] = [];
  for (const [priceText, amountText] of levels) {
    const price = scaled(priceText);
    const amount = scaled(amountText);
    if (price === null || amount === null || price <= 0n || amount <= 0n) continue;
    let key = price;
    if (step !== null && step > 0n) {
      const floor = (price / step) * step;
      key = side === 'bid' || floor === price ? floor : floor + step;
    }
    const have = out.get(key);
    if (have === undefined) {
      out.set(key, amount);
      order.push(key);
    } else out.set(key, have + amount);
  }
  // Bids best (highest) first, asks best (lowest) first; the service already sends them that way, but merging
  // can reorder nothing, so sort once to be certain.
  order.sort((a, b) => (a === b ? 0 : (side === 'bid' ? a > b : a < b) ? -1 : 1));
  return order.map((price) => ({ price, amount: out.get(price)! }));
}

function withTotals(
  levels: Array<{ price: bigint; amount: bigint }>,
  limit: number,
): { rows: Array<{ price: bigint; amount: bigint; total: bigint }>; total: bigint } {
  let running = 0n;
  const rows = levels.slice(0, limit).map((level) => {
    running += level.amount;
    return { ...level, total: running };
  });
  return { rows, total: running };
}

const permille = (part: bigint, whole: bigint): string => (whole <= 0n ? '0' : ((part * 1000n) / whole).toString());

/** Build what the book panel draws: at most `rows` levels per side, grouped, with totals and bar widths. */
export function buildBook(bids: readonly RawLevel[], asks: readonly RawLevel[], group: string | null, rows: number): BookView {
  const bestBid = bids.length > 0 ? (bids[0]?.[0] ?? null) : null;
  const bestAsk = asks.length > 0 ? (asks[0]?.[0] ?? null) : null;
  const bidSide = withTotals(groupLevels(bids, 'bid', group), rows);
  const askSide = withTotals(groupLevels(asks, 'ask', group), rows);
  const widest = bidSide.total > askSide.total ? bidSide.total : askSide.total;
  const toRow = (row: { price: bigint; amount: bigint; total: bigint }): BookRow => ({
    price: formatAmount(row.price),
    amount: formatAmount(row.amount),
    total: formatAmount(row.total),
    depth: permille(row.total, widest),
  });
  return {
    asks: askSide.rows.map(toRow).reverse(),
    bids: bidSide.rows.map(toRow),
    bestBid,
    bestAsk,
    bidTotal: formatAmount(bidSide.total),
    askTotal: formatAmount(askSide.total),
  };
}

/** "50.4" for 504 permille of the buy side: the share of buy volume among the rows shown, to one decimal. Null with no volume. */
export function buyShare(bidTotal: string, askTotal: string): { buy: string; sell: string } | null {
  const bid = scaled(bidTotal);
  const ask = scaled(askTotal);
  if (bid === null || ask === null || bid + ask <= 0n) return null;
  const tenths = (bid * 1000n) / (bid + ask);
  const sellTenths = 1000n - tenths;
  const text = (value: bigint) => `${value / 10n}.${value % 10n}`;
  return { buy: text(tenths), sell: text(sellTenths) };
}
