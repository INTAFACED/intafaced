import http from 'node:http';
import { MemoryFreezeRead } from '../quant/live-run/ports.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Principal } from '@intafaced/auth';
import type { StepUpCheck } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client/money';
import {
  VenueRefusalError,
  type PreparedVenueAction,
  type UserVenue,
  type UserVenueAccount,
  type VenueIntent,
} from '@intafaced/venue-contracts';
import { startTestVenueServer, type TestVenueSimulator, type TestVenueTypedData } from '@intafaced/venue-sim';
import { AgentAccountError, parseAgentAccountValues } from './agent-account.js';
import { HttpUserVenue } from './http-user-venue.js';
import { InMemoryAllowanceStore } from './own-agent-allowance-store.js';
import { FixedOwnAgentPolicy } from './own-agent-policy-client.js';
import { InMemoryRebalanceStore, OwnAgentRebalance, rebalanceOrderId } from './own-agent-rebalance.js';
import { OwnAgentTrading, ownAgentOrderKey, type AllowanceView } from './own-agent-trading.js';
import { InMemoryPreparedActionStore } from './prepared-action-store.js';
import { UserVenueDoor } from './user-venue-door.js';
import { listedTestStore } from './venue-listing-store.js';
import { StoreVenueRoutingGate } from './venue-listing.js';

// J-agents-18 #1 #2 at the service: the Portfolio planner's rebalance of a person's own agent's sub-account, against the
// TEST venue simulator over loopback HTTP. Every figure is TEST. The person's wallet is a fixed TEST key; svc-agents'
// gate is a fixed answer here (its own tests decide the rules).

const a = parseAmount;
const USER = '11111111-1111-4111-8111-1111111111f1';
const AGENT = '22222222-2222-4222-8222-2222222222f2';
const person = {
  sub: USER,
  userId: USER,
  sid: '33333333-3333-4333-8333-3333333333f3',
  scopes: ['trade:read', 'trade:write'],
  tier: 'basic',
  mfa: false,
  expiresAt: new Date(Date.now() + 600_000),
} as Principal;

const key = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet svc-trade own agent trading')));
const owner = key.address.toLowerCase();
async function sign(prepared: PreparedVenueAction) {
  const t = prepared.typedData as TestVenueTypedData;
  const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  return { digest: prepared.digest, signature, signedBy: owner };
}

const VALUES = parseAgentAccountValues({
  TRADE_AGENT_ACCOUNT_CEILING: '500',
  TRADE_AGENT_ACCOUNT_ASSET: 'USDC',
  TRADE_AGENT_KEY_SEED: 'intafaced unit TEST own agent trading seed',
  TRADE_AGENT_MAX_ORDER_NOTIONAL: '1000',
  TRADE_AGENT_WORST_PRICE_BPS: '200',
  TRADE_AGENT_MARKETS: 'BTC-USDC,BTC-PERP',
});

let n = 0;
const uuid = (tail: string) => {
  n += 1;
  return `${tail.padEnd(8, '0').slice(0, 8)}-0000-4000-8000-${String(n).padStart(12, '0')}`;
};

async function refusedAs(promise: Promise<unknown>): Promise<AgentAccountError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AgentAccountError);
    return error as AgentAccountError;
  }
  throw new Error('expected a refusal');
}

const noStepUp: StepUpCheck = {
  async require() {
    return { stepUpEventId: 'unused', consumedAt: null, replayed: false };
  },
};

describe("the Portfolio planner's rebalance of a person's own agent's sub-account (TEST venue)", () => {
  let server: http.Server;
  let sim: TestVenueSimulator;
  let url: string;
  const main = (): UserVenueAccount => ({ venueId: sim.venue.id, owner, subAccount: null });

  beforeAll(async () => {
    ({ server, sim, url } = await startTestVenueServer({ host: '127.0.0.1', port: 0, appEnv: 'test', chainId: 84532 }));
    const { seedTestVenue } = await import('@intafaced/venue-sim');
    await seedTestVenue(sim);
  });
  afterAll(
    async () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );

  let trading: OwnAgentTrading;
  let planner: OwnAgentRebalance;
  let actions: InMemoryPreparedActionStore;
  let store: InMemoryAllowanceStore;
  let submitFault: 'none' | 'lost_after_send' = 'none';
  let subA: UserVenueAccount;

  /** The person's wallet signs one action on its own venue account, on the TEST venue directly (the journey's start). */
  async function own(account: UserVenueAccount, intent: VenueIntent) {
    const prepared = await sim.prepare(account, { role: 'owner', address: owner }, intent);
    const outcome = await sim.submit(prepared, await sign(prepared));
    expect(outcome.definite && outcome.accepted).toBe(true);
    return outcome;
  }

  function build(p: FixedOwnAgentPolicy | null = new FixedOwnAgentPolicy()) {
    actions = new InMemoryPreparedActionStore();
    const door = new UserVenueDoor({
      connect: async () => {
        const venue = await HttpUserVenue.connect({ baseUrl: url, timeoutMs: 2000 });
        return new Proxy(venue, {
          get(target, prop, receiver) {
            if (prop === 'submit') {
              return async (...args: Parameters<UserVenue['submit']>) => {
                const fault = submitFault;
                submitFault = 'none';
                const answer = await target.submit(...args);
                if (fault === 'lost_after_send')
                  throw new VenueRefusalError({ venueId: target.venue.id, code: 'venue_down', detail: 'TEST: the answer was lost' });
                return answer;
              };
            }
            const v = Reflect.get(target, prop, receiver);
            return typeof v === 'function' ? v.bind(target) : v;
          },
        });
      },
      appEnv: 'test',
      store: actions,
      stepUp: noStepUp,
      builder: { address: '0x00000000000000000000000000000000000000b1', feeBps: a('1') },
      // Blank: an agent's market order carries the owner's agent bound as its worst price, never the spot protection.
      slippageCapBps: null,
      listings: new StoreVenueRoutingGate(listedTestStore(['BTC-USDC', 'BTC-PERP'])),
      now: () => new Date(),
    });
    store = new InMemoryAllowanceStore();
    trading = new OwnAgentTrading({ door, store, policy: p, values: VALUES, freeze: new MemoryFreezeRead(), now: () => new Date() });
    planner = new OwnAgentRebalance({ trading, store: new InMemoryRebalanceStore(), now: () => new Date() });
  }

  let runs = 0;
  beforeEach(async () => {
    runs += 1;
    sim.deposit(main(), 'USDC', a('1000'), `deposit:test:own-agent:${runs}`);
    const made: string[] = [];
    for (const name of ['A', 'B']) {
      const o = await own(main(), { kind: 'create_sub_account', name: `own-${runs}-${name}`, subAccountKey: `own:${runs}:${name}` });
      made.push((o as { venueRef: string }).venueRef);
    }
    subA = { ...main(), subAccount: made[0]! };
    await own(main(), {
      kind: 'sub_account_transfer',
      subAccount: subA.subAccount!,
      direction: 'into_sub_account',
      asset: 'USDC',
      amount: a('100'),
      moveKey: `own:${runs}:fund`,
    });
    sim.deposit(main(), 'BTC', a('0.001'), `deposit:test:own-agent:btc:${runs}`);
    await own(main(), {
      kind: 'sub_account_transfer',
      subAccount: subA.subAccount!,
      direction: 'into_sub_account',
      asset: 'BTC',
      amount: a('0.001'),
      moveKey: `own:${runs}:fund-btc`,
    });
    // A sell on the venue carries the builder fee, which the wallet approved once, as a person who has sold there has.
    await own(subA, { kind: 'approve_builder_fee', builder: '0x00000000000000000000000000000000000000b1', maxFeeBps: a('1') });
    build();
    submitFault = 'none';
  });

  /** A granted allowance for a week, its agent permission signed by the wallet. */
  async function active(amount = '50'): Promise<AllowanceView> {
    let v = await trading.grant(person, AGENT, { allowanceId: uuid('a11'), owner, subAccount: subA.subAccount, amount, period: 'week' });
    for (let i = 0; v.next && i < 3; i += 1)
      v = await trading.submit(person, AGENT, v.allowanceId, v.next.actionKey, await sign(v.next.prepared));
    expect(v.status).toBe('active');
    return v;
  }

  const agentKeys = () => actions.listByPrefix(USER, 'agent:order:');
  /** What the venue holds and has traded on sub-account A, and the main account's orders. */
  const venueState = async () => ({
    balances: (await sim.balances(subA)).value.map((b) => [b.asset, b.total]),
    fills: (await sim.fills(subA, new Date(0))).value.length,
    open: (await sim.openOrders(subA)).value.length,
    mainOpen: (await sim.openOrders(main())).value.length,
  });
  const propose = (percent: string, proposalId = uuid('9e')) =>
    planner.propose(person, AGENT, { proposalId, targets: [{ asset: 'BTC', percent }] });

  it('#1: a proposal lists each order from what the venue reports the sub-account holds, and executes nothing', async () => {
    await active();
    const before = await venueState();
    const p = await propose('25');
    expect(p.status).toBe('proposed');
    expect(p.test).toBe(true);
    expect(p.holdings.map((h) => [h.asset, h.total])).toEqual([
      ['USDC', a('100')],
      ['BTC', a('0.001')],
    ]);
    // BTC is about 60 of about 160 TEST USDC; 25% is about 40, so the planner sells BTC in whole lots of 0.0001.
    expect(p.orders).toHaveLength(1);
    expect(p.orders[0]).toMatchObject({ symbol: 'BTC-USDC', side: 'sell', base: 'BTC', size: a('0.0003') });
    expect(p.orders[0]!.orderId).toBe(rebalanceOrderId(p.proposalId, 0));
    // Nothing executed: nothing prepared, signed or sent, nothing drawn on the allowance.
    expect(await agentKeys()).toEqual([]);
    expect(await store.draws(USER, p.allowanceId)).toEqual([]);
    expect(await venueState()).toEqual(before);
    // The same proposal id again is the stored proposal, not a second one.
    expect((await propose('25', p.proposalId)).orders).toEqual(p.orders);
    expect(await planner.list(person, AGENT)).toHaveLength(1);
  });

  it('#1: without an allowance whose agent permission the wallet signed, no proposal is made', async () => {
    expect((await refusedAs(propose('25'))).code).toBe('agents.allowance_unset');
  });

  it('#1: a blank target, or none for an asset the sub-account holds, refuses naming it; over 100 refuses', async () => {
    await active();
    const blank = await refusedAs(propose(''));
    expect(blank.code).toBe('agents.rebalance_target_unset');
    expect(blank.detail).toEqual({ asset: 'BTC' });
    const none = await refusedAs(planner.propose(person, AGENT, { proposalId: uuid('9e'), targets: [{ asset: 'ETH', percent: '10' }] }));
    expect(none.code).toBe('agents.rebalance_target_unset');
    expect(none.detail).toEqual({ asset: 'BTC' });
    expect((await refusedAs(propose('101'))).code).toBe('agents.rebalance_target_invalid');
    expect(await planner.list(person, AGENT)).toEqual([]);
  });

  it('#2: approving one places its orders on sub-account A by the agent permission, each once; the rejected one changes nothing', async () => {
    const allowance = await active();
    const sell = await propose('25');
    const buy = await propose('75');
    expect(buy.orders[0]).toMatchObject({ side: 'buy', base: 'BTC' });
    const before = await venueState();
    // Rejected: nothing is prepared, signed, sent or drawn.
    expect((await planner.reject(person, AGENT, buy.proposalId)).status).toBe('rejected');
    expect(await venueState()).toEqual(before);
    expect(await agentKeys()).toEqual([]);
    expect((await refusedAs(planner.approve(person, AGENT, buy.proposalId))).code).toBe('agents.rebalance_rejected');
    // Approved: the sell is placed on A, signed by the allowance's agent key, and fills on the venue.
    const done = await planner.approve(person, AGENT, sell.proposalId);
    expect(done.proposal.status).toBe('approved');
    expect(done.orders.map((o) => [o.orderId, o.state, o.side, o.size, o.subAccount, o.signedBy])).toEqual([
      [sell.orders[0]!.orderId, 'accepted', 'sell', a('0.0003'), subA.subAccount, allowance.agentAddress],
    ]);
    const after = await venueState();
    expect(after.fills).toBe(before.fills + 1);
    expect(after.balances.find(([x]) => x === 'BTC')![1]).toBe(a('0.0007'));
    expect(after.mainOpen).toBe(before.mainOpen);
    expect((await agentKeys()).map((r) => r.businessKey)).toEqual([ownAgentOrderKey(AGENT, sell.orders[0]!.orderId)]);
    // Approved again (a double press): the same order read back from the venue, never a second one.
    const again = await planner.approve(person, AGENT, sell.proposalId);
    expect(again.orders.map((o) => [o.orderId, o.state, o.replayed])).toEqual([[sell.orders[0]!.orderId, 'accepted', true]]);
    expect((await venueState()).fills).toBe(after.fills);
    expect(await store.draws(USER, allowance.allowanceId)).toHaveLength(1);
    expect((await refusedAs(planner.reject(person, AGENT, sell.proposalId))).code).toBe('agents.rebalance_approved');
  });

  it('#2: a proposal whose orders need more than the allowance has left refuses whole: nothing is sent and it stays proposed', async () => {
    await active('10');
    const p = await propose('0');
    expect(p.orders[0]).toMatchObject({ side: 'sell', size: a('0.001') });
    const before = await venueState();
    const e = await refusedAs(planner.approve(person, AGENT, p.proposalId));
    expect(e.code).toBe('agents.rebalance_exceeds_allowance');
    expect(e.detail).toMatchObject({ left: '10', asset: 'USDC' });
    expect(await venueState()).toEqual(before);
    expect(await agentKeys()).toEqual([]);
    expect((await planner.list(person, AGENT))[0]!.status).toBe('proposed');
  });
});
