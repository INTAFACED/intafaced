import type { Sql } from 'postgres';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client/money';

/**
 * A conditional spot order on the person's own venue account (J-cex-spot-08; src/venue/spot-conditionals.ts), held in
 * `trade.user_venue_spot_conditionals` (drizzle/20261117142938_user_venue_spot_conditionals.sql). No balance, no post.
 *
 * States: a bracket or a linked close waits on its `entry`; once the entry is final with something received, its exits
 * are `placing` and then `open`. An OCO is `open` (its take profit rests on the venue, its stop loss on our engine); a
 * lone stop is `armed`. A crossed stop is claimed `firing` by one worker; a cancel is claimed `cancelling` until the
 * venue has cancelled what rests there. It ends `fired`, `filled`, `failed` or `cancelled`, once.
 */
export type SpotConditionalKind = 'stop_limit' | 'stop_market' | 'oco' | 'bracket' | 'oto';
export type SpotConditionalStatus =
  'entry' | 'placing' | 'open' | 'armed' | 'firing' | 'cancelling' | 'fired' | 'filled' | 'failed' | 'cancelled';

export const LIVE_SPOT_STATUSES: readonly SpotConditionalStatus[] = ['entry', 'placing', 'open', 'armed', 'firing', 'cancelling'];

export interface SpotConditional {
  readonly id: string;
  readonly userId: string;
  readonly venueId: string;
  readonly owner: string;
  readonly clientKey: string;
  readonly kind: SpotConditionalKind;
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly quantity: Amount;
  readonly triggerPrice: Amount | null;
  readonly limitPrice: Amount | null;
  readonly takeProfitPrice: Amount | null;
  readonly entryPrice: Amount | null;
  readonly entryTif: 'GTC' | 'IOC' | null;
  readonly closePrice: Amount | null;
  readonly exitQuantity: Amount | null;
  readonly agentAddress: string;
  readonly region: string;
  readonly status: SpotConditionalStatus;
  readonly failure: string | null;
  readonly cancelReason: string | null;
  readonly firedAt: Date | null;
  readonly createdAt: Date;
}

export interface MoveExtra {
  readonly failure?: string;
  readonly cancelReason?: string;
  readonly firedAt?: Date;
  /** Set once, with the move out of `entry`. */
  readonly exitQuantity?: Amount;
}

export interface SpotConditionalStore {
  /** Inserts the order, or returns the one already stored under its `(userId, owner, clientKey)`. */
  createOnce(row: SpotConditional): Promise<SpotConditional>;
  get(userId: string, id: string): Promise<SpotConditional | null>;
  listForOwner(userId: string, owner: string): Promise<readonly SpotConditional[]>;
  /** Every order still live, oldest first (the engine's work). */
  live(): Promise<readonly SpotConditional[]>;
  /**
   * Moves the order from `from` to `to` and answers true, or false when it is no longer in `from`: of two workers (or a
   * worker and the person's cancel) that act on the same order, one wins and the other does nothing.
   */
  move(id: string, from: SpotConditionalStatus, to: SpotConditionalStatus, at: Date, extra?: MoveExtra): Promise<boolean>;
  /** A live stop's new trigger and limit, while it is still in `status`; false when it has moved on. */
  reprice(id: string, status: SpotConditionalStatus, trigger: Amount, limit: Amount | null, at: Date): Promise<boolean>;
}

export class InMemorySpotConditionalStore implements SpotConditionalStore {
  readonly rows = new Map<string, SpotConditional>();
  async createOnce(row: SpotConditional) {
    for (const r of this.rows.values()) if (r.userId === row.userId && r.owner === row.owner && r.clientKey === row.clientKey) return r;
    this.rows.set(row.id, row);
    return row;
  }
  async get(userId: string, id: string) {
    const r = this.rows.get(id);
    return r && r.userId === userId ? r : null;
  }
  async listForOwner(userId: string, owner: string) {
    return [...this.rows.values()].filter((r) => r.userId === userId && r.owner === owner);
  }
  async live() {
    return [...this.rows.values()].filter((r) => LIVE_SPOT_STATUSES.includes(r.status));
  }
  async move(id: string, from: SpotConditionalStatus, to: SpotConditionalStatus, _at: Date, extra: MoveExtra = {}) {
    const r = this.rows.get(id);
    if (!r || r.status !== from) return false;
    this.rows.set(id, {
      ...r,
      status: to,
      failure: extra.failure ?? r.failure,
      cancelReason: extra.cancelReason ?? r.cancelReason,
      firedAt: extra.firedAt ?? r.firedAt,
      exitQuantity: r.exitQuantity ?? extra.exitQuantity ?? null,
    });
    return true;
  }
  async reprice(id: string, status: SpotConditionalStatus, trigger: Amount, limit: Amount | null) {
    const r = this.rows.get(id);
    if (!r || r.status !== status) return false;
    this.rows.set(id, { ...r, triggerPrice: trigger, limitPrice: limit });
    return true;
  }
}

type Row = {
  id: string;
  user_id: string;
  venue_id: string;
  owner: string;
  client_key: string;
  kind: SpotConditionalKind;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: string;
  trigger_price: string | null;
  limit_price: string | null;
  take_profit_price: string | null;
  entry_price: string | null;
  entry_tif: 'GTC' | 'IOC' | null;
  close_price: string | null;
  exit_quantity: string | null;
  agent_address: string;
  region: string;
  status: SpotConditionalStatus;
  failure: string | null;
  cancel_reason: string | null;
  fired_at: Date | null;
  created_at: Date;
};

const amountOrNull = (v: string | null) => (v === null ? null : parseAmount(v));
const fmt = (v: Amount | null) => (v === null ? null : formatAmount(v));

function fromRow(r: Row): SpotConditional {
  return {
    id: r.id,
    userId: r.user_id,
    venueId: r.venue_id,
    owner: r.owner,
    clientKey: r.client_key,
    kind: r.kind,
    symbol: r.symbol,
    side: r.side,
    quantity: parseAmount(r.quantity),
    triggerPrice: amountOrNull(r.trigger_price),
    limitPrice: amountOrNull(r.limit_price),
    takeProfitPrice: amountOrNull(r.take_profit_price),
    entryPrice: amountOrNull(r.entry_price),
    entryTif: r.entry_tif,
    closePrice: amountOrNull(r.close_price),
    exitQuantity: amountOrNull(r.exit_quantity),
    agentAddress: r.agent_address,
    region: r.region,
    status: r.status,
    failure: r.failure,
    cancelReason: r.cancel_reason,
    firedAt: r.fired_at,
    createdAt: r.created_at,
  };
}

export class SqlSpotConditionalStore implements SpotConditionalStore {
  constructor(private readonly sql: Sql) {}

  async createOnce(p: SpotConditional) {
    await this.sql`
      INSERT INTO trade.user_venue_spot_conditionals
        (id, user_id, venue_id, owner, client_key, kind, symbol, side, quantity, trigger_price, limit_price, take_profit_price,
         entry_price, entry_tif, close_price, exit_quantity, agent_address, region, status, created_at, updated_at)
      VALUES (${p.id}, ${p.userId}, ${p.venueId}, ${p.owner}, ${p.clientKey}, ${p.kind}, ${p.symbol}, ${p.side},
        ${formatAmount(p.quantity)}, ${fmt(p.triggerPrice)}, ${fmt(p.limitPrice)}, ${fmt(p.takeProfitPrice)}, ${fmt(p.entryPrice)},
        ${p.entryTif}, ${fmt(p.closePrice)}, ${fmt(p.exitQuantity)}, ${p.agentAddress}, ${p.region}, ${p.status},
        ${p.createdAt}, ${p.createdAt})
      ON CONFLICT (user_id, owner, client_key) DO NOTHING`;
    const rows = await this.sql<Row[]>`
      SELECT * FROM trade.user_venue_spot_conditionals
      WHERE user_id = ${p.userId} AND owner = ${p.owner} AND client_key = ${p.clientKey}`;
    return fromRow(rows[0]!);
  }

  async get(userId: string, id: string) {
    const rows = await this.sql<Row[]>`SELECT * FROM trade.user_venue_spot_conditionals WHERE user_id = ${userId} AND id = ${id}`;
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async listForOwner(userId: string, owner: string) {
    const rows = await this.sql<Row[]>`
      SELECT * FROM trade.user_venue_spot_conditionals WHERE user_id = ${userId} AND owner = ${owner} ORDER BY created_at, id`;
    return rows.map(fromRow);
  }

  async live() {
    const rows = await this.sql<Row[]>`
      SELECT * FROM trade.user_venue_spot_conditionals
      WHERE status IN ('entry', 'placing', 'open', 'armed', 'firing', 'cancelling') ORDER BY created_at, id`;
    return rows.map(fromRow);
  }

  async move(id: string, from: SpotConditionalStatus, to: SpotConditionalStatus, at: Date, extra: MoveExtra = {}) {
    const rows = await this.sql`
      UPDATE trade.user_venue_spot_conditionals
      SET status = ${to}, updated_at = ${at},
          failure = COALESCE(${extra.failure ?? null}, failure),
          cancel_reason = COALESCE(${extra.cancelReason ?? null}, cancel_reason),
          fired_at = COALESCE(${extra.firedAt ?? null}, fired_at),
          exit_quantity = COALESCE(exit_quantity, ${extra.exitQuantity === undefined ? null : formatAmount(extra.exitQuantity)})
      WHERE id = ${id} AND status = ${from}
      RETURNING id`;
    return rows.length === 1;
  }

  async reprice(id: string, status: SpotConditionalStatus, trigger: Amount, limit: Amount | null, at: Date) {
    const rows = await this.sql`
      UPDATE trade.user_venue_spot_conditionals
      SET trigger_price = ${formatAmount(trigger)}, limit_price = ${fmt(limit)}, updated_at = ${at}
      WHERE id = ${id} AND status = ${status}
      RETURNING id`;
    return rows.length === 1;
  }
}
