import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import type { Principal } from '@intafaced/auth';
import { add, compare, div, formatAmount, mul, parseAmount, sub, ZERO, type Amount } from '@intafaced/ledger-client/money';
import { isTestVenue, type UserVenueBalance } from '@intafaced/venue-contracts';
import { assertPerson } from './agent-account.js';
import { OwnAgentTradingError, type OwnAgentTradingCode, type OwnAgentOrderView, type OwnAgentTrading } from './own-agent-trading.js';

/**
 * THE PORTFOLIO PLANNER'S REBALANCE OF A PERSON'S OWN AGENT'S SUB-ACCOUNT (J-agents-18 #1 #2; RC-agents-03,
 * AG-approvals-01, AG-spend-03).
 *
 * The person asks for a rebalance to target weights they set: the planner reads what the sub-account holds, as the
 * venue reports it, values each asset at the venue's own mid in the allowance's asset, and proposes the market orders
 * that bring it to the targets, sells first, each in whole lots. A proposal executes nothing: it is stored with its
 * orders, each with an order id derived from the proposal's own id, and nothing is signed or sent.
 *
 * Approving one checks first that every order fits in what the agent's allowance has left at today's worst prices
 * (`agents.rebalance_exceeds_allowance`, nothing sent), then places each order through `OwnAgentTrading.place`: under
 * svc-agents' gate, the allowance's row lock and the agent permission the person's wallet signed, on their own venue
 * sub-account only. Each order is sent once under `agent:order:<agentId>:<orderId>`; approving again (a lost answer, a
 * double press) is the same orders, read back from the venue, never a second one. Rejecting one changes nothing on the
 * venue or the allowance, and a rejected proposal is never approved.
 *
 * INTAFACED holds and moves nothing: the venue is the record of the sub-account, the ledger posts nothing, and no profit
 * share is paid. Crash points: before the approval is stored nothing is sent; after it, each order is the allowance's
 * draw under its own id, so approving again resumes and never doubles.
 */

export type RebalanceStatus = 'proposed' | 'approved' | 'rejected';

export type RebalanceCode =
  | OwnAgentTradingCode
  | 'agents.rebalance_target_unset'
  | 'agents.rebalance_target_invalid'
  | 'agents.rebalance_nothing_held'
  | 'agents.rebalance_nothing_to_do'
  | 'agents.rebalance_unknown'
  | 'agents.rebalance_rejected'
  | 'agents.rebalance_approved'
  | 'agents.rebalance_allowance_changed'
  | 'agents.rebalance_exceeds_allowance';

export interface RebalanceHolding {
  readonly asset: string;
  /** What the venue reports the sub-account holds, free and locked. */
  readonly total: Amount;
  /** The venue's mid in the allowance's asset (1 for the allowance's asset itself). */
  readonly price: Amount;
  readonly value: Amount;
}

export interface RebalanceOrder {
  readonly orderId: string;
  readonly symbol: string;
  readonly base: string;
  readonly side: 'buy' | 'sell';
  readonly size: Amount;
  /** The worst price the market order may fill at, when proposed. */
  readonly price: Amount;
  /** What it commits against the allowance: size × worst price. */
  readonly notional: Amount;
}

export interface RebalanceRecord {
  readonly userId: string;
  readonly proposalId: string;
  readonly agentId: string;
  readonly allowanceId: string;
  readonly subAccount: string;
  readonly asset: string;
  /** Each asset's target, in percent of the sub-account's value; the allowance's asset takes the rest. */
  readonly targets: readonly { readonly asset: string; readonly percent: Amount }[];
  readonly holdings: readonly RebalanceHolding[];
  readonly totalValue: Amount;
  readonly orders: readonly RebalanceOrder[];
  readonly status: RebalanceStatus;
  readonly createdAt: Date;
  readonly decidedAt: Date | null;
}

export interface RebalanceView extends RebalanceRecord {
  readonly test: boolean;
}

export interface RebalanceStore {
  find(userId: string, proposalId: string): Promise<RebalanceRecord | null>;
  /** The agent's proposals, newest first. */
  listForAgent(userId: string, agentId: string): Promise<readonly RebalanceRecord[]>;
  /** Stores the proposal unless one with its id exists, which is returned as it is. */
  insertOnce(r: RebalanceRecord): Promise<RebalanceRecord>;
  /** Proposed → approved or rejected, once; a decided one is returned as it was decided. */
  decide(userId: string, proposalId: string, status: 'approved' | 'rejected', at: Date): Promise<RebalanceRecord>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERCENT_RE = /^[0-9]+(\.[0-9]+)?$/;
const HUNDRED = parseAmount('100');
const ONE = parseAmount('1');

function fail(code: RebalanceCode, message: string, status: number, detail: Record<string, unknown> = {}): never {
  throw new OwnAgentTradingError(code, message, status, detail);
}

function uuid(value: unknown, label: string): string {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!UUID_RE.test(v)) fail('agents.allowance_request_invalid', `${label} must be a UUID`, 400);
  return v;
}

/** The id of a proposal's n-th order: derived from the proposal's own id, so the same proposal is always the same orders. */
export function rebalanceOrderId(proposalId: string, n: number): string {
  const h = createHash('sha256').update(`rebalance:${proposalId}:order:${n}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** The person's targets: every asset named once, a percent from 0 to 100, together no more than 100. */
function targetsOf(raw: unknown, quote: string): { asset: string; percent: Amount }[] {
  if (!Array.isArray(raw) || raw.length === 0)
    fail('agents.rebalance_target_unset', 'set a target for each asset the sub-account holds', 422, { field: 'targets' });
  const out: { asset: string; percent: Amount }[] = [];
  let total = ZERO;
  for (const t of raw as unknown[]) {
    const row = (t ?? {}) as Record<string, unknown>;
    const asset = typeof row.asset === 'string' ? row.asset.trim().toUpperCase() : '';
    if (!/^[A-Z0-9]{2,16}$/.test(asset)) fail('agents.rebalance_target_invalid', 'each target names an asset symbol', 422);
    if (asset === quote) fail('agents.rebalance_target_invalid', `${quote} takes what the other targets leave`, 422, { asset });
    if (out.some((x) => x.asset === asset)) fail('agents.rebalance_target_invalid', `${asset} is named twice`, 422, { asset });
    const text = typeof row.percent === 'string' ? row.percent.trim() : '';
    if (text === '') fail('agents.rebalance_target_unset', `the target for ${asset} is blank`, 422, { asset });
    if (!PERCENT_RE.test(text)) fail('agents.rebalance_target_invalid', `the target for ${asset} must be a decimal string`, 422, { asset });
    const percent = parseAmount(text);
    if (compare(percent, HUNDRED) > 0) fail('agents.rebalance_target_invalid', `the target for ${asset} is above 100`, 422, { asset });
    total = add(total, percent);
    out.push({ asset, percent });
  }
  if (compare(total, HUNDRED) > 0) fail('agents.rebalance_target_invalid', 'the targets add up to more than 100', 422);
  return out;
}

/** `x` down to a whole number of `step`s. */
function wholeSteps(x: Amount, step: Amount): Amount {
  const r = div(x, step, 'floor');
  return mul(r - (r % ONE), step);
}

export class OwnAgentRebalance {
  constructor(private readonly deps: { readonly trading: OwnAgentTrading; readonly store: RebalanceStore; readonly now: () => Date }) {}

  /**
   * #1: a proposal listing each order, and nothing executed. Reads the venue's own record of the sub-account and its
   * books; stores the proposal; signs and sends nothing. The same proposal id again is the proposal already stored.
   */
  async propose(principal: Principal, agentIdRaw: string, req: Record<string, unknown>): Promise<RebalanceView> {
    assertPerson(principal);
    const proposalId = uuid(req.proposalId, 'proposalId');
    const earlier = await this.deps.store.find(principal.userId, proposalId);
    const room = await this.deps.trading.rebalanceRoom(principal, agentIdRaw);
    if (earlier) {
      if (earlier.agentId !== room.agentId) fail('agents.rebalance_unknown', `proposal ${proposalId} belongs to another agent`, 404);
      return { ...earlier, test: isTestVenue(room.venue.venue) };
    }
    const quote = room.allowance.asset;
    const targets = targetsOf(req.targets, quote);
    const balances = (await room.venue.balances(room.account)).value.filter((b: UserVenueBalance) => compare(b.total, ZERO) > 0);
    for (const b of balances) {
      if (b.asset !== quote && !targets.some((t) => t.asset === b.asset))
        fail('agents.rebalance_target_unset', `the sub-account holds ${b.asset}: set a target for it`, 422, { asset: b.asset });
    }
    // Every asset is valued at the venue's own mid, through the same terms an order would get.
    const held = new Map(balances.map((b) => [b.asset, b.total]));
    const assets = [...new Set([quote, ...targets.map((t) => t.asset)])];
    const holdings: RebalanceHolding[] = [];
    const lots = new Map<string, Amount>();
    for (const asset of assets) {
      const total = held.get(asset) ?? ZERO;
      if (asset === quote) {
        holdings.push({ asset, total, price: ONE, value: total });
        continue;
      }
      const buy = await this.deps.trading.quote(room.venue, room.allowance, { side: 'buy', base: asset, size: ONE });
      const sell = await this.deps.trading.quote(room.venue, room.allowance, { side: 'sell', base: asset, size: ONE });
      const price = div(add(buy.price, sell.price), parseAmount('2'), 'half-up');
      lots.set(asset, buy.lotSize);
      holdings.push({ asset, total, price, value: mul(total, price, 'floor') });
    }
    const totalValue = holdings.reduce((s, h) => add(s, h.value), ZERO);
    if (compare(totalValue, ZERO) <= 0) fail('agents.rebalance_nothing_held', 'the sub-account holds nothing to rebalance', 422);
    const legs: { base: string; side: 'buy' | 'sell'; size: Amount }[] = [];
    for (const t of targets) {
      const h = holdings.find((x) => x.asset === t.asset)!;
      const want = div(mul(totalValue, t.percent, 'floor'), HUNDRED, 'floor');
      const delta = sub(want, h.value);
      if (compare(delta, ZERO) === 0) continue;
      const side = compare(delta, ZERO) > 0 ? 'buy' : 'sell';
      const raw = div(side === 'buy' ? delta : sub(ZERO, delta), h.price, 'floor');
      // A sell never asks for more than is held; each size is in whole lots, and a leg under one lot is left out.
      const size = wholeSteps(side === 'sell' && compare(raw, h.total) > 0 ? h.total : raw, lots.get(t.asset)!);
      if (compare(size, ZERO) > 0) legs.push({ base: t.asset, side, size });
    }
    if (legs.length === 0)
      fail('agents.rebalance_nothing_to_do', 'the sub-account is within one lot of every target: no order is needed', 422);
    legs.sort((x, y) => (x.side === y.side ? (x.base < y.base ? -1 : 1) : x.side === 'sell' ? -1 : 1));
    const orders: RebalanceOrder[] = [];
    for (const [n, leg] of legs.entries()) {
      const q = await this.deps.trading.quote(room.venue, room.allowance, leg);
      orders.push({
        orderId: rebalanceOrderId(proposalId, n),
        symbol: q.symbol,
        base: leg.base,
        side: leg.side,
        size: leg.size,
        price: q.price,
        notional: q.notional,
      });
    }
    const stored = await this.deps.store.insertOnce({
      userId: principal.userId,
      proposalId,
      agentId: room.agentId,
      allowanceId: room.allowance.allowanceId,
      subAccount: room.allowance.subAccount,
      asset: quote,
      targets,
      holdings,
      totalValue,
      orders,
      status: 'proposed',
      createdAt: this.deps.now(),
      decidedAt: null,
    });
    return { ...stored, test: isTestVenue(room.venue.venue) };
  }

  private async own(principal: Principal, agentId: string, proposalIdRaw: string): Promise<RebalanceRecord> {
    const proposalId = uuid(proposalIdRaw, 'proposalId');
    const r = await this.deps.store.find(principal.userId, proposalId);
    if (!r || r.agentId !== agentId) fail('agents.rebalance_unknown', `no proposal ${proposalId} for this agent`, 404);
    return r;
  }

  /**
   * #2: the approved orders placed on the person's own sub-account under the agent permission, within the allowance.
   * Checked whole before anything is sent; then each order once, by its own id.
   */
  async approve(
    principal: Principal,
    agentIdRaw: string,
    proposalIdRaw: string,
  ): Promise<{ proposal: RebalanceView; orders: readonly OwnAgentOrderView[] }> {
    const room = await this.deps.trading.rebalanceRoom(principal, agentIdRaw);
    let r = await this.own(principal, room.agentId, proposalIdRaw);
    if (r.status === 'rejected')
      fail('agents.rebalance_rejected', 'this proposal was rejected, so it is never placed; ask for a new one', 409);
    if (r.status === 'proposed') {
      if (r.allowanceId !== room.allowance.allowanceId)
        fail('agents.rebalance_allowance_changed', 'the agent’s allowance changed since this proposal; ask for a new one', 409);
      let needed = ZERO;
      for (const o of r.orders) needed = add(needed, (await this.deps.trading.quote(room.venue, room.allowance, o)).notional);
      if (compare(needed, room.left) > 0)
        fail(
          'agents.rebalance_exceeds_allowance',
          `these orders commit ${formatAmount(needed)} ${r.asset}; the allowance has ${formatAmount(room.left)} left; nothing was sent`,
          422,
          { needed: formatAmount(needed), left: formatAmount(room.left), asset: r.asset },
        );
      r = await this.deps.store.decide(principal.userId, r.proposalId, 'approved', this.deps.now());
      if (r.status === 'rejected') fail('agents.rebalance_rejected', 'this proposal was rejected, so it is never placed', 409);
    }
    const placed: OwnAgentOrderView[] = [];
    for (const o of r.orders) {
      placed.push(
        await this.deps.trading.place(principal, room.agentId, {
          orderId: o.orderId,
          side: o.side,
          base: o.base,
          size: formatAmount(o.size),
          type: 'market',
        }),
      );
    }
    return { proposal: { ...r, test: isTestVenue(room.venue.venue) }, orders: placed };
  }

  /** #2: rejected, and nothing changes: no order is signed or sent, and the allowance is untouched. */
  async reject(principal: Principal, agentIdRaw: string, proposalIdRaw: string): Promise<RebalanceView> {
    assertPerson(principal);
    const agentId = uuid(agentIdRaw, 'agentId');
    const r = await this.own(principal, agentId, proposalIdRaw);
    if (r.status === 'approved')
      fail('agents.rebalance_approved', 'this proposal was approved and its orders sent; it can no longer be rejected', 409);
    const decided = await this.deps.store.decide(principal.userId, r.proposalId, 'rejected', this.deps.now());
    if (decided.status !== 'rejected') fail('agents.rebalance_approved', 'this proposal was approved first', 409);
    return { ...decided, test: await this.deps.trading.onTestVenue() };
  }

  async list(principal: Principal, agentIdRaw: string): Promise<readonly RebalanceRecord[]> {
    assertPerson(principal);
    return this.deps.store.listForAgent(principal.userId, uuid(agentIdRaw, 'agentId'));
  }
}

export class InMemoryRebalanceStore implements RebalanceStore {
  private readonly rows = new Map<string, RebalanceRecord>();

  async find(userId: string, proposalId: string) {
    const r = this.rows.get(proposalId);
    return r && r.userId === userId ? r : null;
  }

  async listForAgent(userId: string, agentId: string) {
    return [...this.rows.values()]
      .filter((r) => r.userId === userId && r.agentId === agentId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async insertOnce(r: RebalanceRecord) {
    const existing = this.rows.get(r.proposalId);
    if (existing) return existing;
    this.rows.set(r.proposalId, r);
    return r;
  }

  async decide(userId: string, proposalId: string, status: 'approved' | 'rejected', at: Date) {
    const r = await this.find(userId, proposalId);
    if (!r) throw new Error(`no proposal ${proposalId}`);
    if (r.status !== 'proposed') return r;
    const next = { ...r, status, decidedAt: at };
    this.rows.set(proposalId, next);
    return next;
  }
}

type Row = {
  user_id: string;
  proposal_id: string;
  agent_id: string;
  allowance_id: string;
  sub_account: string;
  asset: string;
  targets: { asset: string; percent: string }[];
  holdings: { asset: string; total: string; price: string; value: string }[];
  total_value: string;
  orders: { orderId: string; symbol: string; base: string; side: 'buy' | 'sell'; size: string; price: string; notional: string }[];
  status: RebalanceStatus;
  created_at: Date;
  decided_at: Date | null;
};

function recordOf(r: Row): RebalanceRecord {
  return {
    userId: r.user_id,
    proposalId: r.proposal_id,
    agentId: r.agent_id,
    allowanceId: r.allowance_id,
    subAccount: r.sub_account,
    asset: r.asset,
    targets: r.targets.map((t) => ({ asset: t.asset, percent: parseAmount(t.percent) })),
    holdings: r.holdings.map((h) => ({
      asset: h.asset,
      total: parseAmount(h.total),
      price: parseAmount(h.price),
      value: parseAmount(h.value),
    })),
    totalValue: parseAmount(r.total_value),
    orders: r.orders.map((o) => ({ ...o, size: parseAmount(o.size), price: parseAmount(o.price), notional: parseAmount(o.notional) })),
    status: r.status,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
  };
}

/** `trade.user_venue_own_agent_rebalances` (drizzle/20261115150000_user_venue_own_agent_rebalances.sql). */
export class SqlRebalanceStore implements RebalanceStore {
  constructor(private readonly sql: Sql) {}

  async find(userId: string, proposalId: string) {
    const rows = await this.sql<Row[]>`
      SELECT * FROM trade.user_venue_own_agent_rebalances WHERE user_id = ${userId} AND proposal_id = ${proposalId}`;
    return rows[0] ? recordOf(rows[0]) : null;
  }

  async listForAgent(userId: string, agentId: string) {
    const rows = await this.sql<Row[]>`
      SELECT * FROM trade.user_venue_own_agent_rebalances WHERE user_id = ${userId} AND agent_id = ${agentId}
      ORDER BY created_at DESC, proposal_id`;
    return rows.map(recordOf);
  }

  async insertOnce(r: RebalanceRecord) {
    const targets = r.targets.map((t) => ({ asset: t.asset, percent: formatAmount(t.percent) }));
    const holdings = r.holdings.map((h) => ({
      asset: h.asset,
      total: formatAmount(h.total),
      price: formatAmount(h.price),
      value: formatAmount(h.value),
    }));
    const orders = r.orders.map((o) => ({
      orderId: o.orderId,
      symbol: o.symbol,
      base: o.base,
      side: o.side,
      size: formatAmount(o.size),
      price: formatAmount(o.price),
      notional: formatAmount(o.notional),
    }));
    await this.sql`
      INSERT INTO trade.user_venue_own_agent_rebalances
        (user_id, proposal_id, agent_id, allowance_id, sub_account, asset, targets, holdings, total_value, orders, status, created_at)
      VALUES (${r.userId}, ${r.proposalId}, ${r.agentId}, ${r.allowanceId}, ${r.subAccount}, ${r.asset},
        ${this.sql.json(targets)}, ${this.sql.json(holdings)}, ${formatAmount(r.totalValue)}, ${this.sql.json(orders)},
        'proposed', ${r.createdAt})
      ON CONFLICT DO NOTHING`;
    return (await this.find(r.userId, r.proposalId))!;
  }

  async decide(userId: string, proposalId: string, status: 'approved' | 'rejected', at: Date) {
    await this.sql`
      UPDATE trade.user_venue_own_agent_rebalances SET status = ${status}, decided_at = ${at}
      WHERE user_id = ${userId} AND proposal_id = ${proposalId} AND status = 'proposed'`;
    const r = await this.find(userId, proposalId);
    if (!r) throw new Error(`no proposal ${proposalId}`);
    return r;
  }
}
