import http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Principal } from '@intafaced/auth';
import type { StepUpCheck } from '@intafaced/contracts';
import { compare, parseAmount, ZERO } from '@intafaced/ledger-client/money';
import {
  VenueRefusalError,
  type PreparedVenueAction,
  type UserVenue,
  type UserVenueAccount,
  type VenueIntent,
} from '@intafaced/venue-contracts';
import { seedTestVenue, startTestVenueServer, type TestVenueSimulator, type TestVenueTypedData } from '@intafaced/venue-sim';
import { parseAgentAccountValues } from '../../venue/agent-account.js';
import { HttpUserVenue } from '../../venue/http-user-venue.js';
import { InMemoryPreparedActionStore } from '../../venue/prepared-action-store.js';
import { UserVenueDoor, UserVenueDoorError } from '../../venue/user-venue-door.js';
import { listedTestStore } from '../../venue/venue-listing-store.js';
import { StoreVenueRoutingGate } from '../../venue/venue-listing.js';
import { LiveRunError, LiveRuns, parseLiveRunValues, type LiveRunView } from './live-runs.js';
import { MemoryFreezeRead, type StrategySource } from './ports.js';
import { InMemoryLiveRunStore, liveLiquidateKey, liveOrderKey } from './store.js';

// J-algo-dev-07 at the service, against the TEST venue simulator over loopback HTTP. Every figure is TEST. The person's
// wallet is a fixed TEST key; svc-quant's answer (the strategy version's order blocks) is a fixed TEST answer here.

const a = parseAmount;
const USER = '11111111-1111-4111-8111-1111111111a7';
const person = {
  sub: USER,
  userId: USER,
  sid: '33333333-3333-4333-8333-3333333333a7',
  scopes: ['trade:read', 'trade:write'],
  tier: 'basic',
  mfa: false,
  expiresAt: new Date(Date.now() + 600_000),
} as Principal;

const key = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet svc-trade live runs')));
const owner = key.address.toLowerCase();
async function sign(prepared: PreparedVenueAction) {
  const t = prepared.typedData as TestVenueTypedData;
  const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  return { digest: prepared.digest, signature, signedBy: owner };
}

const AGENT = parseAgentAccountValues({
  TRADE_AGENT_ACCOUNT_CEILING: '5000',
  TRADE_AGENT_ACCOUNT_ASSET: 'USDC',
  TRADE_AGENT_KEY_SEED: 'intafaced unit TEST live run seed',
  TRADE_AGENT_MAX_ORDER_NOTIONAL: '5000',
  TRADE_AGENT_WORST_PRICE_BPS: '200',
  TRADE_AGENT_MARKETS: 'BTC-PERP',
});
const ON = { TRADE_QUANT_LIVE: 'on', TRADE_QUANT_LIVE_HEARTBEAT_MS: '1000', APP_ENV: 'test' };

const noStepUp: StepUpCheck = {
  async require() {
    return { stepUpEventId: 'unused', consumedAt: null, replayed: false };
  },
};

const strategies: StrategySource = {
  async version(_forwarded, id, version) {
    if (id === 'signal') return { name: 'TEST signal', version, blocks: [], signalRules: true };
    if (id !== 'trend' || version !== 1) return null;
    return { name: 'TEST trend', version: 1, blocks: [{ side: 'buy', symbol: 'BTC-PERP', qty: '0.01' }], signalRules: false };
  },
};

let n = 0;
const uuid = (tail: string) => {
  n += 1;
  return `${tail.padEnd(8, '0').slice(0, 8)}-0000-4000-8000-${String(n).padStart(12, '0')}`;
};

async function refused(promise: Promise<unknown>): Promise<LiveRunError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(LiveRunError);
    return error as LiveRunError;
  }
  throw new Error('expected a refusal');
}

describe('a live strategy run: stop, liquidate, manual orders, recovery and the freeze (J-algo-dev-07, TEST venue)', () => {
  let server: http.Server;
  let sim: TestVenueSimulator;
  let url: string;
  const main = (): UserVenueAccount => ({ venueId: sim.venue.id, owner, subAccount: null });
  let clock = Date.now();
  const now = () => new Date(clock);

  beforeAll(async () => {
    ({ server, sim, url } = await startTestVenueServer({ host: '127.0.0.1', port: 0, appEnv: 'test', chainId: 84532 }));
    await seedTestVenue(sim);
  });
  afterAll(
    async () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );

  let door: UserVenueDoor;
  let store: InMemoryLiveRunStore;
  let freeze: MemoryFreezeRead;
  /** The person's tier as the TEST identity answers it now; null: identity can't be asked. */
  let tier: Principal['tier'] | null;
  let runs: LiveRuns;
  let sub: UserVenueAccount;
  let venueDown = false;

  async function own(account: UserVenueAccount, intent: VenueIntent) {
    const prepared = await sim.prepare(account, { role: 'owner', address: owner }, intent);
    const outcome = await sim.submit(prepared, await sign(prepared));
    expect(outcome.definite && outcome.accepted, JSON.stringify(outcome)).toBe(true);
    return outcome;
  }

  function build(env: Record<string, string> = ON) {
    door = new UserVenueDoor({
      connect: async () => {
        const venue = await HttpUserVenue.connect({ baseUrl: url, timeoutMs: 2000 });
        return new Proxy(venue, {
          get(target, prop, receiver) {
            if (prop === 'submit' || prop === 'openOrders') {
              return async (...args: unknown[]) => {
                if (venueDown) throw new VenueRefusalError({ venueId: target.venue.id, code: 'venue_down', detail: 'TEST: venue down' });
                return (target[prop] as (...x: unknown[]) => unknown)(...args);
              };
            }
            const v = Reflect.get(target, prop, receiver);
            return typeof v === 'function' ? v.bind(target) : v;
          },
        }) as UserVenue;
      },
      appEnv: 'test',
      store: new InMemoryPreparedActionStore(),
      stepUp: noStepUp,
      builder: { address: '0x00000000000000000000000000000000000000b1', feeBps: a('1') },
      listings: new StoreVenueRoutingGate(listedTestStore(['BTC-PERP'])),
      now,
    });
    store = new InMemoryLiveRunStore();
    freeze = new MemoryFreezeRead();
    tier = 'basic';
    runs = new LiveRuns({
      door,
      store,
      values: parseLiveRunValues(env, AGENT),
      strategies,
      freeze,
      liveTier: async () => {
        if (tier === null) throw new Error('TEST: identity down');
        return tier;
      },
      now,
    });
  }

  let k = 0;
  beforeEach(async () => {
    k += 1;
    venueDown = false;
    clock = Date.now();
    sim.deposit(main(), 'USDC', a('2000'), `deposit:test:live-run:${k}`);
    const made = await own(main(), { kind: 'create_sub_account', name: `live-${k}`, subAccountKey: `own:live:${k}` });
    sub = { ...main(), subAccount: (made as { venueRef: string }).venueRef };
    await own(main(), {
      kind: 'sub_account_transfer',
      subAccount: sub.subAccount!,
      direction: 'into_sub_account',
      asset: 'USDC',
      amount: a('1000'),
      moveKey: `own:live:${k}:fund`,
    });
    await own(sub, { kind: 'approve_builder_fee', builder: '0x00000000000000000000000000000000000000b1', maxFeeBps: a('1') });
    await own(sub, { kind: 'update_leverage', symbol: 'BTC-PERP', leverageBps: 10_000, marginMode: 'isolated' });
    build();
  });

  const terms = (over: Record<string, unknown> = {}) => ({
    runId: uuid('a7'),
    strategyId: 'trend',
    strategyVersion: 1,
    owner,
    subAccount: sub.subAccount,
    cap: '2000',
    restartAttempts: '1',
    statePolicy: 'keep',
    liveControl: true,
    ...over,
  });

  /** A run whose agent permission the wallet signed, after its first step placed the plan's block (a long position). */
  async function live(over: Record<string, unknown> = {}): Promise<LiveRunView> {
    let v = await runs.start(person, {}, terms(over), 'DE');
    expect(v.state).toBe('signing');
    v = await runs.submit(person, v.runId, v.next!.actionKey, await sign(v.next!.prepared));
    expect(v.state).toBe('running');
    await runs.tick();
    return v;
  }
  const positions = async () => (await sim.positions(sub)).value.filter((p) => compare(p.size, ZERO) > 0);
  const openOrders = async () => (await sim.openOrders(sub)).value;

  it('refuses a start with live off, the heartbeat interval blank, the restart attempts blank or a signal strategy, storing nothing', async () => {
    build({});
    expect((await refused(runs.start(person, {}, terms(), 'DE'))).code).toBe('quant.live_disabled');
    build({ TRADE_QUANT_LIVE: 'on' });
    expect((await refused(runs.start(person, {}, terms(), 'DE'))).code).toBe('quant.heartbeat_interval_unset');
    build();
    const blank = await refused(runs.start(person, {}, terms({ restartAttempts: '' }), 'DE'));
    expect(blank.code).toBe('quant.restart_attempts_unset');
    expect(blank.detail).toEqual({ field: 'restartAttempts' });
    expect((await refused(runs.start(person, {}, terms({ strategyId: 'signal' }), 'DE'))).code).toBe('quant.live_plan_unsupported');
    expect((await refused(runs.start(person, {}, terms({ strategyId: 'missing' }), 'DE'))).code).toBe('quant.studio_not_found');
    expect(await store.listForUser(USER)).toEqual([]);
  });

  it('starts: the wallet signs the agent permission on the sub-account only; the first step places the block as a venue order', async () => {
    const v = await live();
    expect((await sim.agents(sub)).value.map((x) => x.address.toLowerCase())).toContain(v.agentAddress);
    expect((await sim.agents(main())).value.map((x) => x.address.toLowerCase())).not.toContain(v.agentAddress);
    const [p] = await positions();
    expect(p).toMatchObject({ symbol: 'BTC-PERP', side: 'long' });
    expect(p!.size).toBe(a('0.01'));
    const orders = await store.orders(USER, v.runId);
    expect(orders).toMatchObject([{ seq: 1, actionKey: liveOrderKey(v.runId, 1), kind: 'strategy', block: 0, state: 'accepted' }]);
    // A second step places nothing more: the block is placed once.
    await runs.tick();
    expect(await store.orders(USER, v.runId)).toHaveLength(1);
  });

  it('#3: a manual order twice with the same sequence is one order; a run without the live-control grant refuses it typed', async () => {
    const v = await live();
    const order = { seq: 2, side: 'buy', type: 'limit', symbol: 'BTC-PERP', size: '0.005', price: '50000' };
    const first = await runs.manualOrder(person, v.runId, order);
    const again = await runs.manualOrder(person, v.runId, order);
    expect(first.order.actionKey).toBe(liveOrderKey(v.runId, 2));
    expect(again.order.actionKey).toBe(first.order.actionKey);
    expect(await openOrders()).toHaveLength(1);
    // A number already taken by another order is refused; one past the next is refused.
    expect((await refused(runs.manualOrder(person, v.runId, { ...order, price: '49000' }))).code).toBe('quant.order_reused');
    expect((await refused(runs.manualOrder(person, v.runId, { ...order, seq: 5 }))).code).toBe('quant.order_seq_invalid');

    const other = await live({ liveControl: false, subAccount: sub.subAccount });
    const denied = await refused(runs.manualOrder(person, other.runId, { ...order, seq: 2 }));
    expect(denied.code).toBe('quant.permission_denied');
    expect(denied.status).toBe(403);
  });

  it('#1: Stop cancels the open order, keeps the position and reads stopped; the same Stop again changes nothing', async () => {
    const v = await live();
    await runs.manualOrder(person, v.runId, { seq: 2, side: 'buy', type: 'limit', symbol: 'BTC-PERP', size: '0.005', price: '50000' });
    expect(await openOrders()).toHaveLength(1);
    const stopped = await runs.stop(person, v.runId, { seq: 1 });
    expect(stopped).toMatchObject({ state: 'stopped', endReason: 'user_stop', stopSeq: 1 });
    expect(await openOrders()).toHaveLength(0);
    expect((await positions())[0]!.size).toBe(a('0.01'));
    const fillsBefore = (await sim.fills(sub, new Date(0))).value.length;
    const again = await runs.stop(person, v.runId, { seq: 1 });
    expect(again).toMatchObject({ state: 'stopped', stopSeq: 1, nextSeq: stopped.nextSeq });
    expect((await sim.fills(sub, new Date(0))).value).toHaveLength(fillsBefore);
    // A stopped run places nothing more, strategy or manual.
    await runs.tick();
    expect(
      (await refused(runs.manualOrder(person, v.runId, { seq: 3, side: 'buy', type: 'market', symbol: 'BTC-PERP', size: '0.01' }))).code,
    ).toBe('quant.run_not_running');
    expect(await store.orders(USER, v.runId)).toHaveLength(2);
  });

  it('#1: a Stop while the venue cannot be reached refuses quant.stop_unavailable and the run stays running', async () => {
    const v = await live();
    venueDown = true;
    expect((await refused(runs.stop(person, v.runId, { seq: 1 }))).code).toBe('quant.stop_unavailable');
    venueDown = false;
    expect((await store.find(USER, v.runId))!.state).toBe('running');
  });

  it('#2: Liquidate sends one reduce-only order that closes the position once, and the run ends flat', async () => {
    const v = await live();
    const out = await runs.liquidate(person, v.runId, { seq: 1 });
    expect(out.run).toMatchObject({ state: 'flat', endReason: 'liquidated' });
    expect(out.orders).toMatchObject([
      { kind: 'liquidate', actionKey: liveLiquidateKey(v.runId, 2), reduceOnly: true, side: 'sell', state: 'accepted' },
    ]);
    expect(await positions()).toEqual([]);
    const fills = (await sim.fills(sub, new Date(0))).value;
    const again = await runs.liquidate(person, v.runId, { seq: 1 });
    expect(again.run.state).toBe('flat');
    expect((await sim.fills(sub, new Date(0))).value).toHaveLength(fills.length);
    expect((await store.orders(USER, v.runId)).filter((o) => o.kind === 'liquidate')).toHaveLength(1);
  });

  it('#4: a dead process reads unknown, is reconciled by client order id and restarted with its state kept; spent attempts end it typed', async () => {
    const v = await live({ restartAttempts: '1', statePolicy: 'keep' });
    await runs.tick();
    const ticks = (await store.find(USER, v.runId))!.strategyState.ticks;
    expect(ticks).toBeGreaterThan(0);
    await runs.killProcess(person, v.runId);
    // Inside the interval nothing happens yet.
    await runs.tick();
    expect((await store.find(USER, v.runId))!.state).toBe('running');
    clock += 1_500;
    await runs.tick();
    expect((await store.find(USER, v.runId))!.state).toBe('unknown');
    await runs.tick();
    let r = (await store.find(USER, v.runId))!;
    expect(r).toMatchObject({ state: 'running', restarts: 1 });
    expect(r.strategyState.ticks).toBe(ticks);
    const log = (await store.events(USER, v.runId)).map((e) => e.kind);
    expect(log).toEqual(expect.arrayContaining(['unknown', 'reconciled', 'restarted']));
    // The block's order, already accepted before the process died, is read back from the venue by its client order id too.
    expect((await store.events(USER, v.runId)).find((e) => e.kind === 'reconciled')!.detail).toBe(
      'Reconciler read 1 order from the venue by their client order ids; 1 on record.',
    );
    // The restarted process places no second order for the block it placed before.
    await runs.tick();
    expect(await store.orders(USER, v.runId)).toHaveLength(1);

    await runs.killProcess(person, v.runId);
    clock += 1_500;
    await runs.tick();
    await runs.tick();
    r = (await store.find(USER, v.runId))!;
    expect(r).toMatchObject({ state: 'ended', endReason: 'attempts_exhausted', restarts: 1 });
    await runs.tick();
    expect(await store.orders(USER, v.runId)).toHaveLength(1);
  });

  it('#4: a restart with the state policy drop starts the strategy state again', async () => {
    const v = await live({ restartAttempts: '2', statePolicy: 'drop' });
    await runs.tick();
    await runs.killProcess(person, v.runId);
    clock += 1_500;
    await runs.tick();
    await runs.tick();
    expect((await store.find(USER, v.runId))!).toMatchObject({ state: 'running', restarts: 1, strategyState: { ticks: 0 } });
  });

  it('#5: the freeze stops the run and revokes its permission; a liquidate is refused with the freeze reason and the row stays', async () => {
    const v = await live();
    await runs.manualOrder(person, v.runId, { seq: 2, side: 'buy', type: 'limit', symbol: 'BTC-PERP', size: '0.005', price: '50000' });
    freeze.frozenUsers.add(USER);
    await runs.tick();
    const r = (await store.find(USER, v.runId))!;
    expect(r).toMatchObject({ state: 'stopped', endReason: 'account_frozen', permission: 'revoked' });
    expect(await openOrders()).toHaveLength(0);
    expect((await positions())[0]!.size).toBe(a('0.01'));
    const e = await refused(runs.liquidate(person, v.runId, { seq: 1 }));
    expect(e.code).toBe('quant.account_frozen');
    expect(await store.find(USER, v.runId)).toEqual(r);
    expect((await positions())[0]!.size).toBe(a('0.01'));
  });

  it('a freeze that cannot be read places nothing and restarts nothing, logged once; once read again the run trades', async () => {
    let v = await runs.start(person, {}, terms(), 'DE');
    v = await runs.submit(person, v.runId, v.next!.actionKey, await sign(v.next!.prepared));
    expect(v.state).toBe('running');
    freeze.down = true;
    await runs.tick();
    clock += 1_500;
    await runs.tick();
    expect(await store.orders(USER, v.runId)).toEqual([]);
    expect(await positions()).toEqual([]);
    expect((await store.events(USER, v.runId)).filter((e) => e.kind === 'freeze_unread')).toHaveLength(1);
    // A dead process is not restarted while the freeze can't be read either.
    await runs.killProcess(person, v.runId);
    clock += 1_500;
    await runs.tick();
    await runs.tick();
    expect((await store.find(USER, v.runId))!).toMatchObject({ state: 'running', restarts: 0 });
    expect(await store.orders(USER, v.runId)).toEqual([]);
    freeze.down = false;
    await runs.tick();
    expect((await store.find(USER, v.runId))!.state).toBe('unknown');
  });

  it('a start below the trading level or from a region trading is refused in is refused by name and stores nothing', async () => {
    const low = { ...person, tier: 'none' } as Principal;
    expect((await refused(runs.start(low, {}, terms(), 'DE'))).code).toBe('quant.not_eligible');
    expect((await refused(runs.start(person, {}, terms(), 'KP'))).code).toBe('quant.not_eligible');
    expect(await store.listForUser(USER)).toEqual([]);
  });

  it('each pass trades on the tier identity holds now: a tier withdrawn or unreadable places nothing, logged once', async () => {
    let v = await runs.start(person, {}, terms(), 'DE');
    v = await runs.submit(person, v.runId, v.next!.actionKey, await sign(v.next!.prepared));
    tier = 'none';
    await runs.tick();
    await runs.tick();
    expect(await store.orders(USER, v.runId)).toEqual([]);
    expect((await store.events(USER, v.runId)).filter((e) => e.kind === 'not_eligible')).toHaveLength(1);
    tier = null;
    await runs.tick();
    expect(await store.orders(USER, v.runId)).toEqual([]);
    expect((await store.events(USER, v.runId)).filter((e) => e.kind === 'tier_unread')).toHaveLength(1);
    expect((await store.find(USER, v.runId))!).toMatchObject({ state: 'running', restarts: 0 });
    tier = 'basic';
    await runs.tick();
    expect(await store.orders(USER, v.runId)).toHaveLength(1);
    expect(await positions()).toHaveLength(1);
  });

  it("a freeze while the venue is down keeps trying to cancel the run's open orders, placing nothing, until they come down", async () => {
    const v = await live();
    await runs.manualOrder(person, v.runId, { seq: 2, side: 'buy', type: 'limit', symbol: 'BTC-PERP', size: '0.005', price: '50000' });
    freeze.frozenUsers.add(USER);
    venueDown = true;
    await runs.tick();
    await runs.tick();
    venueDown = false;
    expect(await openOrders()).toHaveLength(1);
    expect((await store.find(USER, v.runId))!).toMatchObject({ state: 'running', endReason: null, permission: 'active' });
    expect((await store.events(USER, v.runId)).filter((e) => e.kind === 'freeze_cancel_pending')).toHaveLength(1);
    expect(await store.orders(USER, v.runId)).toHaveLength(2);
    await runs.tick();
    expect(await openOrders()).toHaveLength(0);
    expect((await store.find(USER, v.runId))!).toMatchObject({ state: 'stopped', endReason: 'account_frozen', permission: 'revoked' });
  });

  it('a frozen account starts no run, and the process-kill control is not there outside a dev or test deployment', async () => {
    // A deployment that is not dev or test (no APP_ENV): everything else is as on the TEST stack.
    build({ TRADE_QUANT_LIVE: 'on', TRADE_QUANT_LIVE_HEARTBEAT_MS: '1000' });
    freeze.frozenUsers.add(USER);
    expect((await refused(runs.start(person, {}, terms(), 'DE'))).code).toBe('quant.account_frozen');
    expect(await store.listForUser(USER)).toEqual([]);
    freeze.frozenUsers.delete(USER);
    const v = await live();
    expect((await refused(runs.killProcess(person, v.runId))).code).toBe('quant.live_test_only');
  });

  it('a stopped run keeps its recorded permission while the freeze cannot be read, never read as not frozen', async () => {
    const v = await live();
    await runs.stop(person, v.runId, { seq: 1 });
    freeze.frozenUsers.add(USER);
    freeze.down = true;
    expect((await runs.get(person, v.runId)).permission).toBe('active');
    freeze.down = false;
    expect((await runs.get(person, v.runId)).permission).toBe('revoked');
  });

  it("another person's run answers as a missing one; the plain door refuses a run's keys", async () => {
    const v = await live();
    const stranger = {
      ...person,
      userId: '99999999-9999-4999-8999-999999999999',
      sub: '99999999-9999-4999-8999-999999999999',
    } as Principal;
    expect((await refused(runs.get(stranger, v.runId))).code).toBe('quant.run_not_found');
    expect((await refused(runs.stop(stranger, v.runId, { seq: 1 }))).code).toBe('quant.run_not_found');
    await expect(
      door.prepare(person, {
        owner,
        subAccount: sub.subAccount,
        signer: { role: 'owner', address: owner },
        intent: {
          kind: 'place_order',
          symbol: 'BTC-PERP',
          side: 'buy',
          type: 'limit',
          amount: a('0.01'),
          price: a('50000'),
          timeInForce: 'GTC',
          reduceOnly: false,
          clientOrderKey: liveOrderKey(v.runId, 9),
          builderFee: null,
        },
      }),
    ).rejects.toBeInstanceOf(UserVenueDoorError);
  });

  it('the run detail reads cash, positions and fills from the venue with an as-of time, matching its fills exactly', async () => {
    const v = await live();
    const d = await runs.get(person, v.runId);
    expect(d.venue).not.toBeNull();
    expect(d.venue!.asOf).toBeInstanceOf(Date);
    const bought = d.venue!.fills.filter((f) => f.side === 'buy').reduce((s, f) => s + f.amount, ZERO);
    expect(bought).toBe(d.venue!.positions[0]!.size);
    expect(d.log.map((e) => e.kind)).toEqual(expect.arrayContaining(['deployed', 'started', 'strategy_order']));
  });
});
