/**
 * THE RAMP PARTNER'S OWN REPORT (J-bank-28 #3, BK-ord-01).
 *
 * Ramp orders are the partner's (OWNER 226): the partner opens each payment, the payer approves it on the partner's page,
 * and the partner says it was paid or sent back. So the finance desk reads ramp metrics from the partner's own report,
 * never from svc-bank's rows: orders by the state the partner gives them, the partner's health, and the orders whose
 * quote ran out at the partner before the payer approved. With no partner wired there is no report, and the desk says
 * "no data", never zero.
 *
 * On the stack the partner is the TEST pay-in stand-in (`payin-sim.ts`), and this is its book: what it opened, what its
 * page saw approved, and what it said was paid or returned, kept in its process. It holds no money.
 */

export const RAMP_PARTNER_ORDER_STATES = ['opened', 'approved', 'paid', 'returned', 'expired'] as const;
export type RampPartnerOrderState = (typeof RAMP_PARTNER_ORDER_STATES)[number];

/** One order whose quote ran out at the partner before the payer approved it. */
export interface RampPartnerQuoteExpiry {
  readonly orderId: string;
  readonly expiredAt: Date;
}

/** What the partner reports of its ramp orders, as it keeps them. */
export interface RampPartnerReport {
  readonly label: string;
  readonly asOf: Date;
  /** The partner's own word on whether it is taking payments. The TEST stand-in in this process always is. */
  readonly health: 'operational';
  readonly lastOpenedAt: Date | null;
  readonly lastPaidAt: Date | null;
  /** Every state, with zero where the partner has none in it. */
  readonly orders: Readonly<Record<RampPartnerOrderState, number>>;
  readonly quoteExpiries: { readonly count: number; readonly latest: readonly RampPartnerQuoteExpiry[] };
}

/** The stand-in's book: each order's events, as the partner itself saw them. */
export interface RampPartnerBook {
  opened(orderId: string, quoteExpiresAt: Date | null): void;
  approved(orderId: string): void;
  paid(orderId: string): void;
  returned(orderId: string): void;
  report(now?: Date): RampPartnerReport;
}

interface Order {
  openedAt: Date;
  quoteExpiresAt: Date | null;
  approvedAt: Date | null;
  paidAt: Date | null;
  returnedAt: Date | null;
}

/** The most orders the stand-in keeps; past it the oldest is dropped, so a long-running stack never grows without bound. */
const MAX_ORDERS = 100_000;
/** How many of the newest quote expiries the report lists by order. */
const LATEST_EXPIRIES = 20;

function stateOf(order: Order, now: Date): RampPartnerOrderState {
  if (order.returnedAt) return 'returned';
  if (order.paidAt) return 'paid';
  if (order.approvedAt) return 'approved';
  if (order.quoteExpiresAt && order.quoteExpiresAt.getTime() <= now.getTime()) return 'expired';
  return 'opened';
}

export function rampPartnerBook(label: string, clock: () => Date = () => new Date()): RampPartnerBook {
  const orders = new Map<string, Order>();
  const at = (orderId: string): Order | null => orders.get(orderId) ?? null;
  return {
    opened(orderId, quoteExpiresAt) {
      if (orders.has(orderId)) return;
      if (orders.size >= MAX_ORDERS) orders.delete(orders.keys().next().value!);
      orders.set(orderId, { openedAt: clock(), quoteExpiresAt, approvedAt: null, paidAt: null, returnedAt: null });
    },
    approved(orderId) {
      const order = at(orderId);
      if (order && !order.approvedAt) order.approvedAt = clock();
    },
    paid(orderId) {
      const order = at(orderId);
      if (order && !order.paidAt) order.paidAt = clock();
    },
    returned(orderId) {
      const order = at(orderId);
      if (order && order.paidAt && !order.returnedAt) order.returnedAt = clock();
    },
    report(now = clock()) {
      const counts = Object.fromEntries(RAMP_PARTNER_ORDER_STATES.map((s) => [s, 0])) as Record<RampPartnerOrderState, number>;
      const expiries: RampPartnerQuoteExpiry[] = [];
      let lastOpenedAt: Date | null = null;
      let lastPaidAt: Date | null = null;
      for (const [orderId, order] of orders) {
        const state = stateOf(order, now);
        counts[state] += 1;
        if (state === 'expired') expiries.push({ orderId, expiredAt: order.quoteExpiresAt! });
        if (!lastOpenedAt || order.openedAt > lastOpenedAt) lastOpenedAt = order.openedAt;
        if (order.paidAt && (!lastPaidAt || order.paidAt > lastPaidAt)) lastPaidAt = order.paidAt;
      }
      expiries.sort((a, b) => b.expiredAt.getTime() - a.expiredAt.getTime());
      return {
        label,
        asOf: now,
        health: 'operational',
        lastOpenedAt,
        lastPaidAt,
        orders: counts,
        quoteExpiries: { count: expiries.length, latest: expiries.slice(0, LATEST_EXPIRIES) },
      };
    },
  };
}
