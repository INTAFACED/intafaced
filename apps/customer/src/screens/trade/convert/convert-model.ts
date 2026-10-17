/**
 * Convert's pure rules (UI-SPEC 5.8): which assets can be swapped for which, and how an amount in the "From" asset
 * becomes the base-coin quantity the quote call takes. Exact bigint arithmetic only.
 */
import { fmtAmount, type MarketRow } from '../../../data';
import { roundScaled } from '../../../data/decimal';
import { planOrder, type OrderPlan, type PlanInput } from '../buy/order-plan';
import { ceilPlaces, dec, floorToStep, str } from '../buy/trade-math';

export interface Edge {
  from: string;
  to: string;
  market: MarketRow;
  /** `buy` = From is the market's quote asset (the quote call asks for the base quantity); `sell` = From is the coin. */
  side: 'buy' | 'sell';
}

/** Every direct swap the open markets allow, both ways. There is no routing through a third asset. */
export function edges(markets: readonly MarketRow[]): Edge[] {
  const list: Edge[] = [];
  for (const market of markets) {
    if (!market.orderable) continue;
    list.push({ from: market.quote, to: market.base, market, side: 'buy' });
    list.push({ from: market.base, to: market.quote, market, side: 'sell' });
  }
  return list;
}

const LEADING = ['USDT', 'USDC', 'BTC', 'ETH', 'IFC'];
const rank = (asset: string) => {
  const at = LEADING.indexOf(asset);
  return at >= 0 ? at : LEADING.length;
};
const byRank = (a: string, b: string) => rank(a) - rank(b) || a.localeCompare(b);

/** Assets that can be the "From" side: they appear in at least one open market. */
export function fromAssets(all: readonly Edge[]): string[] {
  return [...new Set(all.map((edge) => edge.from))].sort(byRank);
}

/** Assets that can be the "To" side for a given From. */
export function toAssets(all: readonly Edge[], from: string): string[] {
  return [...new Set(all.filter((edge) => edge.from === from).map((edge) => edge.to))].sort(byRank);
}

/** The market that swaps From for To directly: USDT before USDC if both exist, so the choice is the same every time. */
export function edgeFor(all: readonly Edge[], from: string, to: string): Edge | null {
  const matches = all.filter((edge) => edge.from === from && edge.to === to);
  matches.sort((a, b) => byRank(a.market.quote, b.market.quote));
  return matches[0] ?? null;
}

/** First From and To to show: the asset in the link if it can be reached from a dollar coin, else USDT to BTC, else whatever exists. */
export function defaultPair(
  all: readonly Edge[],
  asked: { asset?: string | null; from?: string | null; to?: string | null },
): { from: string; to: string } | null {
  if (asked.from && asked.to && edgeFor(all, asked.from, asked.to)) return { from: asked.from, to: asked.to };
  // "?from=BTC" alone means sell BTC: pick a dollar coin to receive, else any market that takes it.
  if (asked.from && !asked.to) {
    const sell =
      all.find((edge) => edge.from === asked.from && (edge.to === 'USDT' || edge.to === 'USDC')) ??
      all.find((edge) => edge.from === asked.from);
    if (sell) return { from: sell.from, to: sell.to };
  }
  const wanted = asked.asset ?? null;
  if (wanted) {
    for (const pay of ['USDT', 'USDC']) if (edgeFor(all, pay, wanted)) return { from: pay, to: wanted };
    const sellable = all.find((edge) => edge.from === wanted);
    if (sellable) return { from: wanted, to: sellable.to };
  }
  const first = all.find((edge) => edge.from === 'USDT' && edge.to === 'BTC') ?? all.find((edge) => edge.from === 'USDT') ?? all[0];
  return first ? { from: first.from, to: first.to } : null;
}

export interface ConvertPlanInput {
  edge: Edge;
  /** What was typed, in the From asset. */
  amount: string;
  /** Last price used to size the quantity (the ask when paying with the quote asset) and to check the minimum order value. */
  price: string | null;
  minAmount: string | null;
  minCost: string | null;
}

export type ConvertPlan = OrderPlan;

/** The base-coin quantity to ask a quote for, whole lots rounded DOWN, or the plain reason it cannot be asked. */
export function planConvert(input: ConvertPlanInput): ConvertPlan {
  const { edge } = input;
  const request: PlanInput = {
    unit: edge.side === 'buy' ? 'quote' : 'base',
    amount: input.amount,
    price: input.price,
    lot: edge.market.lotSize,
    minAmount: input.minAmount ?? edge.market.minAmount,
    minCost: input.minCost,
    baseAsset: edge.market.base,
    quoteAsset: edge.market.quote,
  };
  return planOrder(request);
}

/**
 * A first quote for "pay 10 USDT" prices 0.0038 ETH at 9.91: one lot short of what was typed. The unit cost it showed
 * (spread and book depth included) sizes a second try. The second is used only if it still costs no more than typed.
 */
export function refinedQty(input: { qty: string; spent: string; typed: string; lot: string }): string | null {
  const qty = dec(input.qty);
  const spent = dec(input.spent);
  const typed = dec(input.typed);
  const lot = dec(input.lot);
  if (qty === null || spent === null || typed === null || lot === null || spent <= 0n || spent >= typed) return null;
  const next = floorToStep((qty * typed) / spent, lot);
  return next > qty ? str(next) : null;
}

/**
 * The quote added our spread on top and now costs more than the budget: the next, strictly smaller quantity that should
 * fit (proportional to the overshoot, rounded down to a lot), or null when no whole lot is left.
 */
export function steppedDownQty(input: { qty: string; spent: string; cap: string; lot: string }): string | null {
  const qty = dec(input.qty);
  const spent = dec(input.spent);
  const cap = dec(input.cap);
  const lot = dec(input.lot);
  if (qty === null || spent === null || cap === null || lot === null || spent <= 0n || lot <= 0n || spent <= cap) return null;
  let next = floorToStep((qty * cap) / spent, lot);
  if (next >= qty) next = qty - lot; // always strictly smaller
  return next > 0n ? str(next) : null;
}

/** The most that may be spent: what was typed, and never more than the balance. */
export function spendCap(typed: string, available: string | null): string | null {
  const t = dec(typed);
  if (t === null) return null;
  const a = dec(available);
  return str(a !== null && a < t ? a : t);
}

/**
 * What the review shows for an amount: `pay` rounds UP to the asset's places (never show less than will leave the
 * account), `get` rounds DOWN (never promise more than arrives). Display only: the exact strings stay in the request.
 */
export function reviewAmount(value: string, places: number, rounding: 'pay' | 'get'): string {
  const exact = dec(value);
  if (exact === null) return value;
  const shown = rounding === 'pay' ? ceilPlaces(exact, places) : roundScaled(exact, places, 'down');
  return fmtAmount(str(shown), { places });
}
