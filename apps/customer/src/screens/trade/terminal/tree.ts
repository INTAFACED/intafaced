/**
 * The Terminal's one order tree as data (TRD-0668): every kind of order the person has, each kind a branch, each parent
 * order with its children, ownership and open exposure. Built only from what the services answered: the order book's
 * open and closed orders, the algo schedules each re-read from `algo.get`, and the RFQ board. A kind the platform does not
 * run (care orders, routed orders) is a branch with no orders and the reason, never a sample. Pure and React-free.
 */
import type { Order } from '../../../features/trade/trade-api';
import { dec, str, sub, times, ZERO } from '../../../data/decimal';
import type { RfqBoard } from '../rooms/api';
import type { ParentRead } from '../execution/data';

export type BranchKind = 'care' | 'synthetic' | 'algo' | 'rfq' | 'routed';
export const BRANCHES: readonly BranchKind[] = ['care', 'synthetic', 'algo', 'rfq', 'routed'];

/** Open exposure: an amount and its asset. A market order or an unpriced request has it in the base asset only. */
export interface Exposure {
  amount: string;
  asset: string;
}

export interface TreeChild {
  id: string;
  /** The child's own order id (an algo slice) or quote id (an RFQ quote). */
  ref: string;
  kind: 'slice' | 'quote';
  index: number;
  qty: string | null;
  price: string | null;
  /** The child order's state as the book reads it, or the quote's lifecycle; null when the book does not list it. */
  state: string | null;
}

export interface TreeParent {
  id: string;
  branch: BranchKind;
  /** The order, schedule or request id the person can quote to support. */
  ref: string;
  /** What kind of parent: an order type (stop, stop-limit…), an algo kind (twap, vwap…) or "rfq". */
  type: string;
  symbol: string;
  side: 'buy' | 'sell';
  state: string;
  /** Every order in this view is on the person's own account. */
  owner: 'you';
  exposure: Exposure | null;
  children: TreeChild[];
}

export interface Branch {
  kind: BranchKind;
  parents: TreeParent[];
  /** Why the branch is empty for a kind the platform does not run; null for a kind that is read. */
  notRun: 'care_desk_not_open' | 'no_second_book' | null;
}

const PLAIN_TYPES = new Set(['limit', 'market']);
/** Orders with a trigger or linked legs (stop, stop-limit, take-profit, OCO, bracket exit) are held by the platform: synthetic. */
export const isSynthetic = (order: Order): boolean => !PLAIN_TYPES.has(order.type) || Boolean(order.exit);

const LIVE_ORDER = new Set(['open']);
const LIVE_ALGO = new Set(['active', 'paused', 'halted']);
const LIVE_RFQ = new Set(['open', 'accepted']);

function quoteOf(symbol: string): string {
  return symbol.split('/')[1] ?? '';
}
function baseOf(symbol: string): string {
  return symbol.split('/')[0] ?? symbol;
}

/** What is still to fill, priced at the limit when there is one, otherwise in the base asset. */
export function exposureOf(remaining: string | null, price: string | null, symbol: string): Exposure | null {
  const left = dec(remaining);
  if (left === null) return null;
  const clamped = left < ZERO ? ZERO : left;
  const at = dec(price);
  if (at === null) return { amount: str(clamped), asset: baseOf(symbol) };
  return { amount: str(times(clamped, at)), asset: quoteOf(symbol) };
}

function orderState(order: Order): string {
  if (order.recoveryRequired) return 'recovery';
  if (order.status === 'open') return dec(order.filled)! > ZERO ? 'partial' : 'open';
  return order.status === 'closed' ? 'filled' : order.status === 'canceled' ? 'cancelled' : order.status;
}

export function buildTree(input: {
  open: readonly Order[];
  closed: readonly Order[];
  parents: readonly ParentRead[];
  rfq: RfqBoard | null;
}): Branch[] {
  const byId = new Map<string, Order>();
  for (const o of [...input.closed, ...input.open]) byId.set(o.id, o);
  const childIds = new Set<string>();
  for (const p of input.parents) if (p.ok) for (const c of p.parent.children ?? []) childIds.add(c.orderId);

  const algo: TreeParent[] = input.parents.flatMap((p) => {
    if (!p.ok || !LIVE_ALGO.has(p.parent.status)) return [];
    const { parent, progress } = p;
    const filled = progress?.filledQty ?? '0';
    const left = dec(parent.totalQty) !== null && dec(filled) !== null ? str(sub(dec(parent.totalQty)!, dec(filled)!)) : null;
    return [
      {
        id: `algo:${parent.id}`,
        branch: 'algo' as const,
        ref: parent.id,
        type: parent.kind,
        symbol: parent.symbol,
        side: parent.side,
        state: parent.status,
        owner: 'you' as const,
        exposure: exposureOf(left, parent.limitPrice, parent.symbol),
        children: (parent.children ?? []).map((c) => {
          const order = byId.get(c.orderId);
          return {
            id: `slice:${c.orderId}`,
            ref: c.orderId,
            kind: 'slice' as const,
            index: c.sliceIndex,
            qty: c.qty ?? order?.amount ?? null,
            price: c.price ?? order?.price ?? null,
            state: order ? orderState(order) : null,
          };
        }),
      },
    ];
  });

  const synthetic: TreeParent[] = input.open
    .filter((o) => LIVE_ORDER.has(o.status) && isSynthetic(o) && !childIds.has(o.id))
    .map((o) => ({
      id: `order:${o.id}`,
      branch: 'synthetic' as const,
      ref: o.id,
      type: o.exit ? o.exit.kind : o.type,
      symbol: o.symbol,
      side: o.side,
      state: orderState(o),
      owner: 'you' as const,
      exposure: exposureOf(o.remaining, o.price, o.symbol),
      children: [],
    }));

  const rfq: TreeParent[] = (input.rfq?.groups ?? []).flatMap((g) =>
    g.requests
      .filter((r) => LIVE_RFQ.has(r.status))
      .map((r) => {
        const symbol = `${r.baseAsset}/${r.quoteAsset}`;
        const best = r.quotes.find((q) => q.best) ?? null;
        return {
          id: `rfq:${r.rfqId}`,
          branch: 'rfq' as const,
          ref: r.rfqId,
          type: 'rfq',
          symbol,
          side: r.side,
          state: r.status,
          owner: 'you' as const,
          exposure: exposureOf(r.qty, best?.quotedPrice ?? null, symbol),
          children: r.quotes.map((q) => ({
            id: `quote:${q.quoteId}`,
            ref: q.quoteId,
            kind: 'quote' as const,
            index: q.rank,
            qty: r.qty,
            price: q.quotedPrice,
            state: q.lifecycle,
          })),
        };
      }),
  );

  return [
    { kind: 'care', parents: [], notRun: 'care_desk_not_open' },
    { kind: 'synthetic', parents: synthetic, notRun: null },
    { kind: 'algo', parents: algo, notRun: null },
    { kind: 'rfq', parents: rfq, notRun: null },
    { kind: 'routed', parents: [], notRun: 'no_second_book' },
  ];
}
