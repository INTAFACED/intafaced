import type { Sql, TransactionSql } from 'postgres';
import { formatAmount, parseAmount } from '@intafaced/ledger-client/money';
import {
  planOnWire,
  type LiveOrderRecord,
  type LiveOrderState,
  type LiveRunPatch,
  type LiveRunRecord,
  type LiveRunState,
  type LiveRunStore,
} from './store.js';

/** The live run's rows in Postgres (drizzle/20261112122006_quant_live_runs.sql). */

interface RunRow {
  user_id: string;
  run_id: string;
  strategy_id: string;
  strategy_version: number;
  strategy_name: string;
  venue_id: string;
  region: string;
  owner: string;
  sub_account: string;
  agent_address: string;
  asset: string;
  cap: string;
  plan: Array<{ side: 'buy' | 'sell'; symbol: string; qty: string }>;
  restart_attempts: number;
  state_policy: 'keep' | 'drop';
  live_control: boolean;
  state: LiveRunState;
  end_reason: LiveRunRecord['endReason'];
  permission: LiveRunRecord['permission'];
  restarts: number;
  next_seq: number;
  strategy_state: { ticks: number };
  heartbeat_at: Date | null;
  stop_seq: number | null;
  created_at: Date;
  started_at: Date | null;
  stopped_at: Date | null;
}

interface OrderRow {
  user_id: string;
  run_id: string;
  seq: number;
  action_key: string;
  kind: LiveOrderRecord['kind'];
  block: number | null;
  symbol: string;
  side: 'buy' | 'sell';
  order_type: 'market' | 'limit';
  size: string;
  price: string;
  reduce_only: boolean;
  state: LiveOrderState;
  created_at: Date;
}

const RUN_COLUMNS =
  'user_id, run_id, strategy_id, strategy_version, strategy_name, venue_id, region, owner, sub_account, agent_address, asset, cap, plan, restart_attempts, state_policy, live_control, state, end_reason, permission, restarts, next_seq, strategy_state, heartbeat_at, stop_seq, created_at, started_at, stopped_at';
const ORDER_COLUMNS =
  'user_id, run_id, seq, action_key, kind, block, symbol, side, order_type, size, price, reduce_only, state, created_at';

const runOf = (r: RunRow): LiveRunRecord => ({
  userId: r.user_id,
  runId: r.run_id,
  strategyId: r.strategy_id,
  strategyVersion: r.strategy_version,
  strategyName: r.strategy_name,
  venueId: r.venue_id,
  region: r.region,
  owner: r.owner,
  subAccount: r.sub_account,
  agentAddress: r.agent_address,
  asset: r.asset,
  cap: parseAmount(r.cap),
  plan: r.plan.map((b) => ({ side: b.side, symbol: b.symbol, qty: parseAmount(b.qty) })),
  restartAttempts: r.restart_attempts,
  statePolicy: r.state_policy,
  liveControl: r.live_control,
  state: r.state,
  endReason: r.end_reason,
  permission: r.permission,
  restarts: r.restarts,
  nextSeq: r.next_seq,
  strategyState: { ticks: Number(r.strategy_state?.ticks ?? 0) },
  heartbeatAt: r.heartbeat_at,
  createdAt: r.created_at,
  startedAt: r.started_at,
  stoppedAt: r.stopped_at,
  stopSeq: r.stop_seq,
});

const orderOf = (o: OrderRow): LiveOrderRecord => ({
  userId: o.user_id,
  runId: o.run_id,
  seq: o.seq,
  actionKey: o.action_key,
  kind: o.kind,
  block: o.block,
  symbol: o.symbol,
  side: o.side,
  type: o.order_type,
  size: parseAmount(o.size),
  price: parseAmount(o.price),
  reduceOnly: o.reduce_only,
  state: o.state,
  createdAt: o.created_at,
});

const PATCH_COLUMNS: Record<keyof LiveRunPatch, string> = {
  state: 'state',
  endReason: 'end_reason',
  permission: 'permission',
  restarts: 'restarts',
  strategyState: 'strategy_state',
  heartbeatAt: 'heartbeat_at',
  startedAt: 'started_at',
  stoppedAt: 'stopped_at',
  stopSeq: 'stop_seq',
};

export class SqlLiveRunStore implements LiveRunStore {
  constructor(private readonly sql: Sql) {}

  async find(userId: string, runId: string) {
    const rows = await this.sql<RunRow[]>`
      SELECT ${this.sql.unsafe(RUN_COLUMNS)} FROM trade.quant_live_runs WHERE user_id = ${userId} AND run_id = ${runId}`;
    return rows[0] ? runOf(rows[0]) : null;
  }

  async listForUser(userId: string) {
    const rows = await this.sql<RunRow[]>`
      SELECT ${this.sql.unsafe(RUN_COLUMNS)} FROM trade.quant_live_runs WHERE user_id = ${userId} ORDER BY created_at DESC, run_id`;
    return rows.map(runOf);
  }

  async listActive() {
    const rows = await this.sql<RunRow[]>`
      SELECT ${this.sql.unsafe(RUN_COLUMNS)} FROM trade.quant_live_runs WHERE state IN ('running', 'unknown') ORDER BY created_at, run_id`;
    return rows.map(runOf);
  }

  async insertOnce(r: LiveRunRecord) {
    await this.sql`
      INSERT INTO trade.quant_live_runs
        (user_id, run_id, strategy_id, strategy_version, strategy_name, venue_id, region, owner, sub_account, agent_address, asset, cap,
         plan, restart_attempts, state_policy, live_control, state, end_reason, permission, restarts, next_seq, strategy_state,
         heartbeat_at, stop_seq, created_at, started_at, stopped_at)
      VALUES (${r.userId}, ${r.runId}, ${r.strategyId}, ${r.strategyVersion}, ${r.strategyName}, ${r.venueId}, ${r.region}, ${r.owner},
        ${r.subAccount}, ${r.agentAddress}, ${r.asset}, ${formatAmount(r.cap)}, ${this.sql.json(planOnWire(r.plan))},
        ${r.restartAttempts}, ${r.statePolicy}, ${r.liveControl}, ${r.state}, ${r.endReason}, ${r.permission}, ${r.restarts},
        ${r.nextSeq}, ${this.sql.json(r.strategyState)}, ${r.heartbeatAt}, ${r.stopSeq}, ${r.createdAt}, ${r.startedAt},
        ${r.stoppedAt})
      ON CONFLICT (user_id, run_id) DO NOTHING`;
    const stored = await this.find(r.userId, r.runId);
    if (!stored) throw new Error(`the live run ${r.runId} was not stored`);
    return stored;
  }

  async move(userId: string, runId: string, from: readonly LiveRunState[], patch: LiveRunPatch) {
    const sets: Record<string, unknown> = { updated_at: new Date() };
    for (const [k, v] of Object.entries(patch) as Array<[keyof LiveRunPatch, unknown]>) {
      if (v === undefined) continue;
      sets[PATCH_COLUMNS[k]] = k === 'strategyState' ? this.sql.json(v as { ticks: number }) : v;
    }
    const updated = await this.sql<{ run_id: string }[]>`
      UPDATE trade.quant_live_runs SET ${this.sql(sets as Record<string, string>, Object.keys(sets))}
      WHERE user_id = ${userId} AND run_id = ${runId} AND state IN ${this.sql(from as string[])}
      RETURNING run_id`;
    const run = await this.find(userId, runId);
    if (!run) throw new Error(`no live run ${runId}`);
    return { run, moved: updated.length > 0 };
  }

  async beat(userId: string, runId: string, at: Date, strategyState: { readonly ticks: number }) {
    const updated = await this.sql<{ run_id: string }[]>`
      UPDATE trade.quant_live_runs SET heartbeat_at = ${at}, strategy_state = ${this.sql.json(strategyState)}, updated_at = now()
      WHERE user_id = ${userId} AND run_id = ${runId} AND state = 'running' RETURNING run_id`;
    return updated.length > 0;
  }

  async admitOrder(o: LiveOrderRecord, states: readonly LiveRunState[]) {
    return this.sql.begin(async (tx: TransactionSql) => {
      const locked = await tx<RunRow[]>`
        SELECT ${tx.unsafe(RUN_COLUMNS)} FROM trade.quant_live_runs WHERE user_id = ${o.userId} AND run_id = ${o.runId} FOR UPDATE`;
      if (!locked[0]) throw new Error(`no live run ${o.runId}`);
      const run = runOf(locked[0]);
      const existing = await tx<OrderRow[]>`
        SELECT ${tx.unsafe(ORDER_COLUMNS)} FROM trade.quant_live_run_orders WHERE user_id = ${o.userId} AND action_key = ${o.actionKey}`;
      if (existing[0]) return { existing: orderOf(existing[0]) };
      if (!states.includes(run.state)) return { refused: 'state' as const, run };
      if (o.seq !== run.nextSeq) return { refused: 'seq' as const, run };
      await tx`
        INSERT INTO trade.quant_live_run_orders
          (user_id, run_id, seq, action_key, kind, block, symbol, side, order_type, size, price, reduce_only, state, created_at)
        VALUES (${o.userId}, ${o.runId}, ${o.seq}, ${o.actionKey}, ${o.kind}, ${o.block}, ${o.symbol}, ${o.side}, ${o.type},
          ${formatAmount(o.size)}, ${formatAmount(o.price)}, ${o.reduceOnly}, ${o.state}, ${o.createdAt})`;
      await tx`UPDATE trade.quant_live_runs SET next_seq = next_seq + 1, updated_at = now() WHERE user_id = ${o.userId} AND run_id = ${o.runId}`;
      return { admitted: o };
    }) as Promise<Awaited<ReturnType<LiveRunStore['admitOrder']>>>;
  }

  async orders(userId: string, runId: string) {
    const rows = await this.sql<OrderRow[]>`
      SELECT ${this.sql.unsafe(ORDER_COLUMNS)} FROM trade.quant_live_run_orders WHERE user_id = ${userId} AND run_id = ${runId} ORDER BY seq`;
    return rows.map(orderOf);
  }

  async setOrderState(userId: string, runId: string, seq: number, state: LiveOrderState) {
    await this
      .sql`UPDATE trade.quant_live_run_orders SET state = ${state} WHERE user_id = ${userId} AND run_id = ${runId} AND seq = ${seq}`;
  }

  async log(userId: string, runId: string, at: Date, kind: string, detail: string) {
    await this
      .sql`INSERT INTO trade.quant_live_run_events (user_id, run_id, at, kind, detail) VALUES (${userId}, ${runId}, ${at}, ${kind}, ${detail})`;
  }

  async events(userId: string, runId: string) {
    const rows = await this.sql<Array<{ n: string; at: Date; kind: string; detail: string }>>`
      SELECT n, at, kind, detail FROM trade.quant_live_run_events WHERE user_id = ${userId} AND run_id = ${runId} ORDER BY n`;
    return rows.map((e) => ({ n: Number(e.n), at: e.at, kind: e.kind, detail: e.detail }));
  }
}
