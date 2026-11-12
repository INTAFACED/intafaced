import { add, compare, div, formatAmount, mul, parseAmount, sub, ZERO, type Amount } from '@intafaced/ledger-client/money';
import type { Principal } from '@intafaced/auth';
import type { TypedDataDefinition } from 'viem';
import {
  CappedAgentSigner,
  VenueRefusalError,
  hasSubAccountReads,
  isTestVenue,
  type AgentCap,
  type AgentCapMarks,
  type AgentDrainBounds,
  type PlaceUserOrderIntent,
  type PreparedVenueAction,
  type UserVenue,
  type UserVenueAccount,
  type UserVenueBalance,
  type UserVenueFill,
  type UserVenueOrder,
  type UserVenuePosition,
  type VenueSignature,
} from '@intafaced/venue-contracts';
import { agentAddressFor, agentKeyFor } from '../../venue/agent-key.js';
import type { UserVenueDoor } from '../../venue/user-venue-door.js';
import { AccountFreezeUnavailable, StrategySourceUnavailable, type AccountFreezeRead, type StrategySource } from './ports.js';
import {
  liveApproveKey,
  liveLiquidateKey,
  liveOrderKey,
  liveStopKey,
  planOnWire,
  type LiveOrderKind,
  type LiveOrderRecord,
  type LiveRunEvent,
  type LiveRunPlanBlock,
  type LiveRunRecord,
  type LiveRunState,
  type LiveRunStatePolicy,
  type LiveRunStore,
} from './store.js';

/**
 * STOP, LIQUIDATE OR RECOVER A LIVE STRATEGY (J-algo-dev-07; AL-live-03, AL-live-04).
 *
 * A live run trades one strategy version's order blocks on the person's own venue sub-account. The person's wallet signs
 * the venue's agent permission for a key INTAFACED holds for that run alone (agent-key.ts, derived from the run id); the
 * key can trade that sub-account and nothing else (the venue refuses it a withdrawal or an approval). Every order the key
 * signs is held first to the run's cap and the owner's drain bounds (`CappedAgentSigner`).
 *
 * MONEY. INTAFACED holds and moves nothing and the ledger posts nothing: the funds sit in the person's sub-account, which
 * their own wallet controls, and the venue is the record of cash, positions and fills; every figure shown is read from it
 * with its as-of time. Orders are ordinary venue orders under business keys: `algo:order:<run>:<seq>` for the strategy's
 * and the person's manual orders, `algo:liquidate:<run>:<seq>` for the one reduce-only close; the venue's client order id
 * derives from the key. A sequence number once taken is never taken again.
 *
 * Crash points (whose funds are stranded? none, ever):
 *   · an order row is written before the key signs; a crash before the signature leaves an order never sent, which the
 *     reconciler marks refused (its number is never reused); after the signature the door stores the bytes before they
 *     are sent, so the retry and the reconciler read the venue by the client order id and re-send only those bytes;
 *   · a Stop cancels the open orders first and writes `stopped` after; a crash between replays the same Stop (same key)
 *     and finishes it; the position stays in the person's sub-account throughout;
 *   · a dead process (no heartbeat for the owner's interval) leaves the run `unknown`: the reconciler reads every order
 *     by its key, and the supervisor restarts it within the person's attempt count, reloading open orders and positions
 *     from the venue, never from memory; with the attempts spent the run ends `attempts_exhausted` and places nothing.
 *
 * The account freeze (J-wallet-13) is svc-identity's: the supervisor reads it, and a frozen person's runs are stopped
 * (open orders cancelled, the position kept) and their agent permission revoked here, so INTAFACED's key for them signs
 * nothing more. A liquidation while frozen is refused with the freeze reason and the run stays as it is.
 */

export type LiveRunCode =
  | 'quant.live_disabled'
  | 'quant.heartbeat_interval_unset'
  | 'quant.restart_attempts_unset'
  | 'quant.restart_attempts_invalid'
  | 'quant.state_policy_unset'
  | 'quant.live_cap_unset'
  | 'quant.live_cap_invalid'
  | 'quant.live_key_unset'
  | 'quant.live_request_invalid'
  | 'quant.live_plan_unsupported'
  | 'quant.live_plan_unavailable'
  | 'quant.studio_not_found'
  | 'quant.live_sub_account_unknown'
  | 'quant.live_run_reused'
  | 'quant.run_not_found'
  | 'quant.run_not_running'
  | 'quant.run_not_signing'
  | 'quant.permission_denied'
  | 'quant.account_frozen'
  | 'quant.freeze_unavailable'
  | 'quant.order_seq_invalid'
  | 'quant.order_reused'
  | 'quant.order_rejected'
  | 'quant.nothing_to_liquidate'
  | 'quant.stop_unavailable'
  | 'quant.live_test_only';

export class LiveRunError extends Error {
  constructor(
    readonly code: LiveRunCode,
    message: string,
    readonly status: number,
    readonly detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'LiveRunError';
  }
}

function fail(code: LiveRunCode, message: string, status: number, detail: Readonly<Record<string, unknown>> = {}): never {
  throw new LiveRunError(code, message, status, detail);
}

export interface LiveRunValues {
  /** `TRADE_QUANT_LIVE`: on only where live strategies may run (a test stack today). Off, every start refuses. */
  readonly enabled: boolean;
  /** `TRADE_QUANT_LIVE_HEARTBEAT_MS`: the owner's heartbeat interval. Blank refuses every start. */
  readonly heartbeatMs: number | null;
  /** The asset a run's cap is counted in (`TRADE_AGENT_ACCOUNT_ASSET`) and the secret run keys derive from. */
  readonly asset: string | null;
  readonly keySeed: string | null;
  /** The owner's drain bounds every agent order is held to (worst price, largest order, markets). */
  readonly bounds: AgentDrainBounds;
}

export function parseLiveRunValues(
  env: Record<string, string | undefined>,
  shared: { asset: string | null; keySeed: string | null; bounds: AgentDrainBounds },
): LiveRunValues {
  const hb = (env.TRADE_QUANT_LIVE_HEARTBEAT_MS ?? '').trim();
  const heartbeatMs = /^\d+$/.test(hb) && Number(hb) >= 200 ? Number(hb) : null;
  return { enabled: (env.TRADE_QUANT_LIVE ?? '').trim() === 'on', heartbeatMs, ...shared };
}

export interface LiveRunsDeps {
  readonly door: UserVenueDoor;
  readonly store: LiveRunStore;
  readonly values: LiveRunValues;
  readonly strategies: StrategySource | null;
  readonly freeze: AccountFreezeRead | null;
  readonly now: () => Date;
}

export interface LiveRunView {
  readonly runId: string;
  readonly strategyId: string;
  readonly strategyVersion: number;
  readonly strategyName: string;
  readonly owner: string;
  readonly subAccount: string;
  readonly agentAddress: string;
  readonly asset: string;
  readonly cap: Amount;
  readonly plan: ReturnType<typeof planOnWire>;
  readonly state: LiveRunState;
  readonly endReason: LiveRunRecord['endReason'];
  readonly permission: LiveRunRecord['permission'];
  readonly liveControl: boolean;
  readonly nextSeq: number;
  readonly stopSeq: number | null;
  readonly health: {
    readonly restarts: number;
    readonly restartAttempts: number;
    readonly statePolicy: LiveRunStatePolicy;
    readonly strategyTicks: number;
    readonly heartbeatAt: Date | null;
    readonly heartbeatMs: number | null;
  };
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly stoppedAt: Date | null;
  /** What the wallet is asked to sign next (the run's agent permission), if anything. */
  readonly next: { readonly actionKey: string; readonly prepared: PreparedVenueAction; readonly signed: boolean } | null;
  readonly test: boolean;
}

export interface LiveOrderView {
  readonly seq: number;
  readonly actionKey: string;
  readonly kind: LiveOrderKind;
  readonly symbol: string;
  readonly side: 'buy' | 'sell';
  readonly type: 'market' | 'limit';
  readonly size: Amount;
  readonly price: Amount;
  readonly reduceOnly: boolean;
  readonly state: LiveOrderRecord['state'];
  /** The venue's record of the order by its client order id, when it has one. */
  readonly order: UserVenueOrder | null;
}

export interface LiveRunDetail extends LiveRunView {
  readonly orders: readonly LiveOrderView[];
  /** The sub-account as the venue reports it now: cash, positions, open orders and every fill since the run started. */
  readonly venue: {
    readonly asOf: Date;
    readonly balances: readonly UserVenueBalance[];
    readonly positions: readonly UserVenuePosition[];
    readonly openOrders: readonly UserVenueOrder[];
    readonly fills: readonly UserVenueFill[];
  } | null;
  readonly venueError: string | null;
  readonly log: readonly LiveRunEvent[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const TEN_THOUSAND = parseAmount('10000');
const TWO = parseAmount('2');
/** Where a run may still place or cancel (the strategy and the person), and where a stop still has work to do. */
const STOPPABLE: readonly LiveRunState[] = ['running', 'unknown'];

function uuid(raw: unknown, field: string): string {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!UUID_RE.test(v)) fail('quant.live_request_invalid', `${field} must be a uuid`, 400, { field });
  return v;
}

function address(raw: unknown, field: string): string {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!ADDRESS_RE.test(v)) fail('quant.live_request_invalid', `${field} must be a 0x address`, 400, { field });
  return v;
}

function seqOf(raw: unknown): number {
  const v = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!Number.isSafeInteger(v) || v < 1) fail('quant.live_request_invalid', 'seq must be a whole number from 1', 400, { field: 'seq' });
  return v;
}

function amountOf(raw: unknown, field: string, unset: LiveRunCode): Amount {
  if (raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '')) {
    fail(unset, `${field} is not set`, 422, { field });
  }
  if (typeof raw !== 'string') fail('quant.live_request_invalid', `${field} must be a decimal string`, 400, { field });
  let v: Amount;
  try {
    v = parseAmount(raw.trim());
  } catch {
    fail('quant.live_request_invalid', `${field} must be a decimal string`, 400, { field });
  }
  if (compare(v, ZERO) <= 0) fail('quant.live_request_invalid', `${field} must be more than zero`, 400, { field });
  return v;
}

function toStep(v: Amount, step: Amount, dir: 'up' | 'down'): Amount {
  const r = v % step;
  if (r === ZERO) return v;
  return dir === 'down' ? v - r : v - r + step;
}

/** The person this run belongs to, as the door knows them, for what the supervisor does with no request in hand. */
function ownerPrincipal(userId: string): Principal {
  return {
    sub: userId,
    userId,
    sid: `quant-live-supervisor:${userId}`,
    scopes: ['trade:read', 'trade:write'],
    tier: 'basic',
    mfa: false,
    expiresAt: new Date(Date.now() + 60_000),
  } as Principal;
}

export class LiveRuns {
  /** One capped signer per run key, so two orders of one run can't both fit in the same room. */
  private readonly signers = new Map<string, { signer: CappedAgentSigner; marks: Map<string, Amount | null> }>();
  /** The runs this process is running now: a run whose entry is gone is a dead process to the supervisor. */
  private readonly workers = new Set<string>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private ticking = false;

  constructor(private readonly deps: LiveRunsDeps) {}

  private id(r: { userId: string; runId: string }) {
    return `${r.userId}:${r.runId}`;
  }

  /** One thing at a time per run: the process's step, a Stop, a liquidation, a manual order, a restart. */
  private async locked<T>(r: { userId: string; runId: string }, f: () => Promise<T>): Promise<T> {
    const k = this.id(r);
    const before = this.locks.get(k) ?? Promise.resolve();
    const run = before.then(f, f);
    const settled = run.catch(() => undefined);
    this.locks.set(k, settled);
    try {
      return await run;
    } finally {
      if (this.locks.get(k) === settled) this.locks.delete(k);
    }
  }

  private sub(r: LiveRunRecord): UserVenueAccount {
    return { venueId: r.venueId, owner: r.owner, subAccount: r.subAccount };
  }

  private seed(): string {
    const seed = this.deps.values.keySeed;
    if (seed === null) fail('quant.live_key_unset', 'the agent key secret is not set (owner value blank), so no run can be started', 422);
    return seed;
  }

  private async venue(): Promise<UserVenue> {
    return this.deps.door.venue();
  }

  private async log(r: LiveRunRecord, kind: string, detail: string) {
    await this.deps.store.log(r.userId, r.runId, this.deps.now(), kind, detail);
  }

  private async run(userId: string, runIdRaw: unknown): Promise<LiveRunRecord> {
    const runId = uuid(runIdRaw, 'runId');
    const r = await this.deps.store.find(userId, runId);
    // Another person's run answers exactly as a missing one.
    if (!r) fail('quant.run_not_found', 'no live run with that id on this account', 404);
    return r;
  }

  private async assertNotFrozen(r: LiveRunRecord, action: string): Promise<void> {
    const freeze = this.deps.freeze;
    if (!freeze) fail('quant.freeze_unavailable', `the account freeze can't be read on this deployment, so ${action} is refused`, 503);
    let frozen: boolean;
    try {
      frozen = await freeze.frozen(r.userId);
    } catch (error) {
      if (error instanceof AccountFreezeUnavailable)
        fail('quant.freeze_unavailable', `the account freeze could not be read just now, so ${action} is refused; nothing changed`, 503);
      throw error;
    }
    if (frozen) {
      fail(
        'quant.account_frozen',
        `you froze this account, so INTAFACED takes no action for you: ${action} is refused and the run stays as it is. Your position stays in your own venue account, which only your wallet controls.`,
        423,
      );
    }
  }

  // ── the start (the run the journey starts from; the deploy wizard of J-algo-dev-06 asks this) ───────────────────

  /**
   * Starts a live run of the person's own strategy version on their own venue sub-account. Refused, before anything is
   * stored or asked of the wallet: live off, the owner's heartbeat interval blank, the restart attempts or the state
   * policy blank (AL-live-03: a blank restart-attempt setting refuses the deploy), the cap blank, a strategy that does
   * not trade by order blocks, or a sub-account the venue does not list under the wallet. Then the run is stored
   * `signing` and the wallet is asked to sign the venue's agent permission for the run's key on that sub-account. The
   * same run id again is the same run.
   */
  async start(principal: Principal, forwarded: Record<string, string>, req: Record<string, unknown>): Promise<LiveRunView> {
    const v = this.deps.values;
    if (!v.enabled) fail('quant.live_disabled', 'live strategies are switched off on this deployment; nothing was stored', 409);
    if (v.heartbeatMs === null) {
      fail(
        'quant.heartbeat_interval_unset',
        'the heartbeat interval a live run is watched by is not set (owner value blank), so no run starts',
        422,
      );
    }
    const runId = uuid(req.runId, 'runId');
    const strategyId =
      typeof req.strategyId === 'string' && req.strategyId.trim()
        ? req.strategyId.trim()
        : fail('quant.live_request_invalid', 'strategyId is required', 400, { field: 'strategyId' });
    const strategyVersion = seqOf(req.strategyVersion);
    const attemptsRaw =
      typeof req.restartAttempts === 'string'
        ? req.restartAttempts.trim()
        : typeof req.restartAttempts === 'number'
          ? String(req.restartAttempts)
          : '';
    if (attemptsRaw === '') {
      fail('quant.restart_attempts_unset', 'how many times the run may be restarted is not set, so it is not deployed', 422, {
        field: 'restartAttempts',
      });
    }
    if (!/^\d+$/.test(attemptsRaw) || Number(attemptsRaw) > 10) {
      fail('quant.restart_attempts_invalid', 'restart attempts must be a whole number from 0 to 10', 422, { field: 'restartAttempts' });
    }
    const restartAttempts = Number(attemptsRaw);
    if (req.statePolicy !== 'keep' && req.statePolicy !== 'drop') {
      fail('quant.state_policy_unset', 'whether a restart keeps or drops the strategy state is not set', 422, { field: 'statePolicy' });
    }
    const statePolicy = req.statePolicy;
    const cap = amountOf(req.cap, 'cap', 'quant.live_cap_unset');
    const liveControl = req.liveControl === true;
    const owner = address(req.owner, 'owner');
    const subAccount = address(req.subAccount, 'subAccount');
    if (v.asset === null) fail('quant.live_cap_unset', 'the owner has published no asset a run cap is counted in', 422);
    const seed = this.seed();

    const existing = await this.deps.store.find(principal.userId, runId);
    if (existing) {
      if (
        existing.strategyId !== strategyId ||
        existing.strategyVersion !== strategyVersion ||
        existing.owner !== owner ||
        existing.subAccount !== subAccount ||
        existing.cap !== cap ||
        existing.restartAttempts !== restartAttempts ||
        existing.statePolicy !== statePolicy ||
        existing.liveControl !== liveControl
      ) {
        fail('quant.live_run_reused', `run ${runId} was started with other terms; a new run needs a new id`, 409);
      }
      return this.advance(principal, existing);
    }

    if (!this.deps.strategies) fail('quant.live_plan_unavailable', 'the strategy service is not connected on this deployment', 503);
    let version;
    try {
      version = await this.deps.strategies.version(forwarded, strategyId, strategyVersion);
    } catch (error) {
      if (error instanceof StrategySourceUnavailable)
        fail('quant.live_plan_unavailable', `the strategy could not be read just now (${error.message}); nothing was stored`, 503);
      throw error;
    }
    if (!version) fail('quant.studio_not_found', 'no saved strategy with that id and version on this account', 404);
    if (version.signalRules || version.blocks.length === 0) {
      fail(
        'quant.live_plan_unsupported',
        'only a strategy of order blocks can run live in this build; this version trades by signal rules',
        422,
      );
    }
    const plan: LiveRunPlanBlock[] = version.blocks.map((b) => ({ side: b.side, symbol: b.symbol, qty: parseAmount(b.qty) }));

    const venue = await this.venue();
    if (!hasSubAccountReads(venue)) fail('quant.live_sub_account_unknown', `${venue.venue.displayName} offers no sub-accounts`, 422);
    const listed = (await venue.subAccounts({ venueId: venue.venue.id, owner, subAccount: null })).value;
    if (!listed.some((s) => s.subAccount.toLowerCase() === subAccount)) {
      fail('quant.live_sub_account_unknown', `the venue lists no sub-account ${subAccount} under ${owner}`, 422);
    }
    const now = this.deps.now();
    const stored = await this.deps.store.insertOnce({
      userId: principal.userId,
      runId,
      strategyId,
      strategyVersion,
      strategyName: version.name,
      venueId: venue.venue.id,
      owner,
      subAccount,
      agentAddress: agentAddressFor(seed, principal.userId, `quant-live:${runId}`),
      asset: v.asset,
      cap,
      plan,
      restartAttempts,
      statePolicy,
      liveControl,
      state: 'signing',
      endReason: null,
      permission: 'signing',
      restarts: 0,
      nextSeq: 1,
      strategyState: { ticks: 0 },
      heartbeatAt: null,
      createdAt: now,
      startedAt: null,
      stoppedAt: null,
      stopSeq: null,
    });
    await this.log(
      stored,
      'deployed',
      `Deployed version ${strategyVersion}: restart attempts ${restartAttempts}, strategy state ${statePolicy === 'keep' ? 'kept' : 'dropped'} on a restart, manual control ${liveControl ? 'granted' : 'not granted'}.`,
    );
    return this.advance(principal, stored);
  }

  /** A signing run is running once the venue lists its agent permission; until then the wallet is asked to sign it. */
  private async advance(principal: Principal, start: LiveRunRecord): Promise<LiveRunView> {
    let r = start;
    let next: LiveRunView['next'] = null;
    if (r.state === 'signing') {
      const venue = await this.venue();
      const onVenue = (await venue.agents(this.sub(r))).value.some((x) => x.address.toLowerCase() === r.agentAddress);
      if (onVenue) {
        const now = this.deps.now();
        const moved = await this.deps.store.move(r.userId, r.runId, ['signing'], {
          state: 'running',
          permission: 'active',
          startedAt: now,
          heartbeatAt: now,
        });
        r = moved.run;
        if (moved.moved) {
          await this.log(r, 'started', 'Agent permission signed by your wallet; the run is live.');
          this.workers.add(this.id(r));
        }
      } else {
        const answer = await this.deps.door.prepare(
          principal,
          {
            owner: r.owner,
            subAccount: r.subAccount,
            signer: { role: 'owner', address: r.owner },
            intent: { kind: 'approve_agent', agentAddress: r.agentAddress, agentName: `algo-${r.runId.slice(0, 8)}`, validUntil: null },
            actionKey: liveApproveKey(r.strategyId, r.runId),
          },
          { liveRun: true },
        );
        next = { actionKey: answer.actionKey, prepared: answer.prepared, signed: answer.signed };
      }
    }
    return this.view(r, next, await this.isTest());
  }

  private async isTest(): Promise<boolean> {
    return isTestVenue((await this.venue()).venue);
  }

  /** The wallet's signature of the run's agent permission, sent once under its key. */
  async submit(principal: Principal, runIdRaw: unknown, actionKey: unknown, signature: VenueSignature): Promise<LiveRunView> {
    const r = await this.run(principal.userId, runIdRaw);
    const key = typeof actionKey === 'string' ? actionKey.trim() : '';
    if (key !== liveApproveKey(r.strategyId, r.runId))
      fail('quant.live_request_invalid', `${JSON.stringify(key)} is not this run's agent permission`, 404);
    if (r.state !== 'signing')
      fail('quant.run_not_signing', `run ${r.runId} is ${r.state}; its agent permission is no longer asked for`, 409);
    await this.deps.door.submit(principal, key, signature, { liveRun: true });
    return this.advance(principal, (await this.deps.store.find(r.userId, r.runId))!);
  }

  async list(principal: Principal): Promise<readonly LiveRunView[]> {
    const test = await this.isTest();
    return (await this.deps.store.listForUser(principal.userId)).map((r) => this.view(r, null, test));
  }

  /** The run, its orders read back by key, the sub-account as the venue reports it now, and its log. Reads only, except a frozen person's permission. */
  async get(principal: Principal, runIdRaw: unknown): Promise<LiveRunDetail> {
    let r = await this.run(principal.userId, runIdRaw);
    if (r.state === 'signing')
      return {
        ...(await this.advance(principal, r)),
        orders: [],
        venue: null,
        venueError: null,
        log: await this.deps.store.events(r.userId, r.runId),
      };
    // A frozen person's stopped run keeps no permission either (J-wallet-13: every stored agent permission is revoked).
    if (r.permission === 'active' && !STOPPABLE.includes(r.state) && this.deps.freeze) {
      const frozen = await this.deps.freeze.frozen(r.userId).catch(() => false);
      if (frozen) r = await this.revokePermission(r);
    }
    const venue = await this.venue();
    const orders: LiveOrderView[] = [];
    for (const o of await this.deps.store.orders(r.userId, r.runId)) {
      let order: UserVenueOrder | null = null;
      const stored = await this.deps.door.stored(principal, o.actionKey);
      if (stored?.signature) {
        try {
          const read = await this.deps.door.orderByKey(principal, o.actionKey);
          order = read.order;
        } catch {
          order = null;
        }
      }
      orders.push({ ...o, order });
    }
    let snapshot: LiveRunDetail['venue'] = null;
    let venueError: string | null = null;
    try {
      const sub = this.sub(r);
      const since = r.startedAt ?? r.createdAt;
      const [balances, positions, open, fills] = await Promise.all([
        venue.balances(sub),
        venue.positions(sub),
        venue.openOrders(sub),
        venue.fills(sub, since),
      ]);
      snapshot = { asOf: positions.asOf, balances: balances.value, positions: positions.value, openOrders: open.value, fills: fills.value };
    } catch (error) {
      if (!(error instanceof VenueRefusalError)) throw error;
      venueError = `${venue.venue.displayName} could not be read just now: ${error.refusal.detail}`;
    }
    return {
      ...this.view(r, null, isTestVenue(venue.venue)),
      orders,
      venue: snapshot,
      venueError,
      log: await this.deps.store.events(r.userId, r.runId),
    };
  }

  // ── orders ──────────────────────────────────────────────────────────────────────────────────────────────────────

  private signerFor(r: LiveRunRecord, venue: UserVenue) {
    let s = this.signers.get(r.agentAddress);
    if (!s) {
      const key = agentKeyFor(this.seed(), r.userId, `quant-live:${r.runId}`);
      if (key.address.toLowerCase() !== r.agentAddress) throw new Error(`the key of run ${r.runId} does not derive to its address`);
      const marks = new Map<string, Amount | null>();
      const look: AgentCapMarks = (asset) => {
        const m = marks.get(asset);
        return m === undefined || m === null ? { known: false } : { known: true, value: m };
      };
      s = {
        signer: new CappedAgentSigner({
          sign: async (prepared: PreparedVenueAction): Promise<VenueSignature> => ({
            digest: prepared.digest,
            signature: await key.signTypedData(prepared.typedData as TypedDataDefinition),
            signedBy: key.address.toLowerCase(),
          }),
          venue,
          marks: look,
          priceMarks: look,
          bounds: this.deps.values.bounds,
          now: this.deps.now,
        }),
        marks,
      };
      this.signers.set(r.agentAddress, s);
    }
    return s;
  }

  private cap(r: LiveRunRecord): AgentCap {
    return {
      account: this.sub(r),
      agentAddress: r.agentAddress,
      asset: r.asset,
      cap: r.cap,
      validUntil: null,
      revokedAt: r.permission === 'revoked' ? (r.stoppedAt ?? this.deps.now()) : null,
    } as AgentCap;
  }

  private async mid(venue: UserVenue, symbol: string): Promise<Amount | null> {
    const book = (await venue.book(symbol, 1)).value;
    const bid = book.bids[0]?.price;
    const ask = book.asks[0]?.price;
    return bid !== undefined && ask !== undefined ? div(add(bid, ask), TWO, 'half-up') : null;
  }

  /** A market order's worst price: the book's mid moved by the owner's worst-price bound, on the market's tick. */
  private async worstPrice(venue: UserVenue, symbol: string, side: 'buy' | 'sell'): Promise<Amount> {
    const bps = this.deps.values.bounds.worstPriceBps;
    if (bps === null)
      fail('quant.order_rejected', 'the worst price an order may name is not set (owner value blank), so nothing is sent', 422);
    const market = (
      await venue.markets({ venueId: venue.venue.id, owner: '0x0000000000000000000000000000000000000000', subAccount: null })
    ).value.find((m) => m.symbol === symbol);
    if (!market) fail('quant.order_rejected', `${venue.venue.displayName} lists no market ${symbol}`, 422);
    const mid = await this.mid(venue, symbol);
    if (mid === null)
      fail('quant.order_rejected', `${symbol} has no two-sided book just now, so no worst price can be set; nothing was sent`, 422);
    return side === 'buy'
      ? toStep(div(mul(mid, add(TEN_THOUSAND, bps), 'floor'), TEN_THOUSAND, 'floor'), market.tickSize, 'down')
      : toStep(div(mul(mid, sub(TEN_THOUSAND, bps), 'ceil'), TEN_THOUSAND, 'ceil'), market.tickSize, 'up');
  }

  /**
   * Sends one order of the run, written first under its sequence number. The same key again reads the venue's record
   * first and re-sends only the stored bytes; a number taken by another order refuses. Answers the order as recorded.
   */
  private async place(
    principal: Principal,
    r: LiveRunRecord,
    o: Omit<LiveOrderRecord, 'userId' | 'runId' | 'state' | 'createdAt'>,
    states: readonly LiveRunState[],
  ): Promise<LiveOrderRecord> {
    const record: LiveOrderRecord = { ...o, userId: r.userId, runId: r.runId, state: 'admitted', createdAt: this.deps.now() };
    const admitted = await this.deps.store.admitOrder(record, states);
    if ('refused' in admitted) {
      if (admitted.refused === 'state')
        fail('quant.run_not_running', `run ${r.runId} is ${admitted.run.state}, so it places no order; nothing was sent`, 409);
      fail('quant.order_seq_invalid', `sequence ${o.seq} is not this run's next (${admitted.run.nextSeq}); nothing was sent`, 409, {
        nextSeq: admitted.run.nextSeq,
      });
    }
    let order: LiveOrderRecord;
    if ('existing' in admitted) {
      const e = admitted.existing;
      if (
        e.kind !== o.kind ||
        e.symbol !== o.symbol ||
        e.side !== o.side ||
        e.type !== o.type ||
        e.size !== o.size ||
        e.reduceOnly !== o.reduceOnly ||
        (o.type === 'limit' && e.price !== o.price)
      ) {
        fail('quant.order_reused', `sequence ${o.seq} was used for a different order; a new order takes the next number`, 409);
      }
      order = e;
      const stored = await this.deps.door.stored(principal, e.actionKey);
      if (stored?.signature) return this.readBackOrResend(principal, r, e, stored.signature);
      if (e.state === 'refused') fail('quant.order_rejected', `the order under sequence ${o.seq} was refused and is never sent again`, 409);
    } else order = admitted.admitted;

    const venue = await this.venue();
    const intent: PlaceUserOrderIntent = {
      kind: 'place_order',
      symbol: order.symbol,
      side: order.side,
      type: order.type,
      amount: order.size,
      price: order.price,
      timeInForce: order.type === 'market' || order.reduceOnly ? 'IOC' : 'GTC',
      reduceOnly: order.reduceOnly,
      clientOrderKey: order.actionKey,
      builderFee: null,
    };
    let prepared: PreparedVenueAction;
    try {
      prepared = (
        await this.deps.door.prepare(
          principal,
          { owner: r.owner, subAccount: r.subAccount, signer: { role: 'agent', address: r.agentAddress }, intent },
          { liveRun: true },
        )
      ).prepared;
    } catch (error) {
      await this.deps.store.setOrderState(r.userId, r.runId, order.seq, 'refused');
      throw this.named(error);
    }
    // The invariant: the order names the run's sub-account and its key, nothing else.
    if (
      prepared.account.owner.toLowerCase() !== r.owner ||
      prepared.account.subAccount !== r.subAccount ||
      prepared.signer.role !== 'agent' ||
      prepared.signer.address.toLowerCase() !== r.agentAddress
    ) {
      throw new Error(`order ${order.actionKey} was prepared outside its run's sub-account; nothing is signed`);
    }
    const s = this.signerFor(r, venue);
    const base = (await venue.markets(this.sub(r))).value.find((m) => m.symbol === order.symbol)?.baseAsset;
    if (base) s.marks.set(base, await this.mid(venue, order.symbol));
    let signature: VenueSignature;
    try {
      ({ signature } = await s.signer.sign(prepared, this.cap(r)));
    } catch (error) {
      await this.deps.store.setOrderState(r.userId, r.runId, order.seq, 'refused');
      if (error instanceof VenueRefusalError)
        fail(
          'quant.order_rejected',
          `the run's cap or the owner's bounds refuse this order: ${error.refusal.detail}; nothing was sent`,
          422,
          { capCode: error.refusal.code },
        );
      throw error;
    }
    return this.send(principal, r, order, signature);
  }

  private async send(principal: Principal, r: LiveRunRecord, order: LiveOrderRecord, signature: VenueSignature): Promise<LiveOrderRecord> {
    let outcome;
    try {
      outcome = (await this.deps.door.submit(principal, order.actionKey, signature, { liveRun: true })).outcome;
    } catch (error) {
      if (error instanceof VenueRefusalError && error.refusal.code === 'venue_down') {
        await this.deps.store.setOrderState(r.userId, r.runId, order.seq, 'unknown');
        return { ...order, state: 'unknown' };
      }
      throw this.named(error);
    }
    const cloid = (await this.deps.door.stored(principal, order.actionKey))?.prepared.venueClientOrderId ?? null;
    if (outcome.definite && cloid) this.signers.get(r.agentAddress)?.signer.settle(cloid);
    const state = outcome.definite ? (outcome.accepted ? 'accepted' : 'refused') : 'unknown';
    await this.deps.store.setOrderState(r.userId, r.runId, order.seq, state);
    if (outcome.definite && !outcome.accepted)
      fail('quant.order_rejected', `the venue refused the order: ${outcome.refusal.detail}`, 422, { venueCode: outcome.refusal.code });
    return { ...order, state };
  }

  private async readBackOrResend(
    principal: Principal,
    r: LiveRunRecord,
    o: LiveOrderRecord,
    signature: VenueSignature,
  ): Promise<LiveOrderRecord> {
    const read = await this.deps.door.orderByKey(principal, o.actionKey);
    if (read.state === 'accepted' || read.state === 'refused') {
      const state = read.state;
      await this.deps.store.setOrderState(r.userId, r.runId, o.seq, state);
      if (read.venueClientOrderId) this.signers.get(r.agentAddress)?.signer.settle(read.venueClientOrderId);
      if (state === 'refused') fail('quant.order_rejected', `the venue refused the order under sequence ${o.seq}`, 422);
      return { ...o, state };
    }
    return this.send(principal, r, o, signature);
  }

  private named(error: unknown): unknown {
    if (error instanceof VenueRefusalError && error.refusal.code !== 'venue_down') {
      return new LiveRunError('quant.order_rejected', `the venue refused the order: ${error.refusal.detail}`, 422, {
        venueCode: error.refusal.code,
      });
    }
    return error;
  }

  /**
   * #3: a manual order to a running strategy, under the run's next sequence number (`algo:order:<run>:<seq>`). Only with
   * the live-control grant the person kept on this run (else `quant.permission_denied`), only while the run is running.
   * The same number twice is one order.
   */
  async manualOrder(
    principal: Principal,
    runIdRaw: unknown,
    req: Record<string, unknown>,
  ): Promise<{ run: LiveRunView; order: LiveOrderRecord }> {
    const r0 = await this.run(principal.userId, runIdRaw);
    if (!r0.liveControl) {
      fail(
        'quant.permission_denied',
        'this run was deployed without the live-control grant, so it takes no manual order; nothing was sent',
        403,
      );
    }
    const seq = seqOf(req.seq);
    const side =
      req.side === 'buy' || req.side === 'sell'
        ? req.side
        : fail('quant.live_request_invalid', 'side is buy or sell', 400, { field: 'side' });
    const type =
      req.type === 'market' || req.type === 'limit'
        ? req.type
        : fail('quant.live_request_invalid', 'type is market or limit', 400, { field: 'type' });
    const symbol =
      typeof req.symbol === 'string' && req.symbol.trim()
        ? req.symbol.trim()
        : fail('quant.live_request_invalid', 'symbol is required', 400, { field: 'symbol' });
    const size = amountOf(req.size, 'size', 'quant.live_request_invalid');
    await this.assertNotFrozen(r0, 'a manual order');
    return this.locked(r0, async () => {
      const r = (await this.deps.store.find(r0.userId, r0.runId))!;
      const venue = await this.venue();
      const earlier = (await this.deps.store.orders(r.userId, r.runId)).find((o) => o.seq === seq);
      const price =
        type === 'limit'
          ? amountOf(req.price, 'price', 'quant.live_request_invalid')
          : (earlier?.price ?? (await this.worstPrice(venue, symbol, side)));
      const order = await this.place(
        principal,
        r,
        { seq, actionKey: liveOrderKey(r.runId, seq), kind: 'manual', block: null, symbol, side, type, size, price, reduceOnly: false },
        ['running'],
      );
      if (!earlier)
        await this.log(
          r,
          'manual_order',
          `Manual ${type} ${side} ${formatAmount(size)} ${symbol}${type === 'limit' ? ` at ${formatAmount(price)}` : ''} under sequence ${seq}: ${order.state}.`,
        );
      return { run: this.view((await this.deps.store.find(r.userId, r.runId))!, null, isTestVenue(venue.venue)), order };
    });
  }

  /** Cancels every open order of the run on its sub-account, each under `algo:stop:<run>:<press>:<order seq>`. Answers how many. */
  private async cancelOpen(principal: Principal, r: LiveRunRecord, press: string): Promise<number> {
    const venue = await this.venue();
    const open = (await venue.openOrders(this.sub(r))).value;
    const ours = new Map<string, LiveOrderRecord>();
    for (const o of await this.deps.store.orders(r.userId, r.runId)) {
      const cloid = (await this.deps.door.stored(principal, o.actionKey))?.prepared.venueClientOrderId;
      if (cloid) ours.set(cloid.toLowerCase(), o);
    }
    let cancelled = 0;
    for (const v of open) {
      const o = v.venueClientOrderId ? ours.get(v.venueClientOrderId.toLowerCase()) : undefined;
      if (!o) continue;
      const actionKey = `${press}:${o.seq}`;
      const prepared = (
        await this.deps.door.prepare(
          principal,
          {
            owner: r.owner,
            subAccount: r.subAccount,
            signer: { role: 'agent', address: r.agentAddress },
            intent: { kind: 'cancel_order', symbol: o.symbol, clientOrderKey: o.actionKey },
            actionKey,
          },
          { liveRun: true },
        )
      ).prepared;
      const stored = await this.deps.door.stored(principal, actionKey);
      const signature = stored?.signature ?? (await this.signerFor(r, venue).signer.sign(prepared, this.cap(r))).signature;
      const sent = await this.deps.door.submit(principal, actionKey, signature, { liveRun: true });
      if (!sent.outcome.definite)
        throw new VenueRefusalError({ venueId: venue.venue.id, code: 'venue_down', detail: 'the cancel was sent and its answer was lost' });
      cancelled += 1;
    }
    return cancelled;
  }

  /**
   * #1: Stop. No new order; every open order of the run is cancelled, the position is kept, and the run reads stopped.
   * The press carries its number (`algo:stop:<run>:<seq>`): the same Stop again, or any Stop of a run already stopped,
   * changes nothing. The orders are cancelled before the state is written, so a crash between replays this Stop.
   */
  async stop(principal: Principal, runIdRaw: unknown, req: Record<string, unknown>): Promise<LiveRunView> {
    const r0 = await this.run(principal.userId, runIdRaw);
    const seq = seqOf(req.seq);
    return this.locked(r0, async () => {
      const r = (await this.deps.store.find(r0.userId, r0.runId))!;
      if (!STOPPABLE.includes(r.state)) return this.view(r, null, await this.isTest());
      try {
        const n = await this.cancelOpen(principal, r, liveStopKey(r.runId, seq));
        this.workers.delete(this.id(r));
        const moved = await this.deps.store.move(r.userId, r.runId, STOPPABLE, {
          state: 'stopped',
          endReason: 'user_stop',
          stoppedAt: this.deps.now(),
          stopSeq: seq,
        });
        if (moved.moved)
          await this.log(moved.run, 'stopped', `Stopped by you: ${n} open order${n === 1 ? '' : 's'} cancelled; the position is kept.`);
        return this.view(moved.run, null, await this.isTest());
      } catch (error) {
        if (error instanceof VenueRefusalError)
          fail(
            'quant.stop_unavailable',
            `the venue could not be reached to cancel the open orders (${error.refusal.detail}); the run is as it was`,
            503,
          );
        throw error;
      }
    });
  }

  /**
   * #2: Liquidate. A Stop, then one reduce-only order per open position under `algo:liquidate:<run>:<seq>`, closing it;
   * the run ends flat once the venue shows no position. Refused while the account freeze is on (#5), with the freeze
   * reason, and the run stays as it is. The same press again reads the venue's record of that order and never sends a
   * second one.
   */
  async liquidate(
    principal: Principal,
    runIdRaw: unknown,
    req: Record<string, unknown>,
  ): Promise<{ run: LiveRunView; orders: readonly LiveOrderRecord[] }> {
    const r0 = await this.run(principal.userId, runIdRaw);
    const seq = seqOf(req.seq);
    await this.assertNotFrozen(r0, 'a liquidation');
    return this.locked(r0, async () => {
      let r = (await this.deps.store.find(r0.userId, r0.runId))!;
      if (r.state === 'flat')
        return {
          run: this.view(r, null, await this.isTest()),
          orders: (await this.deps.store.orders(r.userId, r.runId)).filter((o) => o.kind === 'liquidate'),
        };
      if (r.state === 'signing' || r.state === 'abandoned')
        fail('quant.run_not_running', `run ${r.runId} never ran, so there is nothing to liquidate`, 409);
      const venue = await this.venue();
      if (STOPPABLE.includes(r.state)) {
        try {
          const n = await this.cancelOpen(principal, r, liveStopKey(r.runId, seq));
          this.workers.delete(this.id(r));
          const moved = await this.deps.store.move(r.userId, r.runId, STOPPABLE, {
            state: 'stopped',
            endReason: 'user_stop',
            stoppedAt: this.deps.now(),
            stopSeq: seq,
          });
          r = moved.run;
          if (moved.moved) await this.log(r, 'stopped', `Stopped to liquidate: ${n} open order${n === 1 ? '' : 's'} cancelled.`);
        } catch (error) {
          if (error instanceof VenueRefusalError)
            fail('quant.stop_unavailable', `the venue could not be reached (${error.refusal.detail}); the run is as it was`, 503);
          throw error;
        }
      }
      const done = (await this.deps.store.orders(r.userId, r.runId)).filter((o) => o.kind === 'liquidate');
      const positions = (await venue.positions(this.sub(r))).value.filter((p) => compare(p.size, ZERO) > 0);
      if (positions.length === 0 && done.length === 0)
        fail('quant.nothing_to_liquidate', 'the venue shows no open position on this run’s sub-account; nothing was sent', 409);
      const sent: LiveOrderRecord[] = [...done];
      // One press closes each position once: an order already written under this press is read back, never sent again.
      let n = r.nextSeq;
      for (const p of positions) {
        const side = p.side === 'long' ? 'sell' : 'buy';
        const already = done.find((o) => o.symbol === p.symbol);
        if (already) {
          const stored = await this.deps.door.stored(principal, already.actionKey);
          if (stored?.signature) await this.readBackOrResend(principal, r, already, stored.signature);
          continue;
        }
        const price = await this.worstPrice(venue, p.symbol, side);
        const o = await this.place(
          principal,
          r,
          {
            seq: n,
            actionKey: liveLiquidateKey(r.runId, n),
            kind: 'liquidate',
            block: null,
            symbol: p.symbol,
            side,
            type: 'market',
            size: p.size,
            price,
            reduceOnly: true,
          },
          ['stopped', 'ended'],
        );
        sent.push(o);
        await this.log(
          r,
          'liquidate',
          `Liquidation: one reduce-only ${side} of ${formatAmount(p.size)} ${p.symbol} under sequence ${n}: ${o.state}.`,
        );
        n += 1;
        r = (await this.deps.store.find(r.userId, r.runId))!;
      }
      const left = (await venue.positions(this.sub(r))).value.filter((p) => compare(p.size, ZERO) > 0);
      if (left.length === 0) {
        const moved = await this.deps.store.move(r.userId, r.runId, ['stopped', 'ended'], { state: 'flat', endReason: 'liquidated' });
        r = moved.run;
        if (moved.moved) await this.log(r, 'flat', 'The venue shows no position: the run is flat.');
      }
      return { run: this.view(r, null, isTestVenue(venue.venue)), orders: sent };
    });
  }

  private async revokePermission(r: LiveRunRecord): Promise<LiveRunRecord> {
    const moved = await this.deps.store.move(r.userId, r.runId, [r.state], { permission: 'revoked' });
    this.signers.delete(r.agentAddress);
    if (moved.moved && r.permission !== 'revoked') {
      await this.log(
        moved.run,
        'permission_revoked',
        'The account freeze revoked this run’s agent permission: INTAFACED’s key for it signs nothing more. Your wallet must sign a new permission after you unfreeze.',
      );
    }
    return moved.run;
  }

  // ── the supervisor and the process (#4, #5, #6) ───────────────────────────────────────────────────────────────

  /** TEST stacks only: the process running the run dies (it stops at once and writes no more heartbeat). */
  async killProcess(principal: Principal, runIdRaw: unknown): Promise<LiveRunView> {
    const r = await this.run(principal.userId, runIdRaw);
    if (!(await this.isTest())) fail('quant.live_test_only', 'a process is ended on purpose only on a TEST venue', 404);
    this.workers.delete(this.id(r));
    return this.view(r, null, true);
  }

  /** One supervisor pass: the freeze, each live process's step, and each dead process's recovery. One at a time. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const frozen = new Map<string, boolean | null>();
      for (const r of await this.deps.store.listActive()) {
        try {
          await this.locked(r, async () => {
            const run = await this.deps.store.find(r.userId, r.runId);
            if (!run || !STOPPABLE.includes(run.state)) return;
            if (!frozen.has(run.userId))
              frozen.set(run.userId, this.deps.freeze ? await this.deps.freeze.frozen(run.userId).catch(() => null) : null);
            const isFrozen = frozen.get(run.userId);
            if (isFrozen === true) return this.freezeStop(run);
            // The freeze can't be read (identity down, refused, or not wired): this pass places nothing and restarts
            // nothing for the run, and says so once per outage. A live process keeps its heartbeat, so the outage alone
            // never spends a restart attempt.
            if (isFrozen !== false) return this.freezeUnread(run);
            this.unreadFreeze.delete(this.id(run));
            if (this.workers.has(this.id(run)) && run.state === 'running') return this.step(run);
            return this.recover(run);
          });
        } catch (error) {
          process.stderr.write(
            `${JSON.stringify({ level: 'warn', msg: 'trade.quant_live.tick_failed', runId: r.runId, message: error instanceof Error ? error.message : String(error) })}\n`,
          );
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  /** Run ids whose freeze read failed on the last pass, so the outage is logged once, not on every pass. */
  private readonly unreadFreeze = new Set<string>();

  private async freezeUnread(r: LiveRunRecord): Promise<void> {
    if (this.workers.has(this.id(r)) && r.state === 'running')
      await this.deps.store.beat(r.userId, r.runId, this.deps.now(), r.strategyState);
    if (this.unreadFreeze.has(this.id(r))) return;
    this.unreadFreeze.add(this.id(r));
    await this.log(
      r,
      'freeze_unread',
      'The account freeze could not be read, so the run places no order and restarts nothing until it can.',
    );
  }

  private async freezeStop(r: LiveRunRecord): Promise<void> {
    const principal = ownerPrincipal(r.userId);
    let n = 0;
    try {
      n = await this.cancelOpen(principal, r, `algo:stop:${r.runId}:freeze`);
    } catch {
      // The venue could not be reached: the run is still stopped and its key dropped below; an order left open stays the person's.
    }
    this.workers.delete(this.id(r));
    const moved = await this.deps.store.move(r.userId, r.runId, STOPPABLE, {
      state: 'stopped',
      endReason: 'account_frozen',
      stoppedAt: this.deps.now(),
    });
    if (moved.moved)
      await this.log(
        moved.run,
        'stopped',
        `Stopped by the account freeze: ${n} open order${n === 1 ? '' : 's'} cancelled; the position is kept.`,
      );
    await this.revokePermission(moved.run);
  }

  /** The live process's step: its heartbeat, and the next order block of the plan not yet placed. */
  private async step(r: LiveRunRecord): Promise<void> {
    const ticks = r.strategyState.ticks + 1;
    if (!(await this.deps.store.beat(r.userId, r.runId, this.deps.now(), { ticks }))) return;
    const orders = await this.deps.store.orders(r.userId, r.runId);
    const next = r.plan.findIndex((_, i) => !orders.some((o) => o.block === i));
    if (next < 0) return;
    const b = r.plan[next]!;
    const venue = await this.venue();
    const price = await this.worstPrice(venue, b.symbol, b.side);
    const principal = ownerPrincipal(r.userId);
    try {
      const o = await this.place(
        principal,
        r,
        {
          seq: r.nextSeq,
          actionKey: liveOrderKey(r.runId, r.nextSeq),
          kind: 'strategy',
          block: next,
          symbol: b.symbol,
          side: b.side,
          type: 'market',
          size: b.qty,
          price,
          reduceOnly: false,
        },
        ['running'],
      );
      await this.log(
        r,
        'strategy_order',
        `Strategy block ${next + 1}: market ${b.side} ${formatAmount(b.qty)} ${b.symbol} under sequence ${o.seq}: ${o.state}.`,
      );
    } catch (error) {
      if (error instanceof LiveRunError) await this.log(r, 'strategy_order', `Strategy block ${next + 1} was not placed: ${error.code}.`);
      else throw error;
    }
  }

  /**
   * A run no process here is running: once its heartbeat is older than the owner's interval it reads unknown; on the next
   * pass the reconciler reads its orders from the venue and it is restarted, or ended once its attempts are spent.
   */
  private async recover(r: LiveRunRecord): Promise<void> {
    const interval = this.deps.values.heartbeatMs;
    if (interval === null) return;
    const now = this.deps.now();
    const last = r.heartbeatAt ?? r.startedAt ?? r.createdAt;
    if (r.state === 'running' && now.getTime() - last.getTime() < interval) return;
    let run = r;
    if (run.state === 'running') {
      run = (await this.deps.store.move(r.userId, r.runId, ['running'], { state: 'unknown' })).run;
      await this.log(
        run,
        'unknown',
        `No heartbeat for ${Math.round((now.getTime() - last.getTime()) / 1000)} s: the run reads unknown until the venue is read.`,
      );
      // The next pass reconciles it: the run reads unknown, as it is, until then.
      return;
    }
    const principal = ownerPrincipal(run.userId);
    // The reconciler: every order the run sent is read back from the venue by its original client order id, the
    // venue's answer standing over what was recorded before the process died.
    let read = 0;
    for (const o of await this.deps.store.orders(run.userId, run.runId)) {
      if (o.state === 'refused') continue;
      const stored = await this.deps.door.stored(principal, o.actionKey);
      if (!stored?.signature) {
        // Written and never signed: never sent, and its number is never used again.
        await this.deps.store.setOrderState(run.userId, run.runId, o.seq, 'refused');
        continue;
      }
      const v = await this.deps.door.orderByKey(principal, o.actionKey);
      if ((v.state === 'accepted' || v.state === 'refused') && v.state !== o.state)
        await this.deps.store.setOrderState(run.userId, run.runId, o.seq, v.state);
      read += 1;
    }
    const ordersNow = await this.deps.store.orders(run.userId, run.runId);
    await this.log(
      run,
      'reconciled',
      `Reconciler read ${read} order${read === 1 ? '' : 's'} from the venue by their client order ids; ${ordersNow.length} on record.`,
    );
    if (run.restarts >= run.restartAttempts) {
      const moved = await this.deps.store.move(run.userId, run.runId, ['unknown'], {
        state: 'ended',
        endReason: 'attempts_exhausted',
        stoppedAt: now,
      });
      if (moved.moved)
        await this.log(
          moved.run,
          'ended',
          `Restart attempts exhausted (${run.restarts} of ${run.restartAttempts}): the run ended and places no new order.`,
        );
      return;
    }
    const venue = await this.venue();
    const sub = this.sub(run);
    const [open, positions] = await Promise.all([venue.openOrders(sub), venue.positions(sub)]);
    const strategyState = run.statePolicy === 'keep' ? run.strategyState : { ticks: 0 };
    const restarts = run.restarts + 1;
    const moved = await this.deps.store.move(run.userId, run.runId, ['unknown'], {
      state: 'running',
      restarts,
      strategyState,
      heartbeatAt: now,
    });
    if (!moved.moved) return;
    this.workers.add(this.id(run));
    await this.log(
      moved.run,
      'restarted',
      `Restarted (${restarts} of ${run.restartAttempts}): reloaded ${open.value.length} open order${open.value.length === 1 ? '' : 's'} and ${positions.value.length} position${positions.value.length === 1 ? '' : 's'} from the venue; strategy state ${run.statePolicy === 'keep' ? `kept (${strategyState.ticks} ticks)` : 'dropped'}.`,
    );
  }

  /** Starts the supervisor: every half heartbeat interval. Answers the stop. */
  supervise(): () => void {
    const interval = this.deps.values.heartbeatMs;
    if (!this.deps.values.enabled || interval === null) return () => undefined;
    const timer = setInterval(() => void this.tick(), Math.max(100, Math.floor(interval / 2)));
    timer.unref();
    return () => clearInterval(timer);
  }

  private view(r: LiveRunRecord, next: LiveRunView['next'], test: boolean): LiveRunView {
    return {
      runId: r.runId,
      strategyId: r.strategyId,
      strategyVersion: r.strategyVersion,
      strategyName: r.strategyName,
      owner: r.owner,
      subAccount: r.subAccount,
      agentAddress: r.agentAddress,
      asset: r.asset,
      cap: r.cap,
      plan: planOnWire(r.plan),
      state: r.state,
      endReason: r.endReason,
      permission: r.permission,
      liveControl: r.liveControl,
      nextSeq: r.nextSeq,
      stopSeq: r.stopSeq,
      health: {
        restarts: r.restarts,
        restartAttempts: r.restartAttempts,
        statePolicy: r.statePolicy,
        strategyTicks: r.strategyState.ticks,
        heartbeatAt: r.heartbeatAt,
        heartbeatMs: this.deps.values.heartbeatMs,
      },
      createdAt: r.createdAt,
      startedAt: r.startedAt,
      stoppedAt: r.stoppedAt,
      next,
      test,
    };
  }
}
