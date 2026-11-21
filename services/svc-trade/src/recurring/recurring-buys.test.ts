import type http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { keccak256, toHex, type TypedDataDefinition } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { Principal } from '@intafaced/auth';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client/money';
import type { PlaceUserOrderIntent, UserVenueAccount } from '@intafaced/venue-contracts';
import { seedTestVenue, startTestVenueServer, type TestVenueSimulator } from '@intafaced/venue-sim';
import { HttpUserVenue } from '../venue/http-user-venue.js';
import { InMemoryPreparedActionStore } from '../venue/prepared-action-store.js';
import { MemoryFreezeRead } from '../quant/live-run/ports.js';
import { UserVenueDoor } from '../venue/user-venue-door.js';
import { MemoryVenueListingStore } from '../venue/venue-listing-store.js';
import { StoreVenueRoutingGate } from '../venue/venue-listing.js';
import { CARD_FUNDING_OFF, RecurringBuys, RecurringError, convertOrderKey, recurringAgentKey, slotOrderKey } from './recurring-buys.js';
import { recurringTrpcError } from './router.js';
import { InMemoryRecurringStore } from './store.js';

// J-copy-bots-otc-16 in svc-trade: a recurring buy of a basket on the person's own venue account, against the TEST venue
// simulator over HTTP. The venue holds the coins and the fills; nothing here is posted. Every figure is TEST. Each test
// lists three TEST spot markets of its own and a TEST wallet of its own, so the book and the balances are only its own.

const a = parseAmount;
const USER = '11111111-1111-4111-8111-11111111c516';
const person = {
  sub: USER,
  userId: USER,
  sid: '33333333-3333-4333-8333-3333333333d1',
  scopes: ['trade:read', 'trade:write'],
  tier: 'full',
  mfa: false,
  expiresAt: new Date(Date.now() + 600_000),
} as Principal;
const BUILDER = '0x00000000000000000000000000000000000000b4';
const REGION = 'DE';
const SEED = 'intafaced unit TEST recurring buy seed';
const key = (name: string) => privateKeyToAccount(keccak256(toHex(`intafaced TEST recurring buy ${name}`)));
const DAY = 86_400_000;

async function refused(p: Promise<unknown>): Promise<RecurringError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof RecurringError) return err;
    throw err;
  }
  throw new Error('expected a RecurringError');
}

describe('the recurring buy on the venue (J-copy-bots-otc-16)', { timeout: 60_000 }, () => {
  let server: http.Server;
  let sim: TestVenueSimulator;
  let url: string;
  let venueId: string;
  beforeAll(async () => {
    ({ server, sim, url } = await startTestVenueServer({ host: '127.0.0.1', port: 0, appEnv: 'test', chainId: 84532 }));
    await seedTestVenue(sim);
    venueId = ((await (await fetch(`${url}/venue`)).json()) as { venue: { id: string } }).venue.id;
  });
  afterAll(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );

  let n = 0;
  const id = (tag: string) => `${tag}-${(n += 1)}`;
  let door: UserVenueDoor;
  let store: InMemoryRecurringStore;
  let recurring: RecurringBuys;
  let notices: { ruleId: string; slot: number }[];
  let clock: Date;
  let freeze: MemoryFreezeRead;
  let wallet: PrivateKeyAccount;
  let owner: string;
  let SYMS: string[] = [];
  const maker = key('maker');

  const account = (who: string): UserVenueAccount => ({ venueId, owner: who, subAccount: null });
  const free = async (asset: string, who = owner) =>
    (await sim.balances(account(who))).value.find((b) => b.asset === asset)?.free ?? a('0');

  async function outside(k: PrivateKeyAccount, intent: Omit<PlaceUserOrderIntent, 'kind' | 'builderFee' | 'reduceOnly'>) {
    const who = k.address.toLowerCase();
    const prepared = await sim.prepare(
      account(who),
      { role: 'owner', address: who },
      { kind: 'place_order', reduceOnly: false, builderFee: null, ...intent },
    );
    const signature = await k.signTypedData(prepared.typedData as TypedDataDefinition);
    return sim.submit(prepared, { digest: prepared.digest, signature, signedBy: who });
  }
  async function outsideCancel(k: PrivateKeyAccount, symbol: string, clientOrderKey: string) {
    const who = k.address.toLowerCase();
    const prepared = await sim.prepare(account(who), { role: 'owner', address: who }, { kind: 'cancel_order', symbol, clientOrderKey });
    const signature = await k.signTypedData(prepared.typedData as TypedDataDefinition);
    return sim.submit(prepared, { digest: prepared.digest, signature, signedBy: who });
  }
  async function signAsWallet(prepared: { actionKey: string; prepared: { typedData: unknown; digest: string } }) {
    const signature = await wallet.signTypedData(prepared.prepared.typedData as TypedDataDefinition);
    return door.submit(person, prepared.actionKey, { digest: prepared.prepared.digest, signature, signedBy: owner });
  }

  beforeEach(async () => {
    const listings = new MemoryVenueListingStore();
    SYMS = [];
    for (const tag of ['A', 'B', 'C']) {
      const base = `RB${tag}${(n += 1)}`;
      const symbol = `${base}-USDC`;
      const added = await fetch(`${url}/test/market-add`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ symbol, baseAsset: base, quoteAsset: 'USDC', maxOrderQty: null, maxOrderNotional: null }),
      });
      expect(added.status).toBe(200);
      await listings.appendListing({
        venueId,
        symbol,
        version: 1,
        change: 'listing',
        opensAt: new Date('2026-01-01T00:00:00.000Z'),
        delistsAt: null,
        routing: 'show',
        approvalId: `test-stack-listing:${venueId}:${symbol}`,
        proposerId: 'TEST fixture',
        approverId: 'TEST fixture approval',
        executorId: 'TEST fixture',
        reason: 'TEST fixture listing',
        recordedAt: new Date('2026-01-01T00:00:00.000Z'),
      });
      sim.deposit(account(maker.address.toLowerCase()), base, a('1000'), `chain:recurring:${id('d')}`);
      sim.deposit(account(maker.address.toLowerCase()), 'USDC', a('100000'), `chain:recurring:${id('d')}`);
      // A two-sided book: asks at 10, bids at 9.9.
      await outside(maker, {
        symbol,
        side: 'sell',
        type: 'limit',
        amount: a('500'),
        price: a('10'),
        timeInForce: 'GTC',
        clientOrderKey: `order:maker:${symbol}:ask`,
      });
      await outside(maker, {
        symbol,
        side: 'buy',
        type: 'limit',
        amount: a('500'),
        price: a('9.9'),
        timeInForce: 'GTC',
        clientOrderKey: `order:maker:${symbol}:bid`,
      });
      SYMS.push(symbol);
    }
    wallet = key(`wallet ${id('w')}`);
    owner = wallet.address.toLowerCase();
    sim.deposit(account(owner), 'USDC', a('100'), `chain:recurring:${id('d')}`);
    door = new UserVenueDoor({
      connect: () => HttpUserVenue.connect({ baseUrl: url, timeoutMs: 5000 }),
      appEnv: 'test',
      store: new InMemoryPreparedActionStore(),
      stepUp: { check: async () => ({ ok: true }) } as never,
      builder: { address: BUILDER, feeBps: a('1') },
      listings: new StoreVenueRoutingGate(listings),
      ordersPageMax: 100,
      slippageCapBps: 500,
      spreadLimitBps: 5000,
      now: () => new Date(),
    } as never);
    store = new InMemoryRecurringStore();
    notices = [];
    clock = new Date();
    freeze = new MemoryFreezeRead();
    recurring = new RecurringBuys({
      door,
      store,
      verification: () => ({ mode: 'required', level: 'full' }),
      keySeed: SEED,
      liveTier: async () => 'full',
      freeze,
      notices: { suspended: async (x) => void notices.push({ ruleId: x.ruleId, slot: x.slot }) },
      now: () => clock,
    });
  });

  async function approveBuilder() {
    await signAsWallet(
      await door.prepare(person, {
        owner,
        signer: { role: 'owner', address: owner },
        intent: { kind: 'approve_builder_fee', builder: BUILDER, maxFeeBps: a('5') },
        actionKey: `builder-fee:${owner}:${id('fee')}`,
      }),
    );
  }

  const create = (over: Record<string, unknown> = {}) =>
    recurring.create(
      person,
      {
        clientRequestId: `recurring-${id('k')}`,
        owner,
        funding: 'venue',
        basket: [
          { symbol: SYMS[0]!, weightPct: '50' },
          { symbol: SYMS[1]!, weightPct: '30' },
          { symbol: SYMS[2]!, weightPct: '20' },
        ],
        amount: '10',
        frequency: 'daily',
        maxInvestment: null,
        ...over,
      },
      REGION,
    );

  async function sign(view: Awaited<ReturnType<typeof create>>) {
    if (!view.next) return recurring.get(person, view.ruleId);
    const next = view.next;
    const stored = await door.stored(person, next.actionKey);
    const signature = await wallet.signTypedData(stored!.prepared.typedData as TypedDataDefinition);
    return recurring.submitPermission(person, {
      ruleId: view.ruleId,
      actionKey: next.actionKey,
      signature: { digest: next.digest, signature, signedBy: owner },
    });
  }

  /** A day goes by: the next slot is due, and the tick runs. */
  async function nextDay(ruleId: string) {
    store.age(ruleId, DAY);
    await recurring.tickAll();
    return recurring.get(person, ruleId);
  }

  it('refuses weights that total 90, a range with min above max, card funding and a blank amount by name, saving nothing', async () => {
    await approveBuilder();
    expect(
      await refused(
        create({
          basket: [
            { symbol: SYMS[0], weightPct: '50' },
            { symbol: SYMS[1], weightPct: '30' },
            { symbol: SYMS[2], weightPct: '10' },
          ],
        }),
      ),
    ).toMatchObject({
      code: 'trade.recurring_weights_not_100',
      message: 'The weights add up to 90%. They must add up to 100%.',
    });
    expect(await refused(create({ basket: [{ symbol: SYMS[0], weightPct: '100', lowestPrice: '20', highestPrice: '10' }] }))).toMatchObject(
      { code: 'trade.recurring_price_range_inverted', message: 'Coin 1: the lowest price must be below the highest price' },
    );
    expect(await refused(create({ funding: 'card' }))).toMatchObject({
      code: 'trade.recurring_card_funding_off',
      message: CARD_FUNDING_OFF,
    });
    expect(await refused(create({ amount: '' }))).toMatchObject({
      code: 'trade.recurring_field_invalid',
      message: 'Amount each time is required',
    });
    expect((await refused(create({ owner: '' }))).code).toBe('trade.recurring_wallet_required');
    expect((await refused(create({ basket: [{ symbol: 'NOPE-USDC', weightPct: '100' }] }))).code).toBe('trade.recurring_market_not_found');
    expect(await store.listForUser(USER)).toEqual([]);
    expect(recurringTrpcError(await refused(create({ funding: 'card' })))).toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('refuses an unapproved builder fee: ending the rule sells, and every sell carries it', async () => {
    expect((await refused(create())).code).toBe('trade.recurring_builder_fee_unapproved');
  });

  it('waits for the agent permission, then buys 50, 30 and 20 percent of each slot as one venue order per coin under its key', async () => {
    await approveBuilder();
    const made = await create();
    expect(made.status).toBe('signing');
    expect(made.next?.actionKey).toBe(recurringAgentKey(owner, made.venue.agentAddress));
    await recurring.tickAll();
    expect(await free('USDC')).toBe(a('100'));
    const active = await sign(made);
    expect(active.status).toBe('active');
    expect(active.slots).toHaveLength(1);
    const [slot] = active.slots;
    expect(slot!.amount).toBe('10');
    expect(slot!.orders.map((o) => [o.orderKey, o.status, o.filled, o.spent])).toEqual([
      [slotOrderKey(made.ruleId, 0, SYMS[0]!), 'filled', '0.5', '5'],
      [slotOrderKey(made.ruleId, 0, SYMS[1]!), 'filled', '0.3', '3'],
      [slotOrderKey(made.ruleId, 0, SYMS[2]!), 'filled', '0.2', '2'],
    ]);
    expect(await free('USDC')).toBe(a('90'));
    // The same request key is the same rule, and the tick before the next slot is due buys nothing more.
    expect((await create({ clientRequestId: made.clientRequestId })).ruleId).toBe(made.ruleId);
    await recurring.tickAll();
    expect((await recurring.get(person, made.ruleId)).slots).toHaveLength(1);
  });

  it('changes the amount from 10 to 20: the next slot buys 20, the earlier one keeps 10', async () => {
    await approveBuilder();
    const made = await sign(await create());
    const updated = await recurring.update(person, { ruleId: made.ruleId, amount: '20', maxInvestment: '' });
    expect(updated.amount).toBe('20');
    expect(updated.slots.map((s) => [s.amount, s.spent])).toEqual([['10', '10']]);
    const after = await nextDay(made.ruleId);
    expect(after.slots.map((s) => [s.amount, s.spent])).toEqual([
      ['10', '10'],
      ['20', '20'],
    ]);
    expect(await free('USDC')).toBe(a('70'));
  });

  it('suspends once for insufficient funds with one notice, and funds arriving resume it once', async () => {
    await approveBuilder();
    const made = await sign(await create({ amount: '60' }));
    expect(await free('USDC')).toBe(a('40'));
    const short = await nextDay(made.ruleId);
    expect(short.status).toBe('suspended_insufficient_funds');
    expect(short.slots.at(-1)?.outcome).toBe('skipped_insufficient_funds');
    expect(notices).toEqual([{ ruleId: made.ruleId, slot: 1 }]);
    // Still short: no second notice, still suspended, nothing bought.
    await recurring.tickAll();
    await recurring.tickAll();
    expect(notices).toHaveLength(1);
    expect((await recurring.get(person, made.ruleId)).status).toBe('suspended_insufficient_funds');
    expect(await free('USDC')).toBe(a('40'));
    sim.deposit(account(owner), 'USDC', a('100'), `chain:recurring:${id('d')}`);
    await recurring.tickAll();
    const resumed = await recurring.get(person, made.ruleId);
    expect(resumed.status).toBe('active');
    expect(resumed.slots).toHaveLength(2);
    expect(notices).toHaveLength(1);
    expect((await nextDay(made.ruleId)).slots.at(-1)?.outcome).toBe('bought');
  });

  it('with max investment blank never closes itself; set, a slot past it completes the rule and buys nothing', async () => {
    await approveBuilder();
    const open = await sign(await create());
    expect(open.maxInvestment).toBeNull();
    for (let i = 0; i < 3; i++) await nextDay(open.ruleId);
    expect((await recurring.get(person, open.ruleId)).status).toBe('active');
    const capped = await sign(await create({ maxInvestment: '15' }));
    const done = await nextDay(capped.ruleId);
    expect(done.status).toBe('completed');
    expect(done.statusReason).toBe('max_investment_reached');
    expect(done.slots.map((s) => s.outcome)).toEqual(['bought', 'skipped_not_permitted']);
  });

  it('terminates: no more slots, each coin converted once as a venue sell under its key; ending again sends nothing', async () => {
    await approveBuilder();
    const made = await sign(await create());
    const ended = await recurring.terminate(person, made.ruleId);
    expect(ended.status).toBe('terminated');
    expect(ended.nextRunAt).toBeNull();
    expect(ended.conversions.map((c) => [c.orderKey, c.status])).toEqual(SYMS.map((s) => [convertOrderKey(made.ruleId, s), 'filled']));
    const usdc = await free('USDC');
    const again = await recurring.terminate(person, made.ruleId);
    expect(again.conversions).toEqual(ended.conversions);
    expect(await free('USDC')).toBe(usdc);
    store.age(made.ruleId, DAY);
    await recurring.tickAll();
    expect((await recurring.get(person, made.ruleId)).slots).toHaveLength(1);
    expect((await refused(recurring.update(person, { ruleId: made.ruleId, amount: '5' }))).code).toBe('trade.recurring_ended');
  });

  it('sends no sell when a frozen person ends the rule: each conversion is recorded refused and the coins stay', async () => {
    await approveBuilder();
    const made = await sign(await create());
    const bases = SYMS.map((s) => s.replace(/-USDC$/, ''));
    const held = await Promise.all(bases.map((b) => free(b)));
    expect(held.every((h) => h > 0n)).toBe(true);
    freeze.frozenUsers.add(person.userId);
    const ended = await recurring.terminate(person, made.ruleId);
    expect(ended.status).toBe('terminated');
    expect(ended.conversions.map((c) => [c.orderKey, c.status])).toEqual(SYMS.map((s) => [convertOrderKey(made.ruleId, s), 'refused']));
    expect(await Promise.all(bases.map((b) => free(b)))).toEqual(held);
    // Lifting the freeze later sends nothing for the refused sells: ending it was once.
    freeze.frozenUsers.clear();
    await recurring.terminate(person, made.ruleId);
    expect(await Promise.all(bases.map((b) => free(b)))).toEqual(held);
  });

  it('shows cost always; value Not set while a coin has no mark, and the profit percentage once every coin has one', async () => {
    await approveBuilder();
    const made = await sign(await create());
    const priced = await recurring.get(person, made.ruleId);
    expect(priced.result.cost).toBe('10');
    // Each coin's mark is the mid of 9.9 and 10: 9.95. Held 0.5, 0.3, 0.2 (fees charged in the base taken off).
    expect(priced.result.value).not.toBeNull();
    expect(priced.result.profitPct).not.toBeNull();
    expect(Number(priced.result.profitPct)).toBeLessThan(0);
    await outsideCancel(maker, SYMS[1]!, `order:maker:${SYMS[1]}:bid`);
    const unpriced = await recurring.get(person, made.ruleId);
    expect(unpriced.result).toEqual({ cost: '10', value: null, profitPct: null });
  });

  it('keeps one order per slot and coin when the same slot is run again after a crash', async () => {
    await approveBuilder();
    const made = await sign(await create());
    const before = (await store.orders(made.ruleId)).map((o) => o.orderKey);
    // A pending slot found on the next pass is run again under the same keys: nothing new is placed.
    await store.setSlotOutcome(made.ruleId, 0, 'pending');
    await recurring.tickAll();
    expect((await store.orders(made.ruleId)).map((o) => o.orderKey)).toEqual(before);
    expect(await free('USDC')).toBe(a('90'));
    expect(formatAmount((await free(made.basket[0]!.baseAsset)) as Amount)).not.toBe('0');
  });
});
