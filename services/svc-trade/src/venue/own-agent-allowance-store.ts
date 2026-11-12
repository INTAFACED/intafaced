import type { Sql, TransactionSql } from 'postgres';
import { add, compare, formatAmount, parseAmount, sub, ZERO, type Amount } from '@intafaced/ledger-client/money';

/**
 * The allowances a person gives their own agent, and the orders the agent drew on them (J-agents-08 #3 to #7;
 * own-agent-trading.ts): `trade.user_venue_own_agent_allowances` and `trade.user_venue_own_agent_draws`
 * (drizzle/20261112022349_user_venue_own_agent_allowances.sql).
 *
 * Nothing here is a balance: the venue is the record of what the sub-account holds. An allowance is the most notional
 * the agent may commit, in all, until it ends. A draw is written under the allowance's row lock before the agent key
 * signs the order, and counts until the venue refuses the order; so two draws at once can't both fit in the same room,
 * and a retried draw (the same order id) is the same draw, never a second one.
 */

export type AllowanceStatus = 'signing' | 'active' | 'revoked' | 'abandoned';
export type AllowancePeriod = 'day' | 'week' | 'month';
export type DrawState = 'admitted' | 'refused';

export interface AllowanceRecord {
  readonly userId: string;
  readonly allowanceId: string;
  /** svc-agents' id of the person's own agent. */
  readonly agentId: string;
  readonly venueId: string;
  /** The person's wallet, lowercase. */
  readonly owner: string;
  /** The one venue sub-account the agent key may trade. */
  readonly subAccount: string;
  readonly asset: string;
  readonly amount: Amount;
  readonly period: AllowancePeriod;
  /** The venue agent key INTAFACED holds for this allowance (agent-key.ts, derived from the allowance id). */
  readonly agentAddress: string;
  readonly status: AllowanceStatus;
  readonly createdAt: Date;
  readonly endsAt: Date;
  readonly activeAt: Date | null;
  readonly revokedAt: Date | null;
}

export interface DrawRecord {
  readonly userId: string;
  readonly allowanceId: string;
  readonly orderId: string;
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly type: 'market' | 'limit';
  readonly size: Amount;
  readonly price: Amount;
  /** What the order commits against the allowance. */
  readonly amount: Amount;
  readonly state: DrawState;
  readonly createdAt: Date;
}

/** What the allowance has left: its amount less every draw the venue has not refused. Never below zero. */
export function allowanceLeft(amount: Amount, draws: readonly DrawRecord[]): Amount {
  let used = ZERO;
  for (const d of draws) if (d.state === 'admitted') used = add(used, d.amount);
  const left = sub(amount, used);
  return compare(left, ZERO) < 0 ? ZERO : left;
}

/** Why a draw was not admitted, decided under the allowance's row lock. */
export type AdmitRefusal = 'not_active' | 'revoked' | 'ended' | 'exceeded' | 'order_reused';

export type AdmitOutcome =
  | { readonly admitted: true; readonly draw: DrawRecord; readonly replayed: boolean; readonly left: Amount }
  | { readonly admitted: false; readonly refusal: AdmitRefusal; readonly left: Amount };

export interface AllowanceStore {
  find(userId: string, allowanceId: string): Promise<AllowanceRecord | null>;
  /** The agent's allowances, newest first. */
  listForAgent(userId: string, agentId: string): Promise<readonly AllowanceRecord[]>;
  /** Store a new allowance unless one with this id exists; refuses `live` when the agent already has one signing or active. */
  insertOnce(record: AllowanceRecord): Promise<{ stored: AllowanceRecord } | { live: AllowanceRecord }>;
  /** Signing → active, once the venue's record shows the agent permission. */
  activate(userId: string, allowanceId: string, at: Date): Promise<AllowanceRecord>;
  /** Signing → abandoned: the wallet refused the agent permission, so nothing was granted. */
  abandon(userId: string, allowanceId: string): Promise<AllowanceRecord>;
  /** Active → revoked, under the row lock, so no draw is admitted after it. A revoked one stays as it is. */
  revoke(userId: string, allowanceId: string, at: Date): Promise<AllowanceRecord>;
  draws(userId: string, allowanceId: string): Promise<readonly DrawRecord[]>;
  findDraw(userId: string, orderId: string): Promise<DrawRecord | null>;
  /**
   * Admit one draw under the allowance's row lock: the allowance active, not ended at `now`, and its amount less every
   * admitted draw at least the draw's amount. The same order id again returns the draw stored for it.
   */
  admit(draw: DrawRecord, now: Date): Promise<AdmitOutcome>;
  /** The venue refused the order: the draw no longer counts. */
  refuse(userId: string, orderId: string): Promise<void>;
}

function sameTerms(a: DrawRecord, b: DrawRecord): boolean {
  return (
    a.allowanceId === b.allowanceId &&
    a.symbol === b.symbol &&
    a.side === b.side &&
    a.type === b.type &&
    a.size === b.size &&
    a.price === b.price &&
    a.amount === b.amount
  );
}

/** The decision `admit` makes, on what it read under the lock. Pure, so the in-memory and SQL stores decide alike. */
export function decideAdmit(a: AllowanceRecord, draws: readonly DrawRecord[], draw: DrawRecord, now: Date): AdmitOutcome {
  const left = allowanceLeft(a.amount, draws);
  const existing = draws.find((d) => d.orderId === draw.orderId);
  if (existing) {
    if (!sameTerms(existing, draw)) return { admitted: false, refusal: 'order_reused', left };
    return { admitted: true, draw: existing, replayed: true, left };
  }
  if (a.status === 'revoked') return { admitted: false, refusal: 'revoked', left };
  if (a.status !== 'active') return { admitted: false, refusal: 'not_active', left };
  if (now.getTime() >= a.endsAt.getTime()) return { admitted: false, refusal: 'ended', left };
  if (compare(draw.amount, left) > 0) return { admitted: false, refusal: 'exceeded', left };
  return { admitted: true, draw, replayed: false, left: sub(left, draw.amount) };
}

export class InMemoryAllowanceStore implements AllowanceStore {
  private readonly rows = new Map<string, AllowanceRecord>();
  private readonly drawRows: DrawRecord[] = [];
  private chain: Promise<unknown> = Promise.resolve();

  /** One write at a time, as the row lock makes it in SQL. */
  private locked<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  async find(userId: string, allowanceId: string) {
    const r = this.rows.get(allowanceId);
    return r && r.userId === userId ? r : null;
  }

  async listForAgent(userId: string, agentId: string) {
    return [...this.rows.values()]
      .filter((r) => r.userId === userId && r.agentId === agentId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  insertOnce(record: AllowanceRecord) {
    return this.locked(() => {
      const existing = this.rows.get(record.allowanceId);
      if (existing) return { stored: existing };
      const live = [...this.rows.values()].find(
        (r) => r.userId === record.userId && r.agentId === record.agentId && (r.status === 'signing' || r.status === 'active'),
      );
      if (live) return { live };
      this.rows.set(record.allowanceId, record);
      return { stored: record };
    });
  }

  private patch(userId: string, allowanceId: string, from: AllowanceStatus, to: Partial<AllowanceRecord>) {
    return this.locked(() => {
      const r = this.rows.get(allowanceId);
      if (!r || r.userId !== userId) throw new Error(`no allowance ${allowanceId}`);
      if (r.status !== from) return r;
      const next = { ...r, ...to };
      this.rows.set(allowanceId, next);
      return next;
    });
  }

  activate(userId: string, allowanceId: string, at: Date) {
    return this.patch(userId, allowanceId, 'signing', { status: 'active', activeAt: at });
  }

  abandon(userId: string, allowanceId: string) {
    return this.patch(userId, allowanceId, 'signing', { status: 'abandoned' });
  }

  revoke(userId: string, allowanceId: string, at: Date) {
    return this.patch(userId, allowanceId, 'active', { status: 'revoked', revokedAt: at });
  }

  async draws(userId: string, allowanceId: string) {
    return this.drawRows.filter((d) => d.userId === userId && d.allowanceId === allowanceId);
  }

  async findDraw(userId: string, orderId: string) {
    return this.drawRows.find((d) => d.userId === userId && d.orderId === orderId) ?? null;
  }

  admit(draw: DrawRecord, now: Date) {
    return this.locked(async () => {
      const a = await this.find(draw.userId, draw.allowanceId);
      if (!a) throw new Error(`no allowance ${draw.allowanceId}`);
      const reused = this.drawRows.find((d) => d.userId === draw.userId && d.orderId === draw.orderId);
      const outcome = decideAdmit(
        a,
        reused && reused.allowanceId !== a.allowanceId ? [reused] : await this.draws(draw.userId, a.allowanceId),
        draw,
        now,
      );
      if (outcome.admitted && !outcome.replayed) this.drawRows.push(draw);
      return outcome;
    });
  }

  refuse(userId: string, orderId: string) {
    return this.locked(() => {
      const i = this.drawRows.findIndex((d) => d.userId === userId && d.orderId === orderId);
      if (i >= 0 && this.drawRows[i]!.state === 'admitted') this.drawRows[i] = { ...this.drawRows[i]!, state: 'refused' };
    });
  }
}

interface AllowanceRow {
  user_id: string;
  allowance_id: string;
  agent_id: string;
  venue_id: string;
  owner: string;
  sub_account: string;
  asset: string;
  amount: string;
  period: AllowancePeriod;
  agent_address: string;
  status: AllowanceStatus;
  created_at: Date;
  ends_at: Date;
  active_at: Date | null;
  revoked_at: Date | null;
}

interface DrawRow {
  user_id: string;
  allowance_id: string;
  order_id: string;
  symbol: string;
  side: 'buy' | 'sell';
  order_type: 'market' | 'limit';
  size: string;
  price: string;
  amount: string;
  state: DrawState;
  created_at: Date;
}

const allowanceOf = (r: AllowanceRow): AllowanceRecord => ({
  userId: r.user_id,
  allowanceId: r.allowance_id,
  agentId: r.agent_id,
  venueId: r.venue_id,
  owner: r.owner,
  subAccount: r.sub_account,
  asset: r.asset,
  amount: parseAmount(r.amount),
  period: r.period,
  agentAddress: r.agent_address,
  status: r.status,
  createdAt: r.created_at,
  endsAt: r.ends_at,
  activeAt: r.active_at,
  revokedAt: r.revoked_at,
});

const drawOf = (r: DrawRow): DrawRecord => ({
  userId: r.user_id,
  allowanceId: r.allowance_id,
  orderId: r.order_id,
  symbol: r.symbol,
  side: r.side,
  type: r.order_type,
  size: parseAmount(r.size),
  price: parseAmount(r.price),
  amount: parseAmount(r.amount),
  state: r.state,
  createdAt: r.created_at,
});

const ALLOWANCE_COLUMNS =
  'user_id, allowance_id, agent_id, venue_id, owner, sub_account, asset, amount, period, agent_address, status, created_at, ends_at, active_at, revoked_at';
const DRAW_COLUMNS = 'user_id, allowance_id, order_id, symbol, side, order_type, size, price, amount, state, created_at';

export class SqlAllowanceStore implements AllowanceStore {
  constructor(private readonly sql: Sql) {}

  async find(userId: string, allowanceId: string) {
    const rows = await this.sql<AllowanceRow[]>`
      SELECT ${this.sql.unsafe(ALLOWANCE_COLUMNS)} FROM trade.user_venue_own_agent_allowances
      WHERE user_id = ${userId} AND allowance_id = ${allowanceId}`;
    return rows[0] ? allowanceOf(rows[0]) : null;
  }

  async listForAgent(userId: string, agentId: string) {
    const rows = await this.sql<AllowanceRow[]>`
      SELECT ${this.sql.unsafe(ALLOWANCE_COLUMNS)} FROM trade.user_venue_own_agent_allowances
      WHERE user_id = ${userId} AND agent_id = ${agentId} ORDER BY created_at DESC, allowance_id`;
    return rows.map(allowanceOf);
  }

  async insertOnce(a: AllowanceRecord): Promise<{ stored: AllowanceRecord } | { live: AllowanceRecord }> {
    const existing = await this.find(a.userId, a.allowanceId);
    if (existing) return { stored: existing };
    const inserted = await this.sql<{ allowance_id: string }[]>`
      INSERT INTO trade.user_venue_own_agent_allowances
        (user_id, allowance_id, agent_id, venue_id, owner, sub_account, asset, amount, period, agent_address, status,
         created_at, ends_at)
      VALUES (${a.userId}, ${a.allowanceId}, ${a.agentId}, ${a.venueId}, ${a.owner}, ${a.subAccount}, ${a.asset},
        ${formatAmount(a.amount)}, ${a.period}, ${a.agentAddress}, ${a.status}, ${a.createdAt}, ${a.endsAt})
      ON CONFLICT DO NOTHING
      RETURNING allowance_id`;
    if (inserted.length > 0) return { stored: (await this.find(a.userId, a.allowanceId))! };
    const again = await this.find(a.userId, a.allowanceId);
    if (again) return { stored: again };
    const live = await this.sql<AllowanceRow[]>`
      SELECT ${this.sql.unsafe(ALLOWANCE_COLUMNS)} FROM trade.user_venue_own_agent_allowances
      WHERE user_id = ${a.userId} AND agent_id = ${a.agentId} AND status IN ('signing', 'active')`;
    if (live[0]) return { live: allowanceOf(live[0]) };
    throw new Error(`the allowance ${a.allowanceId} was not stored`);
  }

  private async move(userId: string, allowanceId: string, from: AllowanceStatus, columns: Record<string, unknown>) {
    const names = Object.keys(columns);
    await this.sql`
      UPDATE trade.user_venue_own_agent_allowances SET ${this.sql(columns as Record<string, string>, names)}
      WHERE user_id = ${userId} AND allowance_id = ${allowanceId} AND status = ${from}`;
    const row = await this.find(userId, allowanceId);
    if (!row) throw new Error(`no allowance ${allowanceId}`);
    return row;
  }

  activate(userId: string, allowanceId: string, at: Date) {
    return this.move(userId, allowanceId, 'signing', { status: 'active', active_at: at });
  }

  abandon(userId: string, allowanceId: string) {
    return this.move(userId, allowanceId, 'signing', { status: 'abandoned' });
  }

  revoke(userId: string, allowanceId: string, at: Date) {
    // A plain UPDATE takes the row lock: an admission holding it finishes first, and every one after it reads revoked.
    return this.move(userId, allowanceId, 'active', { status: 'revoked', revoked_at: at });
  }

  async draws(userId: string, allowanceId: string) {
    const rows = await this.sql<DrawRow[]>`
      SELECT ${this.sql.unsafe(DRAW_COLUMNS)} FROM trade.user_venue_own_agent_draws
      WHERE user_id = ${userId} AND allowance_id = ${allowanceId} ORDER BY created_at, order_id`;
    return rows.map(drawOf);
  }

  async findDraw(userId: string, orderId: string) {
    const rows = await this.sql<DrawRow[]>`
      SELECT ${this.sql.unsafe(DRAW_COLUMNS)} FROM trade.user_venue_own_agent_draws WHERE user_id = ${userId} AND order_id = ${orderId}`;
    return rows[0] ? drawOf(rows[0]) : null;
  }

  async admit(d: DrawRecord, now: Date): Promise<AdmitOutcome> {
    return this.sql.begin(async (tx: TransactionSql) => {
      const locked = await tx<AllowanceRow[]>`
        SELECT ${tx.unsafe(ALLOWANCE_COLUMNS)} FROM trade.user_venue_own_agent_allowances
        WHERE user_id = ${d.userId} AND allowance_id = ${d.allowanceId} FOR UPDATE`;
      if (!locked[0]) throw new Error(`no allowance ${d.allowanceId}`);
      const a = allowanceOf(locked[0]);
      const reused = await tx<DrawRow[]>`
        SELECT ${tx.unsafe(DRAW_COLUMNS)} FROM trade.user_venue_own_agent_draws WHERE user_id = ${d.userId} AND order_id = ${d.orderId}`;
      const draws =
        reused[0] && reused[0].allowance_id !== a.allowanceId
          ? [drawOf(reused[0])]
          : (
              await tx<DrawRow[]>`
                SELECT ${tx.unsafe(DRAW_COLUMNS)} FROM trade.user_venue_own_agent_draws
                WHERE user_id = ${d.userId} AND allowance_id = ${a.allowanceId}`
            ).map(drawOf);
      const outcome = decideAdmit(a, draws, d, now);
      if (outcome.admitted && !outcome.replayed) {
        await tx`
          INSERT INTO trade.user_venue_own_agent_draws
            (user_id, allowance_id, order_id, symbol, side, order_type, size, price, amount, state, created_at)
          VALUES (${d.userId}, ${d.allowanceId}, ${d.orderId}, ${d.symbol}, ${d.side}, ${d.type}, ${formatAmount(d.size)},
            ${formatAmount(d.price)}, ${formatAmount(d.amount)}, 'admitted', ${d.createdAt})`;
      }
      return outcome;
    }) as Promise<AdmitOutcome>;
  }

  async refuse(userId: string, orderId: string) {
    await this.sql`
      UPDATE trade.user_venue_own_agent_draws SET state = 'refused'
      WHERE user_id = ${userId} AND order_id = ${orderId} AND state = 'admitted'`;
  }
}
