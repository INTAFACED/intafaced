import http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { AuthError, type Principal } from '@intafaced/auth';
import { StepUpCheckError, type AgentKeyRead, type StepUpCheck, type StepUpCheckRequest } from '@intafaced/contracts';
import { formatAmount, parseAmount } from '@intafaced/ledger-client/money';
import { VenueRefusalError, type PreparedVenueAction, type UserVenue, type UserVenueAccount } from '@intafaced/venue-contracts';
import { startTestVenueServer, type TestVenueSimulator, type TestVenueTypedData } from '@intafaced/venue-sim';
import { AgentAccountError, AgentAccounts, parseAgentAccountValues, type AgentAccountView } from './agent-account.js';
import { InMemoryAgentAccountStore } from './agent-account-store.js';
import { InMemoryAgentConnectionStore } from './agent-connection-store.js';
import type { AgentKeyReader } from './agent-key-read-client.js';
import { AgentOrders, AgentVenueRefusal, agentLeverageKey, agentOrderKey, dailyLossOf } from './agent-orders.js';
import { HttpUserVenue } from './http-user-venue.js';
import { InMemoryPreparedActionStore } from './prepared-action-store.js';
import { UserVenueDoor } from './user-venue-door.js';
import { listedTestStore } from './venue-listing-store.js';
import { StoreVenueRoutingGate } from './venue-listing.js';

// J-agents-21 #6 #7 #10 at the service (piece 1: the assistant's trade path), against the TEST venue simulator over
// loopback HTTP. Every figure is TEST. The person's wallet is a fixed TEST key; the assistant is an API-key principal.

const a = parseAmount;
const USER = '11111111-1111-4111-8111-1111111111e1';
const OTHER_USER = '11111111-1111-4111-8111-1111111111e2';
const SESSION = '33333333-3333-4333-8333-3333333333e3';
const person = {
  sub: USER,
  userId: USER,
  sid: SESSION,
  scopes: ['trade:read', 'trade:write'],
  tier: 'basic',
  mfa: false,
  expiresAt: new Date(Date.now() + 600_000),
} as Principal;
const assistant = (kid: string, userId = USER) => ({ ...person, userId, sub: userId, kid }) as Principal;

const key = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet svc-trade agent orders')));
const owner = key.address.toLowerCase();
async function sign(prepared: PreparedVenueAction) {
  const t = prepared.typedData as TestVenueTypedData;
  const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  return { digest: prepared.digest, signature, signedBy: owner };
}

// Bounds wide enough that the person's cap (200) decides; the bound's own refusal is checked with its own values below.
const VALUES = parseAgentAccountValues({
  TRADE_AGENT_ACCOUNT_CEILING: '500',
  TRADE_AGENT_ACCOUNT_ASSET: 'USDC',
  TRADE_AGENT_KEY_SEED: 'intafaced unit TEST agent orders seed',
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
  throw new Error('expected an AgentAccountError');
}

/** Identity's read of a person's key: a table of keys by owner. */
function keyTable() {
  const keys = new Map<string, { userId: string; read: Extract<AgentKeyRead, { state: 'found' }> }>();
  let down = false;
  const reader: AgentKeyReader = {
    async read(userId, keyId) {
      if (down) return null;
      const k = keys.get(keyId);
      return k && k.userId === userId ? k.read : { state: 'none' };
    },
  };
  return {
    reader,
    add(keyId: string, userId: string, kind: 'agent' | 'personal', scopes: string[], revoked = false) {
      keys.set(keyId, { userId, read: { state: 'found', keyId, kind, scopes, revoked } });
    },
    setDown(v: boolean) {
      down = v;
    },
  };
}

describe("the assistant's trade path on its agent account (TEST venue)", () => {
  let server: http.Server;
  let sim: TestVenueSimulator;
  let url: string;
  const main = (): UserVenueAccount => ({ venueId: sim.venue.id, owner, subAccount: null });
  const total = async (account: UserVenueAccount, asset: string) =>
    (await sim.balances(account)).value.find((b) => b.asset === asset)?.total ?? a('0');

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

  let accounts: AgentAccounts;
  let orders: AgentOrders;
  let door: UserVenueDoor;
  let actions: InMemoryPreparedActionStore;
  let accountStore: InMemoryAgentAccountStore;
  let connections: InMemoryAgentConnectionStore;
  let keys: ReturnType<typeof keyTable>;
  let stepUps: StepUpCheckRequest[];
  /** What the next submit to the venue does: send normally, send then lose the answer, or lose it before sending. */
  let submitFault: 'none' | 'lost_after_send' | 'lost_before_send' = 'none';

  function build(values = VALUES) {
    actions = new InMemoryPreparedActionStore();
    stepUps = [];
    const stepUp: StepUpCheck = {
      async require(req) {
        stepUps.push(req);
        if (!req.approvalId) throw new StepUpCheckError('confirm first', 'identity.step_up_required');
        return { stepUpEventId: 'step-up-test', consumedAt: null, replayed: false };
      },
    };
    door = new UserVenueDoor({
      connect: async () => {
        const venue = await HttpUserVenue.connect({ baseUrl: url, timeoutMs: 2000 });
        // A crash between the signature and the venue's answer, planted at the venue's edge.
        return new Proxy(venue, {
          get(target, prop, receiver) {
            if (prop === 'submit') {
              return async (...args: Parameters<UserVenue['submit']>) => {
                const fault = submitFault;
                submitFault = 'none';
                const lost = () =>
                  new VenueRefusalError({ venueId: target.venue.id, code: 'venue_down', detail: 'TEST: the answer was lost' });
                if (fault === 'lost_before_send') throw lost();
                const answer = await target.submit(...args);
                if (fault === 'lost_after_send') throw lost();
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
      stepUp,
      builder: { address: '0x00000000000000000000000000000000000000b1', feeBps: a('1') },
      // Blank: its orders are limits, which the protection never bounds.
      slippageCapBps: null,
      listings: new StoreVenueRoutingGate(listedTestStore(['BTC-USDC', 'BTC-PERP'])),
      now: () => new Date(),
    });
    accountStore = new InMemoryAgentAccountStore();
    connections = new InMemoryAgentConnectionStore();
    keys = keyTable();
    accounts = new AgentAccounts({ door, store: accountStore, stepUp, values, now: () => new Date() });
    orders = new AgentOrders({ door, accounts: accountStore, connections, keys: keys.reader, stepUp, values, now: () => new Date() });
  }

  let topUps = 0;
  beforeEach(() => {
    build();
    submitFault = 'none';
    topUps += 1;
    sim.deposit(main(), 'USDC', a('1000'), `deposit:test:agent-orders:top-up:${topUps}`);
  });

  /** An open agent account (cap 200, funded 150) and an agent key with trade scopes connected to it. */
  async function connected(values = VALUES) {
    if (values !== VALUES) build(values);
    let v: AgentAccountView = await accounts.create(person, {
      accountId: uuid('acc'),
      owner,
      asset: 'USDC',
      cap: '200',
      fund: '150',
      stepUpApprovalId: 'approval-1',
    });
    for (let i = 0; v.next && i < 5; i += 1) v = await accounts.submit(person, v.accountId, v.next.actionKey, await sign(v.next.prepared));
    expect(v.status).toBe('open');
    const keyId = uuid('beef');
    keys.add(keyId, USER, 'agent', ['trade:read', 'trade:write']);
    await orders.connect(person, v.accountId, { keyId, stepUpApprovalId: 'approval-2' });
    const sub: UserVenueAccount = { ...main(), subAccount: v.subAccount };
    return { account: v, keyId, sub };
  }

  const buy = (clientOrderId: string, amount: string, price = '60100') => ({
    clientOrderId,
    symbol: 'BTC-USDC',
    side: 'buy',
    type: 'limit',
    amount,
    price,
    timeInForce: 'IOC',
  });

  // ── #6: connecting the assistant ──────────────────────────────────────────────────────────────────────────────

  describe('#6 connect', () => {
    async function openAccount() {
      let v = await accounts.create(person, {
        accountId: uuid('acc'),
        owner,
        asset: 'USDC',
        cap: '200',
        fund: '150',
        stepUpApprovalId: 'ok',
      });
      for (let i = 0; v.next && i < 5; i += 1)
        v = await accounts.submit(person, v.accountId, v.next.actionKey, await sign(v.next.prepared));
      return v;
    }

    it("binds the person's own agent key with trade scopes, after step-up naming the key and the account", async () => {
      const v = await openAccount();
      const keyId = uuid('beef');
      keys.add(keyId, USER, 'agent', ['trade:read', 'trade:write']);
      const before = stepUps.length;
      const c = await orders.connect(person, v.accountId, { keyId, stepUpApprovalId: 'approval' });
      expect(c).toMatchObject({ keyId, accountId: v.accountId, subAccount: v.subAccount });
      expect(stepUps.slice(before)).toEqual([
        expect.objectContaining({
          scope: 'trade.step_up.venue.agentConnect',
          fields: { keyId, accountId: v.accountId },
          requestId: `venue.agentConnect:${keyId}`,
        }),
      ]);
      // The same again is the same connection; no second step-up.
      expect(await orders.connect(person, v.accountId, { keyId })).toMatchObject({ keyId, accountId: v.accountId });
      expect(stepUps.length).toBe(before + 1);
      expect(await orders.connections(person)).toHaveLength(1);
    });

    it("refuses, before step-up, a key that is not the caller's, not an agent key, revoked, or holding any non-trade scope", async () => {
      const v = await openAccount();
      const cases: Array<[string, () => void, string]> = [
        ['other', () => keys.add(ids.other!, OTHER_USER, 'agent', ['trade:write']), 'agents.key_unknown'],
        ['personal', () => keys.add(ids.personal!, USER, 'personal', ['trade:read', 'trade:write']), 'agents.key_not_agent'],
        ['revoked', () => keys.add(ids.revoked!, USER, 'agent', ['trade:write'], true), 'agents.key_revoked'],
        ['scoped', () => keys.add(ids.scoped!, USER, 'agent', ['trade:write', 'bank:read']), 'agents.key_scope_not_trade'],
        ['readonly', () => keys.add(ids.readonly!, USER, 'agent', ['trade:read']), 'agents.key_scope_not_trade'],
      ];
      const ids = Object.fromEntries(cases.map(([name]) => [name, uuid('beef')])) as Record<string, string>;
      const before = stepUps.length;
      for (const [name, add, code] of cases) {
        add();
        expect((await refusedAs(orders.connect(person, v.accountId, { keyId: ids[name], stepUpApprovalId: 'ok' }))).code, name).toBe(code);
      }
      keys.setDown(true);
      const down = await refusedAs(orders.connect(person, v.accountId, { keyId: uuid('beef'), stepUpApprovalId: 'ok' }));
      expect([down.code, down.status]).toEqual(['agents.key_read_unavailable', 503]);
      expect(stepUps.length).toBe(before);
      expect(await orders.connections(person)).toEqual([]);
    });

    it("is refused from an API key (the assistant cannot connect itself), and on an account not open or not the caller's", async () => {
      const v = await openAccount();
      const keyId = uuid('beef');
      keys.add(keyId, USER, 'agent', ['trade:write']);
      await expect(orders.connect(assistant(keyId), v.accountId, { keyId, stepUpApprovalId: 'ok' })).rejects.toBeInstanceOf(AuthError);
      const stranger = { ...person, userId: OTHER_USER, sub: OTHER_USER } as Principal;
      expect((await refusedAs(orders.connect(stranger, v.accountId, { keyId, stepUpApprovalId: 'ok' }))).code).toBe(
        'agents.account_unknown',
      );
      await accountStore.update(USER, v.accountId, { status: 'closed', closedAt: new Date() });
      expect((await refusedAs(orders.connect(person, v.accountId, { keyId, stepUpApprovalId: 'ok' }))).code).toBe(
        'agents.account_not_open',
      );
    });

    it('a key trades one account: connecting it to a second refuses agents.key_already_connected', async () => {
      const first = await openAccount();
      const second = await openAccount();
      const keyId = uuid('beef');
      keys.add(keyId, USER, 'agent', ['trade:write']);
      await orders.connect(person, first.accountId, { keyId, stepUpApprovalId: 'ok' });
      expect((await refusedAs(orders.connect(person, second.accountId, { keyId, stepUpApprovalId: 'ok' }))).code).toBe(
        'agents.key_already_connected',
      );
    });
  });

  // ── #7 #10: the assistant's orders ────────────────────────────────────────────────────────────────────────────

  it('#7: a buy fills on the agent sub-account as the venue reports it; the main account is unchanged; origin agent:<keyId>', async () => {
    const { keyId, sub } = await connected();
    const mainUsdc = await total(main(), 'USDC');
    const mainBtc = await total(main(), 'BTC');
    const view = await orders.place(assistant(keyId), buy('buy-1', '0.001'));
    expect(view).toMatchObject({
      state: 'accepted',
      origin: `agent:${keyId}`,
      actionKey: agentOrderKey(keyId, 'buy-1'),
      account: { owner, subAccount: sub.subAccount },
      replayed: false,
      test: true,
    });
    // The fill, as the venue reports it: 0.001 BTC less the venue's own fee, on the sub-account.
    const btc = await total(sub, 'BTC');
    expect(btc).toBeGreaterThan(a('0'));
    expect(btc).toBeLessThanOrEqual(a('0.001'));
    expect(view.order?.filled).toBe(a('0.001'));
    expect(await total(sub, 'USDC')).toBeLessThan(a('150'));
    expect(await total(main(), 'USDC')).toBe(mainUsdc);
    expect(await total(main(), 'BTC')).toBe(mainBtc);
    // The person's own order list shows it, tagged by its origin.
    const listed = await door.orderByKey(person, agentOrderKey(keyId, 'buy-1'));
    expect(listed).toMatchObject({ state: 'accepted', origin: `agent:${keyId}` });
  });

  it('a key not connected, or a person session, refuses before anything is prepared', async () => {
    await connected();
    const loose = uuid('beef');
    const e = await refusedAs(orders.place(assistant(loose), buy('x-1', '0.001')));
    expect([e.code, e.status]).toEqual(['agents.key_not_connected', 403]);
    // Another person's API key naming this person's connected key id is not connected for them.
    const { keyId } = await connected();
    expect((await refusedAs(orders.place(assistant(keyId, OTHER_USER), buy('x-2', '0.001')))).code).toBe('agents.key_not_connected');
    expect((await refusedAs(orders.place(person, buy('x-3', '0.001')))).code).toBe('agents.order_needs_agent_key');
    expect(await actions.listByPrefix(USER, 'agent:order:')).toEqual([]);
  });

  it('a key connected to an account that is closed refuses agents.account_not_open', async () => {
    const { keyId, account } = await connected();
    await accountStore.update(USER, account.accountId, { status: 'closed', closedAt: new Date() });
    expect((await refusedAs(orders.place(assistant(keyId), buy('closed-1', '0.001')))).code).toBe('agents.account_not_open');
    expect(await actions.listByPrefix(USER, 'agent:order:')).toEqual([]);
  });

  it('an order past the cap refuses agents.order_cap_exceeded before the agent key signs; the venue never sees it', async () => {
    const { keyId, sub } = await connected();
    const before = (await sim.openOrders(sub)).value.length;
    const e = await refusedAs(orders.place(assistant(keyId), buy('big-1', '0.005'))); // ~300 USDC on a cap of 200
    expect([e.code, e.status]).toEqual(['agents.order_cap_exceeded', 422]);
    const stored = await door.stored(assistant(keyId), agentOrderKey(keyId, 'big-1'));
    expect(stored?.signature ?? null).toBeNull();
    expect((await sim.openOrders(sub)).value.length).toBe(before);
    expect(formatAmount(await total(sub, 'USDC'))).toBe('150');
  });

  it("an order past the owner's largest agent order refuses agents.order_above_bound", async () => {
    const { keyId } = await connected(parseAgentAccountValues({ ...rawValues(), TRADE_AGENT_MAX_ORDER_NOTIONAL: '50' }));
    expect((await refusedAs(orders.place(assistant(keyId), buy('bound-1', '0.001')))).code).toBe('agents.order_above_bound');
  });

  it("#10: an order costing more than the account holds is the venue's refusal, named; nothing open; main never drawn", async () => {
    const { keyId, sub } = await connected();
    const mainUsdc = await total(main(), 'USDC');
    // ~180 USDC: inside the cap of 200, more than the 150 the sub-account holds. A resting (GTC) bid below the book.
    let refusal: AgentVenueRefusal | null = null;
    try {
      await orders.place(assistant(keyId), { ...buy('poor-1', '0.003', '59900'), timeInForce: 'GTC' });
    } catch (error) {
      refusal = error as AgentVenueRefusal;
    }
    expect(refusal).toBeInstanceOf(AgentVenueRefusal);
    expect(refusal!.refusal.code).toBe('insufficient_balance');
    expect(refusal!.message).toContain(sim.venue.displayName);
    expect((await sim.openOrders(sub)).value).toEqual([]);
    expect(formatAmount(await total(sub, 'USDC'))).toBe('150');
    expect(await total(main(), 'USDC')).toBe(mainUsdc);
    const read = await door.orderByKey(person, agentOrderKey(keyId, 'poor-1'));
    expect(read.state).not.toBe('accepted');
  });

  it('a retry with the same clientOrderId is the same order: sent once; other terms under it refuse', async () => {
    const { keyId, sub } = await connected();
    const order = { ...buy('rest-1', '0.001', '59000'), timeInForce: 'GTC' };
    const first = await orders.place(assistant(keyId), order);
    const second = await orders.place(assistant(keyId), order);
    expect(first.state).toBe('accepted');
    expect(second).toMatchObject({ state: 'accepted', replayed: true });
    expect(second.order?.venueClientOrderId).toBe(first.order?.venueClientOrderId);
    expect((await sim.openOrders(sub)).value.filter((o) => o.venueClientOrderId === first.order?.venueClientOrderId)).toHaveLength(1);
    await expect(orders.place(assistant(keyId), { ...order, amount: '0.002' })).rejects.toMatchObject({ code: 'idempotency.conflict' });
  });

  it('a crash after the order is signed and sent, before the answer is read, is read back by client order id: one order', async () => {
    const { keyId, sub } = await connected();
    const order = { ...buy('crash-1', '0.001', '59000'), timeInForce: 'GTC' };
    submitFault = 'lost_after_send';
    await expect(orders.place(assistant(keyId), order)).rejects.toMatchObject({ refusal: { code: 'venue_down' } });
    const signed = await door.stored(person, agentOrderKey(keyId, 'crash-1'));
    expect(signed?.signature).not.toBeNull();
    const again = await orders.place(assistant(keyId), order);
    expect(again).toMatchObject({ state: 'accepted', replayed: true });
    expect(again.order?.venueClientOrderId).toBe(signed!.prepared.venueClientOrderId);
    expect((await sim.openOrders(sub)).value.filter((o) => o.venueClientOrderId === signed!.prepared.venueClientOrderId)).toHaveLength(1);
    // The signature was never made again: the stored bytes are the first ones.
    expect((await door.stored(person, agentOrderKey(keyId, 'crash-1')))?.signature).toEqual(signed!.signature);
  });

  it('a crash after the order is signed but before it reached the venue re-sends the stored bytes once', async () => {
    const { keyId, sub } = await connected();
    const order = { ...buy('crash-2', '0.001', '59000'), timeInForce: 'GTC' };
    submitFault = 'lost_before_send';
    await expect(orders.place(assistant(keyId), order)).rejects.toMatchObject({ refusal: { code: 'venue_down' } });
    const signed = await door.stored(person, agentOrderKey(keyId, 'crash-2'));
    expect(signed?.signature).not.toBeNull();
    expect((await sim.orderByClientId(sub, signed!.prepared.venueClientOrderId!)).value).toBeNull();
    const again = await orders.place(assistant(keyId), order);
    expect(again.state).toBe('accepted');
    expect((await sim.openOrders(sub)).value.filter((o) => o.venueClientOrderId === signed!.prepared.venueClientOrderId)).toHaveLength(1);
    expect((await door.stored(person, agentOrderKey(keyId, 'crash-2')))?.signature).toEqual(signed!.signature);
  });

  it('a JSON number is never money', async () => {
    const { keyId } = await connected();
    expect((await refusedAs(orders.place(assistant(keyId), { ...buy('num-1', '0.001'), amount: 0.001 }))).code).toBe(
      'agents.order_request_invalid',
    );
  });

  // ── #8: a perpetual, isolated on the agent account ──────────────────────────────────────────────────────────────

  /** The person's own wallet approves our builder fee on the agent sub-account, once, as on any account they trade. */
  async function builderApproved(sub: UserVenueAccount) {
    const prepared = await door.prepare(person, {
      owner,
      subAccount: sub.subAccount,
      signer: { role: 'owner', address: owner },
      intent: { kind: 'approve_builder_fee', builder: '0x00000000000000000000000000000000000000b1', maxFeeBps: a('1') },
      actionKey: `approve:${sub.subAccount}:builder`,
    });
    const sent = await door.submit(person, prepared.actionKey, await sign(prepared.prepared));
    expect(sent.outcome).toMatchObject({ definite: true, accepted: true });
  }
  const perp = (clientOrderId: string, amount: string, extra: Record<string, unknown> = {}) => ({
    clientOrderId,
    symbol: 'BTC-PERP',
    side: 'buy',
    type: 'market',
    amount,
    price: '60100',
    timeInForce: 'IOC',
    leverage: '1',
    ...extra,
  });

  it('#8: a perp opens isolated at the named leverage on the agent sub-account; its margin is taken there and nowhere else', async () => {
    const { keyId, sub, account } = await connected();
    await builderApproved(sub);
    const mainBefore = { usdc: await total(main(), 'USDC'), positions: (await sim.positions(main())).value };
    const view = await orders.place(assistant(keyId), perp('perp-1', '0.001'));
    expect(view).toMatchObject({ state: 'accepted', origin: `agent:${keyId}`, account: { owner, subAccount: sub.subAccount } });
    // The agent key set the market isolated at 1x on the sub-account first, under its own business key.
    expect((await sim.leverage(sub, 'BTC-PERP')).value).toMatchObject({ leverageBps: 10_000, marginMode: 'isolated' });
    const lev = await door.stored(person, agentLeverageKey(keyId, 'perp-1'));
    expect(lev?.prepared.intent).toMatchObject({
      kind: 'update_leverage',
      symbol: 'BTC-PERP',
      leverageBps: 10_000,
      marginMode: 'isolated',
    });
    expect(lev?.prepared.account).toEqual(sub);
    expect(lev?.prepared.signer).toEqual({ role: 'agent', address: account.agentAddress });
    // One long position on the sub-account, its margin the venue's, out of the sub-account's 150.
    const positions = (await sim.positions(sub)).value;
    expect(positions).toHaveLength(1);
    expect(positions[0]).toMatchObject({ symbol: 'BTC-PERP', side: 'long', size: a('0.001'), leverageBps: 10_000 });
    expect(positions[0]!.margin).toBeGreaterThan(a('0'));
    expect(await total(sub, 'USDC')).toBeLessThan(a('150'));
    // The main venue account is untouched.
    expect(await total(main(), 'USDC')).toBe(mainBefore.usdc);
    expect((await sim.positions(main())).value).toEqual(mainBefore.positions);
  });

  it('#8: a setting the venue already shows is not signed again; a reduce-only close needs none and signs none', async () => {
    const { keyId, sub } = await connected();
    await builderApproved(sub);
    await orders.place(assistant(keyId), perp('perp-a', '0.001'));
    await orders.place(assistant(keyId), perp('perp-b', '0.001'));
    expect(await door.stored(person, agentLeverageKey(keyId, 'perp-b'))).toBeNull();
    const closed = await orders.place(assistant(keyId), {
      ...perp('perp-close', '0.002', { side: 'sell', price: '59900', reduceOnly: true }),
      leverage: undefined,
    });
    expect(closed.state).toBe('accepted');
    expect(await door.stored(person, agentLeverageKey(keyId, 'perp-close'))).toBeNull();
    expect((await sim.positions(sub)).value).toEqual([]);
  });

  it('#8: an opening perp names its leverage; spot takes none; a leverage cut past the cap is refused before signing', async () => {
    const { keyId, sub } = await connected();
    await builderApproved(sub);
    const noLev = await refusedAs(orders.place(assistant(keyId), { ...perp('perp-x', '0.001'), leverage: undefined }));
    expect([noLev.code, noLev.status]).toEqual(['agents.order_request_invalid', 400]);
    expect((await refusedAs(orders.place(assistant(keyId), perp('perp-y', '0.001', { leverage: 2 })))).code).toBe(
      'agents.order_request_invalid',
    );
    expect((await refusedAs(orders.place(assistant(keyId), { ...buy('spot-lev', '0.001'), leverage: '2' }))).code).toBe(
      'agents.order_request_invalid',
    );
    expect((await sim.leverage(sub, 'BTC-PERP')).value).toBeNull();
    expect(await actions.listByPrefix(USER, 'agent:')).toEqual(
      expect.not.arrayContaining([expect.objectContaining({ businessKey: expect.stringMatching(/^agent:(order|leverage):/) })]),
    );
  });

  it("#17: an order above the person's per-order cap, then one above their leverage cap, each refused naming the cap before anything is signed", async () => {
    const { keyId, sub, account } = await connected(
      parseAgentAccountValues({ ...rawValues(), TRADE_AGENT_MAX_LEVERAGE: '5', TRADE_AGENT_MAX_DAILY_LOSS: '100' }),
    );
    await builderApproved(sub);
    await accounts.setLimits(person, account.accountId, { maxOrderNotional: '50', maxLeverage: '2' });
    const before = {
      usdc: await total(sub, 'USDC'),
      orders: (await sim.openOrders(sub)).value,
      positions: (await sim.positions(sub)).value,
    };
    // 0.001 × 60100 = 60.1 USDC, above the per-order cap of 50 (and inside the cap of 200 and the owner's bound).
    const size = await refusedAs(orders.place(assistant(keyId), buy('size-1', '0.001')));
    expect([size.code, size.status]).toEqual(['agents.order_size_cap_exceeded', 422]);
    expect(size.detail).toEqual({ cap: '50', notional: '60.1' });
    expect(size.message).toContain('50 USDC');
    // 3x on a perp, above the leverage cap of 2x, on an order inside the per-order cap.
    const lev = await refusedAs(orders.place(assistant(keyId), perp('lev-1', '0.0005', { leverage: '3' })));
    expect([lev.code, lev.status]).toEqual(['agents.leverage_cap_exceeded', 422]);
    expect(lev.detail).toEqual({ cap: '2', leverage: '3' });
    // Before anything is signed: no order and no leverage setting stored or sent; the venue shows nothing new.
    for (const k of [agentOrderKey(keyId, 'size-1'), agentOrderKey(keyId, 'lev-1'), agentLeverageKey(keyId, 'lev-1')]) {
      expect(await door.stored(person, k), k).toBeNull();
    }
    expect((await sim.leverage(sub, 'BTC-PERP')).value).toBeNull();
    expect({
      usdc: await total(sub, 'USDC'),
      orders: (await sim.openOrders(sub)).value,
      positions: (await sim.positions(sub)).value,
    }).toEqual(before);
    // At the caps, the same orders go through.
    expect((await orders.place(assistant(keyId), buy('size-2', '0.0008'))).state).toBe('accepted');
    expect((await orders.place(assistant(keyId), perp('lev-2', '0.0005', { leverage: '2' }))).state).toBe('accepted');
  });

  it("#18: once the day's loss reaches the person's daily-loss cap, the assistant's next order is refused naming the cap; open positions are untouched", async () => {
    const values = parseAgentAccountValues({ ...rawValues(), TRADE_AGENT_MAX_LEVERAGE: '5', TRADE_AGENT_MAX_DAILY_LOSS: '100' });
    const { keyId, sub, account } = await connected(values);
    await builderApproved(sub);
    await accounts.setLimits(person, account.accountId, { maxLeverage: '2', maxDailyLoss: '0.03' });
    // Opens 0.0008 long at 2x: its taker fee (~0.02 USDC) is under the cap, so the close goes on.
    expect((await orders.place(assistant(keyId), perp('dl-open', '0.0008', { leverage: '2' }))).state).toBe('accepted');
    // Closes half across the spread: a realised loss and a second fee take the day's loss past 0.03.
    expect(
      (
        await orders.place(assistant(keyId), {
          ...perp('dl-close', '0.0004', { side: 'sell', price: '59900', reduceOnly: true }),
          leverage: undefined,
        })
      ).state,
    ).toBe('accepted');
    const since = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
    const fills = (await sim.fills(sub, since)).value;
    expect(fills).toHaveLength(2);
    const loss = dailyLossOf(fills, 'USDC');
    expect(loss).toBeGreaterThanOrEqual(a('0.03'));
    const before = {
      sub: (await sim.balances(sub)).value,
      orders: (await sim.openOrders(sub)).value,
      positions: (await sim.positions(sub)).value,
    };
    expect(before.positions).toEqual([expect.objectContaining({ symbol: 'BTC-PERP', side: 'long', size: a('0.0004') })]);

    // The next order, any order: refused naming the cap and the day's loss, before anything is stored or signed.
    for (const [id, order] of [
      ['dl-next', perp('dl-next', '0.0001', { leverage: '2' })],
      ['dl-spot', buy('dl-spot', '0.0001')],
    ] as const) {
      const refused = await refusedAs(orders.place(assistant(keyId), order));
      expect([refused.code, refused.status]).toEqual(['agents.daily_loss_cap_reached', 422]);
      expect(refused.detail).toEqual({ cap: '0.03', loss: formatAmount(loss), since: since.toISOString() });
      expect(refused.message).toContain('daily-loss cap');
      expect(refused.message).toContain('0.03 USDC');
      expect(await door.stored(person, agentOrderKey(keyId, id))).toBeNull();
      expect(await door.stored(person, agentLeverageKey(keyId, id))).toBeNull();
    }
    // Open positions untouched: nothing closed, cancelled or moved on the venue.
    expect({
      sub: (await sim.balances(sub)).value,
      orders: (await sim.openOrders(sub)).value,
      positions: (await sim.positions(sub)).value,
    }).toEqual(before);

    // A new UTC day starts from no loss: the same account's assistant may order again.
    const tomorrow = new Date(since.getTime() + 86_400_000 + 60_000);
    const nextDay = new AgentOrders({
      door,
      accounts: accountStore,
      connections,
      keys: keys.reader,
      stepUp: { require: async () => ({ stepUpEventId: 'step-up-test', consumedAt: null, replayed: false }) },
      values,
      now: () => tomorrow,
    });
    expect((await nextDay.place(assistant(keyId), buy('dl-tomorrow', '0.0001'))).state).toBe('accepted');
  });

  it("#18: the day's loss is realised results less every fee, a base-asset fee valued at its fill price; a gain is no loss", () => {
    const fill = (realisedPnl: string | null, fee: string, feeAsset = 'USDC', price = '60000') => ({
      price: a(price),
      venueFee: a(fee),
      builderFee: a('0'),
      feeAsset,
      realisedPnl: realisedPnl === null ? null : a(realisedPnl),
    });
    expect(dailyLossOf([], 'USDC')).toBe(a('0'));
    expect(dailyLossOf([fill(null, '0.02'), fill('-0.01', '0.01')], 'USDC')).toBe(a('0.04'));
    expect(dailyLossOf([fill('5', '0.02')], 'USDC')).toBe(a('0'));
    // 0.000001 BTC of fee at 60000 is 0.06 USDC.
    expect(dailyLossOf([fill(null, '0.000001', 'BTC')], 'USDC')).toBe(a('0.06'));
    expect(dailyLossOf([{ ...fill('-1', '0'), builderFee: a('0.5') }], 'USDC')).toBe(a('1.5'));
  });

  it("#10: a perp needing more margin than the account holds is the venue's refusal, named; nothing locked; main never drawn", async () => {
    const { keyId, sub } = await connected();
    await builderApproved(sub);
    await orders.place(assistant(keyId), perp('perp-m1', '0.001'));
    const before = { sub: (await sim.balances(sub)).value, main: await total(main(), 'USDC'), positions: (await sim.positions(sub)).value };
    // ~96 USDC of margin at 1x: inside the cap of 200 with the open position (~60), more than the ~90 the sub-account has free.
    let refusal: AgentVenueRefusal | null = null;
    try {
      await orders.place(assistant(keyId), perp('perp-m2', '0.0016'));
    } catch (error) {
      refusal = error as AgentVenueRefusal;
    }
    expect(refusal).toBeInstanceOf(AgentVenueRefusal);
    expect(refusal!.refusal.code).toBe('insufficient_balance');
    expect(refusal!.refusal.detail).toContain('margin');
    expect(refusal!.message).toContain(sim.venue.displayName);
    expect((await sim.balances(sub)).value).toEqual(before.sub);
    expect((await sim.positions(sub)).value).toEqual(before.positions);
    expect(await total(main(), 'USDC')).toBe(before.main);
  });

  // ── #9: the connected key reaches nothing but its own order route ────────────────────────────────────────────

  it('#9: confined() is true only for an API key connected to an agent account of its own person', async () => {
    const { keyId } = await connected();
    expect(await orders.confined(assistant(keyId))).toBe(true);
    expect(await orders.confined(assistant(keyId, OTHER_USER))).toBe(false);
    expect(await orders.confined(assistant(uuid('beef')))).toBe(false);
    expect(await orders.confined(person)).toBe(false);
  });

  it('INVARIANT: no order from this route names any account but the bound agent sub-account, whatever the request says', async () => {
    const { keyId, sub, account } = await connected();
    const mainOrders = (await sim.openOrders(main())).value.length;
    // A request that names the main account, another owner or another sub-account is placed on the bound sub-account only.
    await orders.place(assistant(keyId), { ...buy('inv-1', '0.001', '30000'), timeInForce: 'GTC', owner, subAccount: null });
    await orders.place(assistant(keyId), {
      ...buy('inv-2', '0.001', '30000'),
      timeInForce: 'GTC',
      owner: '0x00000000000000000000000000000000000000ff',
      subAccount: 'someone-else',
      account: main(),
    });
    await orders.place(assistant(keyId), buy('inv-3', '0.001'));
    const placed = await actions.listByPrefix(USER, 'agent:order:');
    expect(placed.length).toBe(3);
    for (const row of placed) {
      expect(row.prepared.account).toEqual({ venueId: sim.venue.id, owner, subAccount: sub.subAccount });
      expect(row.prepared.signer).toEqual({ role: 'agent', address: account.agentAddress });
    }
    expect((await sim.openOrders(main())).value.length).toBe(mainOrders);
  });
});

function rawValues() {
  return {
    TRADE_AGENT_ACCOUNT_CEILING: '500',
    TRADE_AGENT_ACCOUNT_ASSET: 'USDC',
    TRADE_AGENT_KEY_SEED: 'intafaced unit TEST agent orders seed',
    TRADE_AGENT_MAX_ORDER_NOTIONAL: '1000',
    TRADE_AGENT_WORST_PRICE_BPS: '200',
    TRADE_AGENT_MARKETS: 'BTC-USDC,BTC-PERP',
  };
}
