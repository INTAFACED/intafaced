/**
 * A lead's own trading on the web (J-copy-bots-otc-04 #3 to #8; CB-copy-12 missions, CB-copy-14 lead trades and the lead
 * switch, CB-copy-15 lead trade views and copiers, CB-copy-16 lead limits, CB-copy-18 the lead account).
 *
 * A listed lead trades on the ordinary spot desk. Each order it sends with the lead switch (`lead: true` or `false` on
 * `POST /api/v1/orders`) is decided here before the order is placed and recorded once by its order id
 * (`trade.copy_lead_orders`):
 *
 *   · an iceberg is never a lead trade: recorded not-lead (`iceberg`) whatever the switch says;
 *   · the switch off: recorded not-lead (`switched_off`);
 *   · the switch on: a lead trade only inside the lead's instrument list (blank refuses
 *     `trade.copy_leader_instruments_not_set`), with a price (a market order can't be counted against a cap), at or
 *     above the owner's least venue balance to lead as the venue reports it (`trade.copy_leader_equity_below_min`),
 *     inside the owner's per-pair holding limit (a pair without one refuses `trade.copy_pair_limit_not_set`) and the
 *     owner's daily buy cap per owner day (blank refuses `trade.copy_leader_limit_not_set`).
 *
 * The copy driver copies a lead's fill unless its order is recorded not-lead; that fill is skipped with the reason
 * `not_lead_order` (copy-service.ts). A refusal writes nothing and places nothing.
 *
 * Money: none. The order itself is the ordinary order path, its hold and settlement included. Crash points: the row is
 * written before the order is placed, under the order's own id, so a crash or a refused place leaves a row for an order
 * that does not exist, and never a not-lead order without its row. Every read joins `trade.orders`, so such a row counts
 * for nothing. The limits count what an order commits: a live lead buy its whole price times size, a finished one only
 * what filled; a lead sell only what filled, so a sell that never runs frees no room.
 */
import type { Principal } from '@intafaced/auth';
import { add, compare, formatAmount, mul, parseAmount, sub, type Amount } from '@intafaced/ledger-client/money';
import type { Sql } from 'postgres';
import { CopyError } from './errors.js';
import { copyOwnerDay, type CopyOwnerDay } from './follow-rules.js';
import type { LeadVenueRead } from './lead-applications.js';

/** The owner's lead limits (CB-copy-16). Null: not set by the platform. */
export interface LeadLimits {
  /** The most a lead may buy in lead trades per owner day, in the pair's quote asset. */
  readonly dailyBuyCap: Amount | null;
  /** The most a lead may hold per pair in lead trades, by pair symbol (`BTC/USDT`), in its quote asset. */
  readonly pairHolding: ReadonlyMap<string, Amount> | null;
}

/** `TRADE_COPY_LEAD_DAILY_BUY_CAP`: blank is unset (null); anything but a decimal above zero throws. */
export function parseLeadDailyBuyCap(raw: string | undefined): Amount | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;
  const amount = parsePositive(trimmed);
  if (!amount) throw new Error('TRADE_COPY_LEAD_DAILY_BUY_CAP must be a decimal above zero or blank');
  return amount;
}

/** `TRADE_COPY_LEAD_PAIR_HOLDING_LIMITS`: a JSON object of pair to decimal string; blank is unset (null). */
export function parseLeadPairHolding(raw: string | undefined): ReadonlyMap<string, Amount> | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error('TRADE_COPY_LEAD_PAIR_HOLDING_LIMITS must be a JSON object of pair to decimal string, or blank');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('TRADE_COPY_LEAD_PAIR_HOLDING_LIMITS must be a JSON object of pair to decimal string, or blank');
  }
  const out = new Map<string, Amount>();
  for (const [pair, value] of Object.entries(parsed as Record<string, unknown>)) {
    const amount = typeof value === 'string' ? parsePositive(value.trim()) : null;
    if (!/^[A-Z0-9]+\/[A-Z0-9]+$/.test(pair) || !amount) {
      throw new Error(`TRADE_COPY_LEAD_PAIR_HOLDING_LIMITS: ${pair} must be a pair like BTC/USDT with a decimal above zero`);
    }
    out.set(pair, amount);
  }
  return out;
}

function parsePositive(text: string): Amount | null {
  if (!/^\d+(\.\d+)?$/.test(text)) return null;
  const amount = parseAmount(text);
  return compare(amount, parseAmount('0')) > 0 ? amount : null;
}

export type NotLeadReason = 'iceberg' | 'switched_off';

/** One order a listed lead sends with the lead switch, as the order path reads it before placing. */
export interface LeadOrderAsk {
  readonly orderId: string;
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  /** The limit price; null for a market order. */
  readonly price: Amount | null;
  readonly amount: Amount;
  readonly iceberg: boolean;
  readonly lead: boolean;
}

export interface LeadOrderDecision {
  readonly lead: boolean;
  readonly reason: NotLeadReason | null;
}

export interface LeadTradingDeps {
  readonly sql: Sql;
  readonly now: () => Date;
  /** The caller's own listing: its state and instruments. Null: not listed. */
  readonly listing: (userId: string) => Promise<{ readonly state: string; readonly assets: readonly string[] } | null>;
  /** The owner's least venue USDC to lead (also the lead's equity minimum); null while unset. */
  readonly minVenueUsdc: Amount | null;
  readonly venueUsdc: (userId: string) => Promise<LeadVenueRead>;
  readonly limits: LeadLimits;
  readonly ownerDay: CopyOwnerDay;
}

/** A lead trade the views list: the lead's own order, read from its order row. */
export interface LeadTradeView {
  readonly orderId: string;
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly price: string | null;
  readonly amount: string;
  readonly filled: string;
  readonly status: string;
  readonly at: string;
}

export interface LeadTradesView {
  readonly ongoing: readonly LeadTradeView[];
  readonly history: readonly LeadTradeView[];
  /** Counted in the database, never from the page's rows. */
  readonly counts: { readonly ongoing: number; readonly history: number };
}

/** One copier of the lead: its follow's short id, state and start. No follower's name, balance or profit. */
export interface LeadCopierView {
  readonly followRef: string;
  readonly status: 'Active' | 'Paused' | 'Stopping' | 'Close only' | 'Stopped';
  readonly since: string;
}

const LEAD_TRADES_PAGE = 50;
const ONGOING = ['pending', 'open'] as const;

const STATUS_TEXT: Record<string, LeadCopierView['status']> = {
  ACTIVE: 'Active',
  PAUSED: 'Paused',
  STOPPING: 'Stopping',
  CLOSE_ONLY: 'Close only',
  DETACHED: 'Stopped',
};

export class LeadTrading {
  constructor(private readonly deps: LeadTradingDeps) {}

  /**
   * The decision for one order a lead sends with the switch, before it is placed. Null: the caller is not a listed lead
   * and asked for no lead trade, so the order is an ordinary one and nothing is recorded. Throws a CopyError to refuse.
   */
  async decide(principal: Principal, ask: LeadOrderAsk): Promise<LeadOrderDecision | null> {
    const listing = await this.deps.listing(principal.userId);
    if (listing?.state !== 'listed') {
      if (!ask.lead) return null;
      throw new CopyError('Only an approved lead places a lead trade. This account is not listed as a lead.', 'trade.copy_lead_not_listed');
    }
    if (ask.iceberg) return { lead: false, reason: 'iceberg' };
    if (!ask.lead) return { lead: false, reason: 'switched_off' };

    if (listing.assets.length === 0) {
      throw new CopyError(
        'The platform has not set the instruments you may lead, so the leading instrument list is empty and a lead trade can’t be placed.',
        'trade.copy_leader_instruments_not_set',
      );
    }
    if (!listing.assets.includes(ask.symbol)) {
      throw new CopyError(
        `${ask.symbol} is not on your leading instrument list (${listing.assets.join(', ')}).`,
        'trade.copy_lead_instrument_unlisted',
      );
    }
    if (ask.price === null) {
      throw new CopyError(
        'A lead trade needs a limit price, so it can be counted against your lead limits.',
        'trade.copy_lead_price_required',
      );
    }
    await this.refuseUnderEquity(principal.userId);

    const notional = mul(ask.price, ask.amount);
    const holding = this.deps.limits.pairHolding?.get(ask.symbol) ?? null;
    if (!holding) {
      throw new CopyError(
        `The platform has not set a holding limit for ${ask.symbol}, so it can’t be led.`,
        'trade.copy_pair_limit_not_set',
      );
    }
    if (ask.side === 'buy') {
      const held = await this.heldNotional(principal.userId, ask.symbol);
      if (compare(add(held, notional), holding) > 0) {
        throw new CopyError(
          `This buy would take your lead holding in ${ask.symbol} to ${formatAmount(add(held, notional))}, over the ${formatAmount(holding)} limit.`,
          'trade.copy_pair_holding_limit',
        );
      }
      const cap = this.deps.limits.dailyBuyCap;
      if (!cap) {
        throw new CopyError(
          'The platform has not set the lead daily buy cap, so a lead buy can’t be counted.',
          'trade.copy_leader_limit_not_set',
        );
      }
      const day = copyOwnerDay(this.deps.ownerDay, this.deps.now());
      const bought = await this.boughtSince(principal.userId, day.start);
      if (compare(add(bought, notional), cap) > 0) {
        throw new CopyError(
          `Your lead buys today would reach ${formatAmount(add(bought, notional))}, over the daily buy cap of ${formatAmount(cap)}. It resets at ${day.next.toISOString()}.`,
          'trade.copy_daily_buy_cap',
        );
      }
    }
    return { lead: true, reason: null };
  }

  /** Records the decision under the order's own id, once; a replay of the same order id writes nothing. */
  async record(principal: Principal, ask: LeadOrderAsk, decision: LeadOrderDecision): Promise<void> {
    const notional = ask.price === null ? null : mul(ask.price, ask.amount);
    // A not-lead market order still needs its row (so its fills are never copied); its notional is its amount.
    const value = formatAmount(notional ?? ask.amount);
    await this.deps.sql`
      INSERT INTO trade.copy_lead_orders (order_id, leader_user_id, symbol, side, notional, lead, not_lead_reason, created_at)
      VALUES (${ask.orderId}, ${principal.userId}, ${ask.symbol}, ${ask.side}, ${value}, ${decision.lead}, ${decision.reason},
              ${this.deps.now().toISOString()})
      ON CONFLICT (order_id) DO NOTHING`;
  }

  /** Whether a lead's fill belongs to an order recorded as not a lead trade (the copy driver then skips it). */
  async isNotLeadFill(fillId: string): Promise<boolean> {
    const [row] = await this.deps.sql<Array<{ lead: boolean }>>`
      SELECT l.lead FROM trade.fills f INNER JOIN trade.copy_lead_orders l ON l.order_id = f.order_id
       WHERE f.id = ${fillId} LIMIT 1`;
    return row?.lead === false;
  }

  /** The lead's own lead trades, ongoing (resting) and history, with counts from the database. */
  async trades(principal: Principal): Promise<LeadTradesView> {
    const rows = (status: 'ongoing' | 'history') => this.deps.sql<Array<TradeRow>>`
      SELECT o.id, m.symbol, o.side, o.price::text AS price, o.qty::text AS qty, o.filled_qty::text AS filled, o.status::text AS status,
             l.created_at
        FROM trade.copy_lead_orders l
        INNER JOIN trade.orders o ON o.id = l.order_id
        INNER JOIN trade.markets m ON m.id = o.market_id
       WHERE l.leader_user_id = ${principal.userId} AND l.lead
         AND ${status === 'ongoing' ? this.deps.sql`o.status::text IN ${this.deps.sql([...ONGOING])}` : this.deps.sql`o.status::text NOT IN ${this.deps.sql([...ONGOING])}`}
       ORDER BY l.created_at DESC, o.id DESC
       LIMIT ${LEAD_TRADES_PAGE}`;
    const [ongoing, history, [counts]] = await Promise.all([
      rows('ongoing'),
      rows('history'),
      this.deps.sql<Array<{ ongoing: string; history: string }>>`
        SELECT count(*) FILTER (WHERE o.status::text IN ${this.deps.sql([...ONGOING])})::text AS ongoing,
               count(*) FILTER (WHERE o.status::text NOT IN ${this.deps.sql([...ONGOING])})::text AS history
          FROM trade.copy_lead_orders l INNER JOIN trade.orders o ON o.id = l.order_id
         WHERE l.leader_user_id = ${principal.userId} AND l.lead`,
    ]);
    return {
      ongoing: ongoing.map(tradeView),
      history: history.map(tradeView),
      counts: { ongoing: Number(counts?.ongoing ?? 0), history: Number(counts?.history ?? 0) },
    };
  }

  /** The lead's copiers, newest first: each follow of this lead and its state. */
  async copiers(principal: Principal): Promise<LeadCopierView[]> {
    const rows = await this.deps.sql<Array<{ follow_id: string; relationship_state: string; created_at: Date }>>`
      SELECT follow_id, relationship_state, created_at FROM trade.copy_follows
       WHERE leader_id = ${principal.userId}
       ORDER BY created_at DESC, follow_id DESC
       LIMIT ${LEAD_TRADES_PAGE}`;
    return rows.map((r) => ({
      followRef: r.follow_id.slice(0, 8),
      status: STATUS_TEXT[r.relationship_state] ?? 'Stopped',
      since: new Date(r.created_at).toISOString(),
    }));
  }

  private async refuseUnderEquity(userId: string): Promise<void> {
    const min = this.deps.minVenueUsdc;
    if (min === null) {
      throw new CopyError(
        'The lead equity minimum is not set by the platform, so a lead trade can’t be placed.',
        'trade.copy_leader_limit_not_set',
      );
    }
    let read: LeadVenueRead;
    try {
      read = await this.deps.venueUsdc(userId);
    } catch {
      throw new CopyError(
        'Your venue account could not be read, so your lead equity can’t be checked.',
        'trade.copy_lead_venue_unreadable',
      );
    }
    if (read.state !== 'read') {
      throw new CopyError('Connect the wallet whose venue account you lead from.', 'trade.copy_lead_venue_account_missing');
    }
    if (compare(read.usdc, min) < 0) {
      throw new CopyError(
        `Your venue account holds ${formatAmount(read.usdc)} USDC, under the lead equity minimum of ${formatAmount(min)} USDC.`,
        'trade.copy_leader_equity_below_min',
      );
    }
  }

  /**
   * What the lead holds or has committed in lead trades of a pair: lead buys (live ones whole, finished ones as filled)
   * less lead sells as filled, never under zero. Only orders that exist count. Price times size carries 36 places in
   * Postgres; each sum is rounded to the ledger's 18.
   */
  private async heldNotional(userId: string, symbol: string): Promise<Amount> {
    const [row] = await this.deps.sql<Array<{ buys: string | null; sells: string | null }>>`
      SELECT round(sum(CASE WHEN o.status::text IN ${this.deps.sql([...ONGOING])} THEN o.price * o.qty ELSE o.price * o.filled_qty END)
               FILTER (WHERE l.side = 'buy'), 18)::text AS buys,
             round(sum(o.price * o.filled_qty) FILTER (WHERE l.side = 'sell'), 18)::text AS sells
        FROM trade.copy_lead_orders l INNER JOIN trade.orders o ON o.id = l.order_id
       WHERE l.leader_user_id = ${userId} AND l.symbol = ${symbol} AND l.lead`;
    const held = sub(parseAmount(row?.buys ?? '0'), parseAmount(row?.sells ?? '0'));
    return compare(held, parseAmount('0')) > 0 ? held : parseAmount('0');
  }

  /** Lead buys since the owner day began: live ones whole, finished ones as filled. Only orders that exist count. */
  private async boughtSince(userId: string, start: Date): Promise<Amount> {
    const [row] = await this.deps.sql<Array<{ bought: string | null }>>`
      SELECT round(sum(CASE WHEN o.status::text IN ${this.deps.sql([...ONGOING])} THEN o.price * o.qty ELSE o.price * o.filled_qty END), 18)::text AS bought
        FROM trade.copy_lead_orders l INNER JOIN trade.orders o ON o.id = l.order_id
       WHERE l.leader_user_id = ${userId} AND l.lead AND l.side = 'buy' AND l.created_at >= ${start.toISOString()}`;
    return parseAmount(row?.bought ?? '0');
  }
}

type TradeRow = {
  id: string;
  symbol: string;
  side: 'buy' | 'sell';
  price: string | null;
  qty: string;
  filled: string;
  status: string;
  created_at: Date;
};

function tradeView(r: TradeRow): LeadTradeView {
  return {
    orderId: r.id,
    symbol: r.symbol,
    side: r.side,
    price: r.price === null ? null : formatAmount(parseAmount(r.price)),
    amount: formatAmount(parseAmount(r.qty)),
    filled: formatAmount(parseAmount(r.filled)),
    status: r.status,
    at: new Date(r.created_at).toISOString(),
  };
}
