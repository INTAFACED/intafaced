import { formatAmount, type Amount } from '@intafaced/ledger-client/money';

/**
 * THE LIVE RUN'S OWN ROWS (J-algo-dev-07; src/quant/live-run/live-runs.ts). A live run is a strategy version trading the
 * person's own venue sub-account through an agent permission their wallet signed for a key INTAFACED holds for that run
 * only. These rows are svc-trade's record of what INTAFACED did for the run, never of money: the venue is the record of
 * what the sub-account holds, and the ledger posts nothing. Amounts are scaled bigints in memory and canonical decimal
 * strings in the database.
 *
 *   · the run: its terms (strategy version, sub-account, the cap the key is held to, the restart attempts and the state
 *     policy the person chose, whether the person kept the live-control grant), its state, why it ended, its restart
 *     count, its order sequence and the heartbeat of the process running it;
 *   · its orders, one per business key (`algo:order:<run>:<seq>`, `algo:liquidate:<run>:<seq>`), written before the key
 *     signs, so a crash after the signature reads the venue by that key and never signs a second order;
 *   · its log, one line per thing that happened, with no key, balance or source in it.
 */

export type LiveRunState =
  /** Waiting for the wallet's signature of the run's agent permission. */
  | 'signing'
  /** The process runs the strategy and writes its heartbeat. */
  | 'running'
  /** The process stopped writing its heartbeat: the reconciler reads the venue before anything else is done. */
  | 'unknown'
  /** Stopped by the person (or by the account freeze): no new order; the position is kept. */
  | 'stopped'
  /** Liquidated: the position was closed by one reduce-only order and the run is flat. */
  | 'flat'
  /** Ended by a safeguard (restart attempts exhausted); no new order. */
  | 'ended'
  /** The wallet rejected the agent permission: nothing ever ran. */
  | 'abandoned';

export const LIVE_RUN_STATES: readonly LiveRunState[] = ['signing', 'running', 'unknown', 'stopped', 'flat', 'ended', 'abandoned'];

/** Why a run stopped, typed (AL-live-03 termination reasons, AL-live-04 stop levels). */
export type LiveRunEndReason = 'user_stop' | 'liquidated' | 'attempts_exhausted' | 'account_frozen';

export type LiveRunPermission = 'signing' | 'active' | 'revoked';

export type LiveRunStatePolicy = 'keep' | 'drop';

export interface LiveRunPlanBlock {
  readonly side: 'buy' | 'sell';
  readonly symbol: string;
  readonly qty: Amount;
}

export interface LiveRunRecord {
  readonly userId: string;
  readonly runId: string;
  readonly strategyId: string;
  readonly strategyVersion: number;
  readonly strategyName: string;
  readonly venueId: string;
  readonly owner: string;
  readonly subAccount: string;
  readonly agentAddress: string;
  /** The asset the cap is counted in, and the most notional the run's key may commit (the person's value). */
  readonly asset: string;
  readonly cap: Amount;
  /** The strategy version's order blocks, as read from svc-quant at the start: what the run trades. */
  readonly plan: readonly LiveRunPlanBlock[];
  readonly restartAttempts: number;
  readonly statePolicy: LiveRunStatePolicy;
  /** The person kept the live-control grant on this run: only then are manual orders taken. */
  readonly liveControl: boolean;
  readonly state: LiveRunState;
  readonly endReason: LiveRunEndReason | null;
  readonly permission: LiveRunPermission;
  readonly restarts: number;
  /** The next order sequence number; a number once used is never used again. */
  readonly nextSeq: number;
  /** The strategy's own memory (a tick count for an order-block strategy), kept or dropped on a restart by the policy. */
  readonly strategyState: { readonly ticks: number };
  readonly heartbeatAt: Date | null;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly stoppedAt: Date | null;
  /** The Stop the person pressed (`algo:stop:<run>:<seq>`), so the same Stop again is that Stop. */
  readonly stopSeq: number | null;
}

export type LiveOrderKind = 'strategy' | 'manual' | 'liquidate';
export type LiveOrderState = 'admitted' | 'accepted' | 'refused' | 'unknown';

export interface LiveOrderRecord {
  readonly userId: string;
  readonly runId: string;
  readonly seq: number;
  readonly actionKey: string;
  readonly kind: LiveOrderKind;
  /** For a strategy order, the plan block it places (0-based); null otherwise. */
  readonly block: number | null;
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly type: 'market' | 'limit';
  readonly size: Amount;
  readonly price: Amount;
  readonly reduceOnly: boolean;
  readonly state: LiveOrderState;
  readonly createdAt: Date;
}

export interface LiveRunEvent {
  readonly n: number;
  readonly at: Date;
  readonly kind: string;
  readonly detail: string;
}

export type LiveRunPatch = Partial<
  Pick<
    LiveRunRecord,
    'state' | 'endReason' | 'permission' | 'restarts' | 'strategyState' | 'heartbeatAt' | 'startedAt' | 'stoppedAt' | 'stopSeq'
  >
>;

export interface LiveRunStore {
  find(userId: string, runId: string): Promise<LiveRunRecord | null>;
  listForUser(userId: string): Promise<readonly LiveRunRecord[]>;
  /** Every run a process should be running or reconciling: `running` and `unknown`, of every person. */
  listActive(): Promise<readonly LiveRunRecord[]>;
  insertOnce(run: LiveRunRecord): Promise<LiveRunRecord>;
  /** Changes the run only while it is in one of `from`; answers the run as it is after (changed or not). */
  move(userId: string, runId: string, from: readonly LiveRunState[], patch: LiveRunPatch): Promise<{ run: LiveRunRecord; moved: boolean }>;
  /** The heartbeat and the strategy's memory, only while the run is `running`. */
  beat(userId: string, runId: string, at: Date, strategyState: { readonly ticks: number }): Promise<boolean>;
  /**
   * Takes sequence number `seq` for a new order, written before anything is signed: only when `seq` is the run's next,
   * and only while the run is in one of `states`. The same key again answers the order already written.
   */
  admitOrder(
    order: LiveOrderRecord,
    states: readonly LiveRunState[],
  ): Promise<{ admitted: LiveOrderRecord } | { existing: LiveOrderRecord } | { refused: 'seq' | 'state'; run: LiveRunRecord }>;
  orders(userId: string, runId: string): Promise<readonly LiveOrderRecord[]>;
  setOrderState(userId: string, runId: string, seq: number, state: LiveOrderState): Promise<void>;
  log(userId: string, runId: string, at: Date, kind: string, detail: string): Promise<void>;
  events(userId: string, runId: string): Promise<readonly LiveRunEvent[]>;
}

/** The order business keys of a run: what the venue's client order id derives from. */
export const liveOrderKey = (runId: string, seq: number) => `algo:order:${runId}:${seq}`;
export const liveLiquidateKey = (runId: string, seq: number) => `algo:liquidate:${runId}:${seq}`;
export const liveStopKey = (runId: string, seq: number) => `algo:stop:${runId}:${seq}`;
export const liveApproveKey = (strategyId: string, runId: string) => `algo:deploy:${strategyId}:${runId}:approve`;

export class InMemoryLiveRunStore implements LiveRunStore {
  private readonly runs = new Map<string, LiveRunRecord>();
  private readonly orderRows = new Map<string, LiveOrderRecord[]>();
  private readonly eventRows = new Map<string, LiveRunEvent[]>();

  private id(userId: string, runId: string) {
    return `${userId}:${runId}`;
  }

  async find(userId: string, runId: string) {
    return this.runs.get(this.id(userId, runId)) ?? null;
  }

  async listForUser(userId: string) {
    return [...this.runs.values()]
      .filter((r) => r.userId === userId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.runId < b.runId ? -1 : 1));
  }

  async listActive() {
    return [...this.runs.values()].filter((r) => r.state === 'running' || r.state === 'unknown');
  }

  async insertOnce(run: LiveRunRecord) {
    const k = this.id(run.userId, run.runId);
    const existing = this.runs.get(k);
    if (existing) return existing;
    if ([...this.runs.values()].some((r) => r.agentAddress === run.agentAddress)) throw new Error('agent address reused');
    this.runs.set(k, run);
    return run;
  }

  async move(userId: string, runId: string, from: readonly LiveRunState[], patch: LiveRunPatch) {
    const k = this.id(userId, runId);
    const run = this.runs.get(k);
    if (!run) throw new Error(`no live run ${runId}`);
    if (!from.includes(run.state)) return { run, moved: false };
    const next = { ...run, ...patch };
    this.runs.set(k, next);
    return { run: next, moved: true };
  }

  async beat(userId: string, runId: string, at: Date, strategyState: { readonly ticks: number }) {
    const k = this.id(userId, runId);
    const run = this.runs.get(k);
    if (!run || run.state !== 'running') return false;
    this.runs.set(k, { ...run, heartbeatAt: at, strategyState });
    return true;
  }

  async admitOrder(order: LiveOrderRecord, states: readonly LiveRunState[]) {
    const k = this.id(order.userId, order.runId);
    const run = this.runs.get(k);
    if (!run) throw new Error(`no live run ${order.runId}`);
    const rows = this.orderRows.get(k) ?? [];
    const existing = rows.find((o) => o.actionKey === order.actionKey);
    if (existing) return { existing };
    if (!states.includes(run.state)) return { refused: 'state' as const, run };
    if (order.seq !== run.nextSeq) return { refused: 'seq' as const, run };
    rows.push(order);
    this.orderRows.set(k, rows);
    this.runs.set(k, { ...run, nextSeq: run.nextSeq + 1 });
    return { admitted: order };
  }

  async orders(userId: string, runId: string) {
    return [...(this.orderRows.get(this.id(userId, runId)) ?? [])].sort((a, b) => a.seq - b.seq);
  }

  async setOrderState(userId: string, runId: string, seq: number, state: LiveOrderState) {
    const rows = this.orderRows.get(this.id(userId, runId)) ?? [];
    const i = rows.findIndex((o) => o.seq === seq);
    if (i >= 0) rows[i] = { ...rows[i]!, state };
  }

  async log(userId: string, runId: string, at: Date, kind: string, detail: string) {
    const k = this.id(userId, runId);
    const rows = this.eventRows.get(k) ?? [];
    rows.push({ n: rows.length + 1, at, kind, detail });
    this.eventRows.set(k, rows);
  }

  async events(userId: string, runId: string) {
    return [...(this.eventRows.get(this.id(userId, runId)) ?? [])];
  }
}

/** For the SQL store and the wire: the plan as plain decimal strings. */
export const planOnWire = (plan: readonly LiveRunPlanBlock[]) =>
  plan.map((b) => ({ side: b.side, symbol: b.symbol, qty: formatAmount(b.qty) }));
