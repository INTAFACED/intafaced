import type { Sql } from 'postgres';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client/money';

/**
 * A protection our engine runs on the venue's prices (J-derivatives-03 #5 #6): the kinds the venue does not take, held in
 * `trade.user_venue_engine_protections` (drizzle/20261112090000_user_venue_engine_protections.sql). No balance, no post.
 */
export type EngineProtectionStatus = 'armed' | 'firing' | 'fired' | 'failed' | 'cancelled';

export interface EngineProtection {
  readonly id: string;
  readonly userId: string;
  readonly venueId: string;
  readonly owner: string;
  readonly clientKey: string;
  readonly symbol: string;
  readonly kind: 'stop_market' | 'trailing_stop';
  readonly side: 'buy' | 'sell';
  readonly quantity: Amount;
  readonly triggerSource: 'mark' | 'index';
  readonly triggerPrice: Amount | null;
  readonly trailingDistance: Amount | null;
  readonly bestPrice: Amount | null;
  readonly agentAddress: string;
  /** The region of the request that armed it, checked again with the person's live level before each order is sent. */
  readonly region: string;
  readonly status: EngineProtectionStatus;
  readonly failure: string | null;
  readonly cancelReason: string | null;
  readonly firedAt: Date | null;
  readonly createdAt: Date;
}

export interface EngineProtectionStore {
  /** Inserts the protection, or returns the one already stored under its `(userId, clientKey)`. */
  createOnce(p: EngineProtection): Promise<EngineProtection>;
  get(userId: string, id: string): Promise<EngineProtection | null>;
  listForOwner(userId: string, owner: string): Promise<readonly EngineProtection[]>;
  /** Every protection still armed or firing, oldest first (the engine's work). */
  live(): Promise<readonly EngineProtection[]>;
  /** A trailing stop's new best price, while it is armed. */
  setBest(id: string, best: Amount, at: Date): Promise<void>;
  /**
   * Moves the protection from `from` to `to` and answers true, or answers false when it is no longer in `from`: of two
   * workers that both see a crossed trigger, one claims it (`armed` → `firing`) and the other does nothing.
   */
  move(
    id: string,
    from: EngineProtectionStatus,
    to: EngineProtectionStatus,
    at: Date,
    extra?: { failure?: string; cancelReason?: string; firedAt?: Date },
  ): Promise<boolean>;
}

export class InMemoryEngineProtectionStore implements EngineProtectionStore {
  readonly rows = new Map<string, EngineProtection>();
  async createOnce(p: EngineProtection) {
    for (const r of this.rows.values()) if (r.userId === p.userId && r.clientKey === p.clientKey) return r;
    this.rows.set(p.id, p);
    return p;
  }
  async get(userId: string, id: string) {
    const r = this.rows.get(id);
    return r && r.userId === userId ? r : null;
  }
  async listForOwner(userId: string, owner: string) {
    return [...this.rows.values()].filter((r) => r.userId === userId && r.owner === owner);
  }
  async live() {
    return [...this.rows.values()].filter((r) => r.status === 'armed' || r.status === 'firing');
  }
  async setBest(id: string, best: Amount) {
    const r = this.rows.get(id);
    if (r && r.status === 'armed') this.rows.set(id, { ...r, bestPrice: best });
  }
  async move(
    id: string,
    from: EngineProtectionStatus,
    to: EngineProtectionStatus,
    _at: Date,
    extra: { failure?: string; cancelReason?: string; firedAt?: Date } = {},
  ) {
    const r = this.rows.get(id);
    if (!r || r.status !== from) return false;
    this.rows.set(id, {
      ...r,
      status: to,
      failure: extra.failure ?? r.failure,
      cancelReason: extra.cancelReason ?? r.cancelReason,
      firedAt: extra.firedAt ?? r.firedAt,
    });
    return true;
  }
}

type Row = {
  id: string;
  user_id: string;
  venue_id: string;
  owner: string;
  client_key: string;
  symbol: string;
  kind: EngineProtection['kind'];
  side: EngineProtection['side'];
  quantity: string;
  trigger_source: EngineProtection['triggerSource'];
  trigger_price: string | null;
  trailing_distance: string | null;
  best_price: string | null;
  agent_address: string;
  region: string;
  status: EngineProtectionStatus;
  failure: string | null;
  cancel_reason: string | null;
  fired_at: Date | null;
  created_at: Date;
};

const amountOrNull = (v: string | null) => (v === null ? null : parseAmount(v));

function fromRow(r: Row): EngineProtection {
  return {
    id: r.id,
    userId: r.user_id,
    venueId: r.venue_id,
    owner: r.owner,
    clientKey: r.client_key,
    symbol: r.symbol,
    kind: r.kind,
    side: r.side,
    quantity: parseAmount(r.quantity),
    triggerSource: r.trigger_source,
    triggerPrice: amountOrNull(r.trigger_price),
    trailingDistance: amountOrNull(r.trailing_distance),
    bestPrice: amountOrNull(r.best_price),
    agentAddress: r.agent_address,
    region: r.region,
    status: r.status,
    failure: r.failure,
    cancelReason: r.cancel_reason,
    firedAt: r.fired_at,
    createdAt: r.created_at,
  };
}

const fmt = (v: Amount | null) => (v === null ? null : formatAmount(v));

export class SqlEngineProtectionStore implements EngineProtectionStore {
  constructor(private readonly sql: Sql) {}

  async createOnce(p: EngineProtection) {
    await this.sql`
      INSERT INTO trade.user_venue_engine_protections
        (id, user_id, venue_id, owner, client_key, symbol, kind, side, quantity, trigger_source, trigger_price,
         trailing_distance, best_price, agent_address, region, status, created_at, updated_at)
      VALUES (${p.id}, ${p.userId}, ${p.venueId}, ${p.owner}, ${p.clientKey}, ${p.symbol}, ${p.kind}, ${p.side},
        ${formatAmount(p.quantity)}, ${p.triggerSource}, ${fmt(p.triggerPrice)}, ${fmt(p.trailingDistance)}, ${fmt(p.bestPrice)},
        ${p.agentAddress}, ${p.region}, ${p.status}, ${p.createdAt}, ${p.createdAt})
      ON CONFLICT (user_id, client_key) DO NOTHING`;
    const rows = await this.sql<Row[]>`
      SELECT * FROM trade.user_venue_engine_protections WHERE user_id = ${p.userId} AND client_key = ${p.clientKey}`;
    return fromRow(rows[0]!);
  }

  async get(userId: string, id: string) {
    const rows = await this.sql<Row[]>`SELECT * FROM trade.user_venue_engine_protections WHERE user_id = ${userId} AND id = ${id}`;
    return rows[0] ? fromRow(rows[0]) : null;
  }

  async listForOwner(userId: string, owner: string) {
    const rows = await this.sql<Row[]>`
      SELECT * FROM trade.user_venue_engine_protections WHERE user_id = ${userId} AND owner = ${owner} ORDER BY created_at, id`;
    return rows.map(fromRow);
  }

  async live() {
    const rows = await this.sql<Row[]>`
      SELECT * FROM trade.user_venue_engine_protections WHERE status IN ('armed', 'firing') ORDER BY created_at, id`;
    return rows.map(fromRow);
  }

  async setBest(id: string, best: Amount, at: Date) {
    await this.sql`
      UPDATE trade.user_venue_engine_protections SET best_price = ${formatAmount(best)}, updated_at = ${at}
      WHERE id = ${id} AND status = 'armed'`;
  }

  async move(
    id: string,
    from: EngineProtectionStatus,
    to: EngineProtectionStatus,
    at: Date,
    extra: { failure?: string; cancelReason?: string; firedAt?: Date } = {},
  ) {
    const rows = await this.sql`
      UPDATE trade.user_venue_engine_protections
      SET status = ${to}, updated_at = ${at},
          failure = COALESCE(${extra.failure ?? null}, failure),
          cancel_reason = COALESCE(${extra.cancelReason ?? null}, cancel_reason),
          fired_at = COALESCE(${extra.firedAt ?? null}, fired_at)
      WHERE id = ${id} AND status = ${from}
      RETURNING id`;
    return rows.length === 1;
  }
}
