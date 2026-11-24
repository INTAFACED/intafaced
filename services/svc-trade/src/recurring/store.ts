import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { z } from 'zod';

/**
 * The recurring buy's own rows (recurring-buys.ts; drizzle/20261121080000_recurring_buys.sql). Nothing here is a balance:
 * the person's coins and every fill are the venue's record, read from it. A rule says what to buy, how often and for how
 * much on which venue account; a slot row is written before its orders are signed; an order row names one venue order by
 * its business key and keeps what was last read of it from the venue.
 */

/**
 * signing: saved, waiting for the person's wallet to sign the recurring-buy agent permission; nothing bought.
 * active: buys at each slot. suspended_insufficient_funds: a slot found too little free quote; funds arriving resume it.
 * completed: the max investment was reached. terminated: the person ended it; what it bought is converted once.
 */
export type RecurringStatus = 'signing' | 'active' | 'suspended_insufficient_funds' | 'completed' | 'terminated';
export type RecurringFrequency = 'hourly' | 'daily' | 'weekly';
export type SlotOutcome = 'pending' | 'bought' | 'skipped_insufficient_funds' | 'skipped_not_permitted';
export type OrderStatus = 'open' | 'filled' | 'partial' | 'cancelled' | 'refused' | 'skipped_price_range';

export interface BasketRow {
  readonly symbol: string;
  readonly baseAsset: string;
  /** Percent of each slot's amount, two decimals at most; the rows total exactly 100. */
  readonly weightPct: Amount;
  readonly lowestPrice: Amount | null;
  readonly highestPrice: Amount | null;
}

export interface RecurringRule {
  readonly ruleId: string;
  readonly userId: string;
  readonly clientRequestId: string;
  readonly requestHash: string;
  readonly venueId: string;
  /** The person's own venue account (their wallet): the only account the rule's orders are placed on. */
  readonly owner: string;
  readonly agentAddress: string;
  readonly region: string;
  readonly quoteAsset: string;
  readonly basket: readonly BasketRow[];
  readonly amount: Amount;
  readonly frequency: RecurringFrequency;
  readonly maxInvestment: Amount | null;
  readonly status: RecurringStatus;
  readonly statusReason: string | null;
  readonly nextRunAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface RecurringSlot {
  readonly ruleId: string;
  readonly slot: number;
  /** The amount this slot spends, fixed when it was written: a later change of the rule's amount never touches it. */
  readonly amount: Amount;
  readonly outcome: SlotOutcome;
  readonly at: Date;
}

export interface RecurringOrder {
  /** `recurring:<ruleId>:<slot>:<symbol>` or `recurring:<ruleId>:convert:<symbol>`: the door's business key. */
  readonly orderKey: string;
  readonly ruleId: string;
  readonly slot: number | null;
  readonly kind: 'buy' | 'convert';
  readonly symbol: string;
  readonly price: Amount;
  readonly qty: Amount;
  readonly status: OrderStatus;
  /** What the venue reports filled, in the base. */
  readonly filled: Amount;
  /** The quote of the fills (price × amount), before fees. */
  readonly quote: Amount;
  readonly venueFee: Amount;
  readonly builderFee: Amount;
  readonly feeAsset: string | null;
  readonly placedAt: Date;
  readonly closedAt: Date | null;
}

export interface RuleMove {
  readonly ruleId: string;
  readonly status: RecurringStatus;
  readonly reason: string | null;
  readonly at: Date;
  readonly from: readonly RecurringStatus[];
}

/** The next slot time moved from `from` (null: unset) to `to`, only while it is still `from`. */
export interface NextRunMove {
  readonly ruleId: string;
  readonly from: Date | null;
  readonly to: Date | null;
  readonly at: Date;
}

export interface RecurringStore {
  insertOnce(rule: RecurringRule): Promise<{ rule: RecurringRule; created: boolean }>;
  find(ruleId: string): Promise<RecurringRule | null>;
  listForUser(userId: string): Promise<readonly RecurringRule[]>;
  /** Active and suspended rules: the ones the tick may have something to do for. */
  live(): Promise<readonly RecurringRule[]>;
  /** Moves the status only from one of `from`; false when the rule was in another. */
  setStatus(move: RuleMove): Promise<boolean>;
  /** Moves the next slot time only while it is still `from` (null: unset), so one slot is scheduled once. */
  setNextRun(move: NextRunMove): Promise<boolean>;
  setTerms(ruleId: string, terms: { amount: Amount; maxInvestment: Amount | null }, at: Date): Promise<void>;
  slots(ruleId: string): Promise<readonly RecurringSlot[]>;
  /** Writes the slot unless (rule, slot) exists; answers the stored one. */
  insertSlot(slot: RecurringSlot): Promise<RecurringSlot>;
  /**
   * Writes a due slot and moves the next slot time on, both or neither: a failed write leaves the slot due for the next
   * pass. Null, writing nothing, when the next slot time is no longer `move.from` (another pass took this slot).
   */
  scheduleSlot(move: NextRunMove, slot: RecurringSlot): Promise<RecurringSlot | null>;
  setSlotOutcome(ruleId: string, slot: number, outcome: SlotOutcome): Promise<void>;
  orders(ruleId: string): Promise<readonly RecurringOrder[]>;
  /** Writes the order row unless its key exists; answers the stored one. */
  insertOrder(order: RecurringOrder): Promise<RecurringOrder>;
  updateOrder(order: RecurringOrder): Promise<void>;
}

const sameTime = (a: Date | null, b: Date | null) => (a === null ? b === null : b !== null && a.getTime() === b.getTime());

export class InMemoryRecurringStore implements RecurringStore {
  private readonly rules = new Map<string, RecurringRule>();
  private readonly slotRows = new Map<string, RecurringSlot>();
  private readonly rows = new Map<string, RecurringOrder>();

  async insertOnce(rule: RecurringRule) {
    const had = this.rules.get(rule.ruleId);
    if (had) return { rule: had, created: false };
    this.rules.set(rule.ruleId, rule);
    return { rule, created: true };
  }
  async find(ruleId: string) {
    return this.rules.get(ruleId) ?? null;
  }
  async listForUser(userId: string) {
    return [...this.rules.values()].filter((r) => r.userId === userId).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }
  async live() {
    return [...this.rules.values()].filter((r) => r.status === 'active' || r.status === 'suspended_insufficient_funds');
  }
  async setStatus({ ruleId, status, reason, at, from }: RuleMove) {
    const rule = this.rules.get(ruleId);
    if (!rule || !from.includes(rule.status)) return false;
    this.rules.set(ruleId, { ...rule, status, statusReason: reason, updatedAt: at });
    return true;
  }
  async setNextRun({ ruleId, from, to, at }: NextRunMove) {
    const rule = this.rules.get(ruleId);
    if (!rule || !sameTime(rule.nextRunAt, from)) return false;
    this.rules.set(ruleId, { ...rule, nextRunAt: to, updatedAt: at });
    return true;
  }
  async setTerms(ruleId: string, terms: { amount: Amount; maxInvestment: Amount | null }, at: Date) {
    const rule = this.rules.get(ruleId);
    if (rule) this.rules.set(ruleId, { ...rule, ...terms, updatedAt: at });
  }
  /** TEST: the next slot made due `ms` earlier, as the age door does on the table. */
  age(ruleId: string, ms: number) {
    const rule = this.rules.get(ruleId);
    if (rule?.nextRunAt) this.rules.set(ruleId, { ...rule, nextRunAt: new Date(rule.nextRunAt.getTime() - ms) });
  }
  async slots(ruleId: string) {
    return [...this.slotRows.values()].filter((s) => s.ruleId === ruleId).sort((a, b) => a.slot - b.slot);
  }
  async insertSlot(slot: RecurringSlot) {
    const key = `${slot.ruleId}:${slot.slot}`;
    const had = this.slotRows.get(key);
    if (had) return had;
    this.slotRows.set(key, slot);
    return slot;
  }
  async scheduleSlot(move: NextRunMove, slot: RecurringSlot) {
    const rule = this.rules.get(move.ruleId);
    if (!rule || !sameTime(rule.nextRunAt, move.from)) return null;
    const stored = await this.insertSlot(slot);
    await this.setNextRun(move);
    return stored;
  }
  async setSlotOutcome(ruleId: string, slot: number, outcome: SlotOutcome) {
    const key = `${ruleId}:${slot}`;
    const had = this.slotRows.get(key);
    if (had) this.slotRows.set(key, { ...had, outcome });
  }
  async orders(ruleId: string) {
    return [...this.rows.values()].filter((o) => o.ruleId === ruleId).sort((a, b) => a.placedAt.getTime() - b.placedAt.getTime());
  }
  async insertOrder(order: RecurringOrder) {
    const had = this.rows.get(order.orderKey);
    if (had) return had;
    this.rows.set(order.orderKey, order);
    return order;
  }
  async updateOrder(order: RecurringOrder) {
    this.rows.set(order.orderKey, order);
  }
}

const STATUS = z.enum(['signing', 'active', 'suspended_insufficient_funds', 'completed', 'terminated']);
const BASKET = z.array(
  z.object({
    symbol: z.string(),
    baseAsset: z.string(),
    weightPct: z.string(),
    lowestPrice: z.string().nullable(),
    highestPrice: z.string().nullable(),
  }),
);
const when = z.union([z.date(), z.string()]).transform((d) => (d instanceof Date ? d : new Date(d)));

const RuleRow = z.object({
  rule_id: z.string(),
  user_id: z.string(),
  client_request_id: z.string(),
  request_hash: z.string(),
  venue_id: z.string(),
  owner: z.string(),
  agent_address: z.string(),
  region: z.string(),
  quote_asset: z.string(),
  // jsonb comes back parsed, or as its text when the driver is not told it is json.
  basket: z.union([BASKET, z.string().transform((text) => BASKET.parse(JSON.parse(text)))]),
  amount: z.string(),
  frequency: z.enum(['hourly', 'daily', 'weekly']),
  max_investment: z.string().nullable(),
  status: STATUS,
  status_reason: z.string().nullable(),
  next_run_at: when.nullable(),
  created_at: when,
  updated_at: when,
});
type RuleRow = z.infer<typeof RuleRow>;

const SlotRow = z.object({
  rule_id: z.string(),
  slot: z.number().int(),
  amount: z.string(),
  outcome: z.enum(['pending', 'bought', 'skipped_insufficient_funds', 'skipped_not_permitted']),
  at: when,
});

const OrderRow = z.object({
  order_key: z.string(),
  rule_id: z.string(),
  slot: z.number().int().nullable(),
  kind: z.enum(['buy', 'convert']),
  symbol: z.string(),
  price: z.string(),
  qty: z.string(),
  status: z.enum(['open', 'filled', 'partial', 'cancelled', 'refused', 'skipped_price_range']),
  filled: z.string(),
  quote: z.string(),
  venue_fee: z.string(),
  builder_fee: z.string(),
  fee_asset: z.string().nullable(),
  placed_at: when,
  closed_at: when.nullable(),
});
type OrderRow = z.infer<typeof OrderRow>;

const RULE_COLUMNS = `rule_id, user_id, client_request_id, request_hash, venue_id, owner, agent_address, region, quote_asset, basket,
  amount::text AS amount, frequency, max_investment::text AS max_investment, status, status_reason, next_run_at, created_at,
  updated_at`;
const ORDER_COLUMNS = `order_key, rule_id, slot, kind, symbol, price::text AS price, qty::text AS qty, status, filled::text AS filled,
  quote::text AS quote, venue_fee::text AS venue_fee, builder_fee::text AS builder_fee, fee_asset, placed_at, closed_at`;

const maybe = (v: string | null) => (v === null ? null : parseAmount(v));
const maybeText = (v: Amount | null) => (v === null ? null : formatAmount(v));

function ruleOf(r: RuleRow): RecurringRule {
  return {
    ruleId: r.rule_id,
    userId: r.user_id,
    clientRequestId: r.client_request_id,
    requestHash: r.request_hash,
    venueId: r.venue_id,
    owner: r.owner,
    agentAddress: r.agent_address,
    region: r.region,
    quoteAsset: r.quote_asset,
    basket: r.basket.map((b) => ({
      symbol: b.symbol,
      baseAsset: b.baseAsset,
      weightPct: parseAmount(b.weightPct),
      lowestPrice: maybe(b.lowestPrice),
      highestPrice: maybe(b.highestPrice),
    })),
    amount: parseAmount(r.amount),
    frequency: r.frequency,
    maxInvestment: maybe(r.max_investment),
    status: r.status,
    statusReason: r.status_reason,
    nextRunAt: r.next_run_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function orderOf(r: OrderRow): RecurringOrder {
  return {
    orderKey: r.order_key,
    ruleId: r.rule_id,
    slot: r.slot,
    kind: r.kind,
    symbol: r.symbol,
    price: parseAmount(r.price),
    qty: parseAmount(r.qty),
    status: r.status,
    filled: parseAmount(r.filled),
    quote: parseAmount(r.quote),
    venueFee: parseAmount(r.venue_fee),
    builderFee: parseAmount(r.builder_fee),
    feeAsset: r.fee_asset,
    placedAt: r.placed_at,
    closedAt: r.closed_at,
  };
}

/** `trade.recurring_buy_rules`, `trade.recurring_buy_slots` and `trade.recurring_buy_orders`. */
export class SqlRecurringStore implements RecurringStore {
  constructor(private readonly sql: Sql) {}

  async insertOnce(r: RecurringRule) {
    const basket = r.basket.map((b) => ({
      symbol: b.symbol,
      baseAsset: b.baseAsset,
      weightPct: formatAmount(b.weightPct),
      lowestPrice: maybeText(b.lowestPrice),
      highestPrice: maybeText(b.highestPrice),
    }));
    // rule_id is derived from (user_id, client_request_id), so both keys name the same row: no target.
    const inserted = await this.sql`
      INSERT INTO trade.recurring_buy_rules (rule_id, user_id, client_request_id, request_hash, venue_id, owner, agent_address,
        region, quote_asset, basket, amount, frequency, max_investment, status, status_reason, next_run_at, created_at, updated_at)
      VALUES (${r.ruleId}, ${r.userId}, ${r.clientRequestId}, ${r.requestHash}, ${r.venueId}, ${r.owner}, ${r.agentAddress},
        ${r.region}, ${r.quoteAsset}, ${this.sql.json(basket)}, ${formatAmount(r.amount)}, ${r.frequency},
        ${maybeText(r.maxInvestment)}, ${r.status}, ${r.statusReason}, ${r.nextRunAt}, ${r.createdAt}, ${r.updatedAt})
      ON CONFLICT DO NOTHING
      RETURNING rule_id`;
    const stored = await this.find(r.ruleId);
    if (!stored) throw new Error(`recurring buy ${r.ruleId} was not stored`);
    return { rule: stored, created: inserted.length === 1 };
  }

  async find(ruleId: string) {
    const [row] = RuleRow.array().parse(
      await this.sql`SELECT ${this.sql.unsafe(RULE_COLUMNS)} FROM trade.recurring_buy_rules WHERE rule_id = ${ruleId}`,
    );
    return row ? ruleOf(row) : null;
  }

  async listForUser(userId: string) {
    const rows = RuleRow.array().parse(
      await this.sql`SELECT ${this.sql.unsafe(RULE_COLUMNS)} FROM trade.recurring_buy_rules
        WHERE user_id = ${userId} ORDER BY created_at DESC`,
    );
    return rows.map(ruleOf);
  }

  async live() {
    const rows = RuleRow.array().parse(
      await this.sql`SELECT ${this.sql.unsafe(RULE_COLUMNS)} FROM trade.recurring_buy_rules
        WHERE status IN ('active', 'suspended_insufficient_funds')`,
    );
    return rows.map(ruleOf);
  }

  async setStatus({ ruleId, status, reason, at, from }: RuleMove) {
    const moved = await this.sql`
      UPDATE trade.recurring_buy_rules SET status = ${status}, status_reason = ${reason}, updated_at = ${at}
      WHERE rule_id = ${ruleId} AND status = ANY(${this.sql.array([...from])})`;
    return moved.count === 1;
  }

  async setNextRun({ ruleId, from, to, at }: NextRunMove) {
    const moved = await this.sql`
      UPDATE trade.recurring_buy_rules SET next_run_at = ${to}, updated_at = ${at}
      WHERE rule_id = ${ruleId} AND next_run_at IS NOT DISTINCT FROM ${from}::timestamptz`;
    return moved.count === 1;
  }

  async setTerms(ruleId: string, terms: { amount: Amount; maxInvestment: Amount | null }, at: Date) {
    await this.sql`
      UPDATE trade.recurring_buy_rules SET amount = ${formatAmount(terms.amount)},
        max_investment = ${maybeText(terms.maxInvestment)}, updated_at = ${at}
      WHERE rule_id = ${ruleId}`;
  }

  async slots(ruleId: string) {
    const rows = SlotRow.array().parse(
      await this.sql`SELECT rule_id, slot, amount::text AS amount, outcome, at FROM trade.recurring_buy_slots
        WHERE rule_id = ${ruleId} ORDER BY slot`,
    );
    return rows.map((r) => ({ ruleId: r.rule_id, slot: r.slot, amount: parseAmount(r.amount), outcome: r.outcome, at: r.at }));
  }

  async insertSlot(s: RecurringSlot) {
    await this.sql`
      INSERT INTO trade.recurring_buy_slots (rule_id, slot, amount, outcome, at)
      VALUES (${s.ruleId}, ${s.slot}, ${formatAmount(s.amount)}, ${s.outcome}, ${s.at})
      ON CONFLICT DO NOTHING`;
    const stored = (await this.slots(s.ruleId)).find((x) => x.slot === s.slot);
    if (!stored) throw new Error(`recurring buy slot ${s.ruleId}:${s.slot} was not stored`);
    return stored;
  }

  async scheduleSlot({ ruleId, from, to, at }: NextRunMove, s: RecurringSlot) {
    return this.sql.begin(async (tx) => {
      const moved = await tx`
        UPDATE trade.recurring_buy_rules SET next_run_at = ${to}, updated_at = ${at}
        WHERE rule_id = ${ruleId} AND next_run_at IS NOT DISTINCT FROM ${from}::timestamptz`;
      if (moved.count !== 1) return null;
      await tx`
        INSERT INTO trade.recurring_buy_slots (rule_id, slot, amount, outcome, at)
        VALUES (${s.ruleId}, ${s.slot}, ${formatAmount(s.amount)}, ${s.outcome}, ${s.at})
        ON CONFLICT DO NOTHING`;
      const [row] = SlotRow.array().parse(
        await tx`SELECT rule_id, slot, amount::text AS amount, outcome, at FROM trade.recurring_buy_slots
          WHERE rule_id = ${s.ruleId} AND slot = ${s.slot}`,
      );
      if (!row) throw new Error(`recurring buy slot ${s.ruleId}:${s.slot} was not stored`);
      return { ruleId: row.rule_id, slot: row.slot, amount: parseAmount(row.amount), outcome: row.outcome, at: row.at };
    });
  }

  async setSlotOutcome(ruleId: string, slot: number, outcome: SlotOutcome) {
    await this.sql`UPDATE trade.recurring_buy_slots SET outcome = ${outcome} WHERE rule_id = ${ruleId} AND slot = ${slot}`;
  }

  async orders(ruleId: string) {
    const rows = OrderRow.array().parse(
      await this.sql`SELECT ${this.sql.unsafe(ORDER_COLUMNS)} FROM trade.recurring_buy_orders
        WHERE rule_id = ${ruleId} ORDER BY placed_at, order_key`,
    );
    return rows.map(orderOf);
  }

  async insertOrder(o: RecurringOrder) {
    await this.sql`
      INSERT INTO trade.recurring_buy_orders (order_key, rule_id, slot, kind, symbol, price, qty, status, filled, quote, venue_fee,
        builder_fee, fee_asset, placed_at, closed_at)
      VALUES (${o.orderKey}, ${o.ruleId}, ${o.slot}, ${o.kind}, ${o.symbol}, ${formatAmount(o.price)}, ${formatAmount(o.qty)},
        ${o.status}, ${formatAmount(o.filled)}, ${formatAmount(o.quote)}, ${formatAmount(o.venueFee)}, ${formatAmount(o.builderFee)},
        ${o.feeAsset}, ${o.placedAt}, ${o.closedAt})
      ON CONFLICT DO NOTHING`;
    const [row] = OrderRow.array().parse(
      await this.sql`SELECT ${this.sql.unsafe(ORDER_COLUMNS)} FROM trade.recurring_buy_orders WHERE order_key = ${o.orderKey}`,
    );
    if (!row) throw new Error(`recurring buy order ${o.orderKey} was not stored`);
    return orderOf(row);
  }

  async updateOrder(o: RecurringOrder) {
    await this.sql`
      UPDATE trade.recurring_buy_orders SET status = ${o.status}, filled = ${formatAmount(o.filled)}, quote = ${formatAmount(o.quote)},
        venue_fee = ${formatAmount(o.venueFee)}, builder_fee = ${formatAmount(o.builderFee)}, fee_asset = ${o.feeAsset},
        closed_at = ${o.closedAt}
      WHERE order_key = ${o.orderKey}`;
  }
}

/** The TEST age door's subject: the rule's next slot made due `ms` earlier, as if that time had gone by. */
export function ageRecurringBuy(sql: Sql) {
  return async (id: string, ms: number) => {
    const [row] = z
      .object({ next_run_at: when })
      .array()
      .parse(
        await sql`
          UPDATE trade.recurring_buy_rules SET next_run_at = next_run_at - make_interval(secs => ${ms / 1000})
          WHERE rule_id = ${id} AND next_run_at IS NOT NULL AND status IN ('active', 'suspended_insufficient_funds')
          RETURNING next_run_at`,
      );
    return row ? { nextRunAt: row.next_run_at.toISOString() } : null;
  };
}
