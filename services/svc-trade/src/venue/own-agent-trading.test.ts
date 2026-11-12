import http from 'node:http';
import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Principal } from '@intafaced/auth';
import type { StepUpCheck } from '@intafaced/contracts';
import { mul, parseAmount, sub } from '@intafaced/ledger-client/money';
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
import { attachOwnAgentTradingRoutes } from './own-agent-trading-rest.js';
import { OwnAgentTrading, allowanceApproveKey, allowanceRevokeKey, ownAgentOrderKey, type AllowanceView } from './own-agent-trading.js';
import { InMemoryPreparedActionStore } from './prepared-action-store.js';
import { UserVenueDoor } from './user-venue-door.js';
import { listedTestStore } from './venue-listing-store.js';
import { StoreVenueRoutingGate } from './venue-listing.js';

// J-agents-08 #3 to #7 at the service, against the TEST venue simulator over loopback HTTP. Every figure is TEST. The
// person's wallet is a fixed TEST key; svc-agents' gate is a fixed answer here (its own tests decide the rules).

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

describe("a person's own agent trading their venue sub-account under an allowance (TEST venue)", () => {
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
  let actions: InMemoryPreparedActionStore;
  let store: InMemoryAllowanceStore;
  let policy: FixedOwnAgentPolicy;
  let submitFault: 'none' | 'lost_after_send' = 'none';
  let subA: UserVenueAccount;
  let subB: UserVenueAccount;

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
      listings: new StoreVenueRoutingGate(listedTestStore(['BTC-USDC', 'BTC-PERP'])),
      now: () => new Date(),
    });
    store = new InMemoryAllowanceStore();
    if (p) policy = p;
    trading = new OwnAgentTrading({ door, store, policy: p, values: VALUES, now: () => new Date() });
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
    subB = { ...main(), subAccount: made[1]! };
    await own(main(), {
      kind: 'sub_account_transfer',
      subAccount: subA.subAccount!,
      direction: 'into_sub_account',
      asset: 'USDC',
      amount: a('50'),
      moveKey: `own:${runs}:fund`,
    });
    build();
    submitFault = 'none';
  });

  const grant = (allowanceId: string, amount: string | undefined = '20', period = 'week', subAccount = subA.subAccount) =>
    trading.grant(person, AGENT, { allowanceId, owner, subAccount, amount, period });

  /** A granted allowance of TEST 20 for a week, its agent permission signed by the wallet. */
  async function active(amount = '20'): Promise<AllowanceView> {
    let v = await grant(uuid('a11'), amount);
    for (let i = 0; v.next && i < 3; i += 1)
      v = await trading.submit(person, AGENT, v.allowanceId, v.next.actionKey, await sign(v.next.prepared));
    expect(v.status).toBe('active');
    return v;
  }

  const buy = (orderId: string, size = '0.0001') => ({ orderId, side: 'buy', base: 'BTC', size, type: 'market' });
  const agentKeys = () => actions.listByPrefix(USER, 'agent:order:');
  const allRows = () => actions.listByPrefix(USER, '');

  it('#3: an order before any allowance or agent permission refuses agents.allowance_unset, and nothing is prepared or sent', async () => {
    const e = await refusedAs(trading.preview(person, AGENT, buy(uuid('0e'))));
    expect(e.code).toBe('agents.allowance_unset');
    expect(e.message).toContain('no allowance');
    expect((await refusedAs(trading.place(person, AGENT, buy(uuid('0e'))))).code).toBe('agents.allowance_unset');
    expect(await agentKeys()).toEqual([]);
    expect((await sim.openOrders(subA)).value).toEqual([]);
    expect((await sim.openOrders(main())).value).toEqual([]);
  });

  it('#3: an allowance whose agent permission is not signed yet still refuses, naming the signature', async () => {
    await grant(uuid('a11'));
    expect((await refusedAs(trading.preview(person, AGENT, buy(uuid('0e'))))).code).toBe('agents.allowance_not_signed');
  });

  it('#4: a blank amount refuses naming the field; nothing is stored or asked of the wallet', async () => {
    const e = await refusedAs(grant(uuid('a11'), ''));
    expect(e.code).toBe('agents.allowance_amount_unset');
    expect(e.detail).toEqual({ field: 'amount' });
    expect(await store.listForAgent(USER, AGENT)).toEqual([]);
    expect(await allRows()).toEqual([]);
    expect((await refusedAs(grant(uuid('a11'), '20', ''))).detail).toEqual({ field: 'period' });
  });

  it('#4: TEST 20 for a week asks the wallet to sign the agent permission on sub-account A only; signed, it lists 20 left and its end', async () => {
    const before = Date.now();
    const v = await grant(uuid('a11'));
    expect(v.status).toBe('signing');
    expect(v.next).toMatchObject({ step: 'approve_agent', actionKey: allowanceApproveKey(v.allowanceId), signed: false });
    expect(v.next!.prepared.account).toEqual(subA);
    expect(v.next!.prepared.intent).toMatchObject({ kind: 'approve_agent', agentAddress: v.agentAddress });
    expect(policy.calls).toEqual([{ userId: USER, agentId: AGENT, account: `sub:${subA.subAccount}` }]);
    const signed = await trading.submit(person, AGENT, v.allowanceId, v.next!.actionKey, await sign(v.next!.prepared));
    expect(signed).toMatchObject({ status: 'active', amount: a('20'), left: a('20'), asset: 'USDC', permissionOnVenue: true, next: null });
    expect(signed.endsAt.getTime() - before).toBeGreaterThanOrEqual(7 * 86_400_000 - 5_000);
    expect(signed.endsAt.getTime() - Date.now()).toBeLessThanOrEqual(7 * 86_400_000);
    // The venue's own record: the permission is on sub-account A, and not on B or the main account.
    expect((await sim.agents(subA)).value.map((x) => x.address.toLowerCase())).toContain(v.agentAddress);
    expect((await sim.agents(subB)).value.map((x) => x.address.toLowerCase())).not.toContain(v.agentAddress);
    expect((await sim.agents(main())).value.map((x) => x.address.toLowerCase())).not.toContain(v.agentAddress);
  });

  it('#4: a rejected signature grants nothing: the allowance is abandoned and the venue lists no permission', async () => {
    const v = await grant(uuid('a11'));
    const gone = await trading.abandon(person, AGENT, v.allowanceId);
    expect(gone.status).toBe('abandoned');
    expect((await sim.agents(subA)).value.map((x) => x.address.toLowerCase())).not.toContain(v.agentAddress);
    expect((await refusedAs(trading.preview(person, AGENT, buy(uuid('0e'))))).code).toBe('agents.allowance_unset');
    // A new grant after it is a new allowance with a new key.
    const again = await grant(uuid('a11'));
    expect(again.agentAddress).not.toBe(v.agentAddress);
  });

  it("#4: svc-agents' gate refusing the sub-account refuses the grant with its code; with no gate, policy_unavailable", async () => {
    build(new FixedOwnAgentPolicy({ allowed: false, code: 'agents.access_account_denied' }));
    expect((await refusedAs(grant(uuid('a11'), '20', 'week', subB.subAccount))).code).toBe('agents.access_account_denied');
    build(null);
    expect((await refusedAs(grant(uuid('a11')))).code).toBe('agents.policy_unavailable');
    expect(await allRows()).toEqual([]);
  });

  it('#4 #5 over REST: a blank amount in the JSON body refuses naming the field; a grant and a preview in decimal strings work', async () => {
    const app = Fastify();
    attachOwnAgentTradingRoutes(app, trading, {
      requirePrincipal: () => person,
      requireTradeJurisdiction: () => true,
    } as unknown as Parameters<typeof attachOwnAgentTradingRoutes>[2]);
    await app.ready();
    try {
      const url = `/api/v1/venue/own-agents/${AGENT}`;
      const blank = await app.inject({
        method: 'POST',
        url: `${url}/allowances`,
        payload: { allowanceId: uuid('a11'), owner, subAccount: subA.subAccount, amount: '', period: 'week' },
      });
      expect(blank.statusCode).toBe(422);
      expect(blank.json()).toMatchObject({ intafacedCode: 'agents.allowance_amount_unset' });
      expect(JSON.stringify(blank.json())).toContain('"field":"amount"');
      expect(await allRows()).toEqual([]);
      const granted = await app.inject({
        method: 'POST',
        url: `${url}/allowances`,
        payload: { allowanceId: uuid('a11'), owner, subAccount: subA.subAccount, amount: '20', period: 'week' },
      });
      expect(granted.statusCode, granted.body).toBe(200);
      const v = (await trading.list(person, AGENT))[0]!;
      const signed = await trading.submit(person, AGENT, v.allowanceId, v.next!.actionKey, await sign(v.next!.prepared));
      expect(signed.status).toBe('active');
      const preview = await app.inject({ method: 'POST', url: `${url}/orders/preview`, payload: buy(uuid('0e')) });
      expect(preview.statusCode, preview.body).toBe(200);
      expect(preview.json()).toMatchObject({ symbol: 'BTC-USDC', side: 'buy', type: 'market', size: '0.0001', left: '20' });
    } finally {
      await app.close();
    }
  });

  it('#5: a preview names side, market, type, size, price and the venue fee, and sends nothing', async () => {
    await active();
    const p = await trading.preview(person, AGENT, buy(uuid('0e')));
    expect(p).toMatchObject({
      symbol: 'BTC-USDC',
      side: 'buy',
      type: 'market',
      size: a('0.0001'),
      asset: 'USDC',
      left: a('20'),
      test: true,
    });
    expect(p.notional).toBe(mul(p.size, p.price, 'ceil'));
    expect(p.fee).not.toBeNull();
    expect(await agentKeys()).toEqual([]);
    expect((await sim.openOrders(subA)).value).toEqual([]);
  });

  it("#6: approved, the order is placed on sub-account A signed by the allowance's key, once; the key can't withdraw", async () => {
    const v = await active();
    const orderId = uuid('0e');
    const usdcBefore = (await sim.balances(subA)).value.find((b) => b.asset === 'USDC')!.total;
    const placed = await trading.place(person, AGENT, buy(orderId));
    expect(placed).toMatchObject({
      state: 'accepted',
      subAccount: subA.subAccount,
      signedBy: v.agentAddress,
      actionKey: ownAgentOrderKey(AGENT, orderId),
    });
    const stored = (await actions.find(USER, ownAgentOrderKey(AGENT, orderId)))!;
    expect(stored.prepared.account).toEqual(subA);
    expect(stored.signature?.signedBy).toBe(v.agentAddress);
    // The venue's record: the fill is on sub-account A; the main account traded nothing.
    // The venue takes its fee from the BTC bought, so the sub-account holds a little under 0.0001.
    const btc = (await sim.balances(subA)).value.find((b) => b.asset === 'BTC')!.total;
    expect(btc > a('0.0000999') && btc <= a('0.0001')).toBe(true);
    expect((await sim.balances(subA)).value.find((b) => b.asset === 'USDC')!.total < usdcBefore).toBe(true);
    expect((await sim.balances(main())).value.find((b) => b.asset === 'BTC')?.total ?? a('0')).toBe(a('0'));
    // The allowance's left is less the order's commitment.
    const [after] = await trading.list(person, AGENT);
    expect(after!.left).toBe(sub(a('20'), mul(placed.size, placed.price, 'ceil')));
    // The same order again is the venue's record of it: nothing is signed or sent again.
    const again = await trading.place(person, AGENT, buy(orderId));
    expect(again).toMatchObject({ state: 'accepted', replayed: true });
    expect((await sim.balances(subA)).value.find((b) => b.asset === 'BTC')?.total).toBe(btc);
    // The agent permission never withdraws: the venue refuses its key a withdrawal from the sub-account.
    await expect(
      sim.prepare(subA, { role: 'agent', address: v.agentAddress }, {
        kind: 'withdraw',
        asset: 'USDC',
        amount: a('1'),
        destination: owner,
        withdrawalKey: 'withdraw:test:agent',
      } as VenueIntent),
    ).rejects.toMatchObject({ refusal: { code: 'agent_not_permitted' } });
  });

  it('#6 money: a draw that was refused is refused again on its order id, never signed or sent outside the allowance', async () => {
    const v = await active('20');
    const orderId = uuid('0e');
    const p = await trading.preview(person, AGENT, buy(orderId));
    // The draw as place() admits it, then refused (the agent key's signing failed, or a revoke landed before it signed).
    const d = {
      userId: USER,
      orderId,
      allowanceId: v.allowanceId,
      symbol: p.symbol,
      side: 'buy' as const,
      type: 'market' as const,
      size: p.size,
      price: p.price,
      amount: p.notional,
      state: 'admitted' as const,
      createdAt: new Date(),
    };
    expect((await store.admit(d, new Date())).admitted).toBe(true);
    await store.refuse(USER, orderId);
    expect(await store.admit(d, new Date())).toMatchObject({ admitted: false, refusal: 'draw_refused' });
    expect((await refusedAs(trading.place(person, AGENT, buy(orderId)))).code).toBe('agents.order_refused');
    expect(await agentKeys()).toEqual([]);
    expect((await sim.openOrders(subA)).value).toEqual([]);
    expect((await sim.fills(subA, new Date(0))).value).toEqual([]);
  });

  it('#6 money: two draws at once that together exceed the allowance admit one', async () => {
    await active('20');
    // Each about TEST 13 at the worst price (2% over a ~60000 mark): one fits in 20, two do not.
    const [x, y] = await Promise.allSettled([
      trading.place(person, AGENT, buy(uuid('0e'), '0.0002')),
      trading.place(person, AGENT, buy(uuid('0e'), '0.0002')),
    ]);
    const outcomes = [x, y].map((r) => (r.status === 'fulfilled' ? 'placed' : (r.reason as AgentAccountError).code)).sort();
    expect(outcomes).toEqual(['agents.allowance_exceeded', 'placed']);
    // One fill of 0.0002, less the venue's fee in BTC: not two.
    const btc = (await sim.balances(subA)).value.find((b) => b.asset === 'BTC')!.total;
    expect(btc > a('0.0001999') && btc <= a('0.0002')).toBe(true);
  });

  it('#6 money: a crash after the order was sent is read back by its client order id; the order is sent once', async () => {
    await active();
    const orderId = uuid('0e');
    submitFault = 'lost_after_send';
    await expect(trading.place(person, AGENT, buy(orderId))).rejects.toMatchObject({ refusal: { code: 'venue_down' } });
    const signed = await actions.find(USER, ownAgentOrderKey(AGENT, orderId));
    expect(signed?.signature).not.toBeNull();
    const back = await trading.place(person, AGENT, buy(orderId));
    expect(back).toMatchObject({ state: 'accepted', replayed: true });
    expect(back.order?.venueClientOrderId).toBe(signed!.prepared.venueClientOrderId);
    // One fill of 0.0001 on the venue, and the stored signature is the first one: never signed again.
    const btc = (await sim.balances(subA)).value.find((b) => b.asset === 'BTC')!.total;
    expect(btc > a('0.0000999') && btc <= a('0.0001')).toBe(true);
    expect((await actions.find(USER, ownAgentOrderKey(AGENT, orderId)))?.signature).toEqual(signed!.signature);
    expect((await store.draws(USER, back.allowanceId)).length).toBe(1);
  });

  it('#7: revoking ends admission at once, then asks the wallet to sign the venue revoke; an order already sent is read back', async () => {
    const v = await active();
    const first = await trading.place(person, AGENT, buy(uuid('0e')));
    const revoked = await trading.revoke(person, AGENT, v.allowanceId);
    expect(revoked).toMatchObject({ status: 'revoked', permissionOnVenue: true });
    expect(revoked.next).toMatchObject({ step: 'revoke_agent', actionKey: allowanceRevokeKey(v.allowanceId) });
    // The next admission refuses before anything is prepared, even while the venue still lists the permission.
    const sentBefore = (await agentKeys()).length;
    expect((await refusedAs(trading.place(person, AGENT, buy(uuid('0e'))))).code).toBe('agents.allowance_revoked');
    expect((await refusedAs(trading.preview(person, AGENT, buy(uuid('0e'))))).code).toBe('agents.allowance_revoked');
    expect((await agentKeys()).length).toBe(sentBefore);
    const done = await trading.submit(person, AGENT, v.allowanceId, revoked.next!.actionKey, await sign(revoked.next!.prepared));
    expect(done).toMatchObject({ status: 'revoked', permissionOnVenue: false, next: null });
    expect((await sim.agents(subA)).value.map((x) => x.address.toLowerCase())).not.toContain(v.agentAddress);
    const orders = await trading.orders(person, AGENT);
    expect(orders.map((o) => [o.orderId, o.state])).toEqual([[first.orderId, 'accepted']]);
  });
});
