import type http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Principal } from '@intafaced/auth';
import { formatAmount, mul, parseAmount, sub } from '@intafaced/ledger-client/money';
import {
  encodeVenueWire,
  venueClientOrderId,
  VenueRefusalError,
  type PreparedVenueAction,
  type UserVenue,
} from '@intafaced/venue-contracts';
import { breakevenAnswerSchema } from '@intafaced/contracts/trade-venue-door';
import { seedTestVenue, startTestVenueServer, type TestVenueSimulator, type TestVenueTypedData } from '@intafaced/venue-sim';
import { HttpUserVenue } from './http-user-venue.js';
import { InMemoryPreparedActionStore } from './prepared-action-store.js';
import { MemoryFreezeRead } from '../quant/live-run/ports.js';
import { InMemoryEngineProtectionStore } from './protection-store.js';
import { ENGINE_LABEL, ProtectionError, VENUE_LABEL, VenueProtections } from './protections.js';
import { UserVenueDoor } from './user-venue-door.js';
import { listedTestStore } from './venue-listing-store.js';
import { StoreVenueRoutingGate } from './venue-listing.js';

// J-derivatives-03 in svc-trade: a position's protections on the person's own venue account, against the TEST venue
// simulator over HTTP. The venue holds the position; nothing here is posted. Every figure is TEST.

const a = parseAmount;
const ETH = 'ETH-PERP';
const USER = '11111111-1111-4111-8111-11111111d303';
const person = {
  sub: USER,
  userId: USER,
  sid: '33333333-3333-4333-8333-3333333333d3',
  scopes: ['trade:read', 'trade:write'],
  tier: 'basic',
  mfa: false,
  expiresAt: new Date(Date.now() + 600_000),
} as Principal;
const wallet = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet svc-trade protections')));
const owner = wallet.address.toLowerCase();
const BUILDER = '0x00000000000000000000000000000000000000b3';
/** The owner's close tolerance on this TEST stack: 10% (1000 bps), as the owner decided for stop-loss and reduce-only closes. */
const CLOSE_BPS = 1000;
/** The region of the request that arms a stop: one where trading is open. */
const REGION = 'DE';

async function signed(prepared: PreparedVenueAction) {
  const t = prepared.typedData as TestVenueTypedData;
  const signature = await wallet.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
  return { digest: prepared.digest, signature, signedBy: owner };
}

async function refused(p: Promise<unknown>): Promise<ProtectionError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ProtectionError) return err;
    throw err;
  }
  throw new Error('expected a ProtectionError');
}

describe('venue protections (J-derivatives-03)', { timeout: 60_000 }, () => {
  let server: http.Server;
  let sim: TestVenueSimulator;
  let url: string;
  beforeAll(async () => {
    ({ server, sim, url } = await startTestVenueServer({ host: '127.0.0.1', port: 0, appEnv: 'test', chainId: 84532 }));
    await seedTestVenue(sim);
  });
  afterAll(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );

  let door: UserVenueDoor;
  let store: InMemoryEngineProtectionStore;
  let p: VenueProtections;
  let n = 0;
  const id = (tag: string) => `${tag}-${(n += 1)}`;
  /** What identity answers for the person's level now: a level, or a read that fails. */
  let identity: Principal['tier'] | 'unreadable' = 'basic';
  /** The person's own account freeze, as identity answers it. */
  let freeze = new MemoryFreezeRead();
  const liveTier = async () => {
    if (identity === 'unreadable') throw new Error('TEST: identity is down');
    return identity;
  };

  /** Prepare through the door as the person and sign in their wallet. */
  async function send(prepared: { actionKey: string; prepared: PreparedVenueAction }) {
    return door.submit(person, prepared.actionKey, await signed(prepared.prepared));
  }

  /** The person's venue door, on the venue `connect` reaches. */
  function doorOn(connect: () => Promise<UserVenue>) {
    return new UserVenueDoor({
      connect,
      appEnv: 'test',
      store: new InMemoryPreparedActionStore(),
      stepUp: { check: async () => ({ ok: true }) } as never,
      builder: { address: BUILDER, feeBps: a('1') },
      listings: new StoreVenueRoutingGate(listedTestStore([ETH])),
      slippageCapBps: 50,
      closeSlippageBps: CLOSE_BPS,
      ordersPageMax: 100,
      now: () => new Date(),
    } as never);
  }

  beforeEach(async () => {
    sim.setMark(ETH, a('3000'));
    sim.setIndex(ETH, a('3000'));
    await seedTestVenue(sim);
    door = doorOn(() => HttpUserVenue.connect({ baseUrl: url, timeoutMs: 5000 }));
    identity = 'basic';
    freeze = new MemoryFreezeRead();
    store = new InMemoryEngineProtectionStore();
    p = new VenueProtections({
      door,
      store,
      keySeed: 'intafaced unit TEST protection seed',
      closeSlippageBps: CLOSE_BPS,
      liveTier,
      freeze,
      now: () => new Date(),
    });
  });

  /** A TEST long of `size` ETH on the person's venue account: funded, 5x, our builder fee approved, bought at market. */
  async function long(size: string) {
    const entryKey = `order:${owner}:${id('open')}`;
    const account = await door.account(owner);
    sim.deposit(account, 'USDC', a('100000'), `chain:protections:${id('d')}`);
    const lev = await door.prepare(person, {
      owner,
      signer: { role: 'owner', address: owner },
      intent: { kind: 'update_leverage', symbol: ETH, leverageBps: 50_000, marginMode: 'isolated' },
      actionKey: `leverage:${owner}:${id('lev')}`,
    });
    await send(lev);
    const fee = await door.prepare(person, {
      owner,
      signer: { role: 'owner', address: owner },
      intent: { kind: 'approve_builder_fee', builder: BUILDER, maxFeeBps: a('5') },
      actionKey: `builder-fee:${owner}:${id('fee')}`,
    });
    await send(fee);
    const opened = await door.prepare(person, {
      owner,
      signer: { role: 'owner', address: owner },
      intent: {
        kind: 'place_order',
        symbol: ETH,
        side: 'buy',
        type: 'market',
        amount: a(size),
        price: a('3100'),
        timeInForce: 'IOC',
        reduceOnly: false,
        clientOrderKey: entryKey,
        builderFee: null,
      },
    });
    expect((await send(opened)).outcome).toMatchObject({ definite: true, accepted: true });
    return entryKey;
  }

  /** A TEST short of `size` ETH on the person's venue account: as `long`, sold at market. */
  async function short(size: string) {
    const account = await door.account(owner);
    sim.deposit(account, 'USDC', a('100000'), `chain:protections:${id('d')}`);
    const lev = await door.prepare(person, {
      owner,
      signer: { role: 'owner', address: owner },
      intent: { kind: 'update_leverage', symbol: ETH, leverageBps: 50_000, marginMode: 'isolated' },
      actionKey: `leverage:${owner}:${id('lev')}`,
    });
    await send(lev);
    const fee = await door.prepare(person, {
      owner,
      signer: { role: 'owner', address: owner },
      intent: { kind: 'approve_builder_fee', builder: BUILDER, maxFeeBps: a('5') },
      actionKey: `builder-fee:${owner}:${id('fee')}`,
    });
    await send(fee);
    const opened = await door.prepare(person, {
      owner,
      signer: { role: 'owner', address: owner },
      intent: {
        kind: 'place_order',
        symbol: ETH,
        side: 'sell',
        type: 'market',
        amount: a(size),
        price: a('2900'),
        timeInForce: 'IOC',
        reduceOnly: false,
        clientOrderKey: `order:${owner}:${id('open')}`,
        builderFee: null,
      },
    });
    expect((await send(opened)).outcome).toMatchObject({ definite: true, accepted: true });
  }

  async function flat() {
    const account = await door.account(owner);
    const pos = (await sim.positions(account)).value.find((x) => x.symbol === ETH);
    if (!pos) return;
    const close = await door.prepare(person, {
      owner,
      signer: { role: 'owner', address: owner },
      intent: {
        kind: 'place_order',
        symbol: ETH,
        side: pos.side === 'long' ? 'sell' : 'buy',
        type: 'market',
        amount: pos.size,
        price: pos.side === 'long' ? a('2000') : a('4000'),
        timeInForce: 'IOC',
        reduceOnly: true,
        clientOrderKey: `order:${owner}:${id('flat')}`,
        builderFee: null,
      },
    });
    await send(close);
  }

  const base = (over: Record<string, unknown>) => ({
    owner,
    symbol: ETH,
    side: 'sell',
    quantity: '1',
    triggerSource: 'mark',
    clientOrderId: id('c'),
    ...over,
  });

  it('a take profit rests on the venue as its trigger order, signed by the wallet, and is listed with the venue order id', async () => {
    await flat();
    await long('1');
    const made = await p.create(person, base({ kind: 'take_profit', triggerPrice: '3100' }), REGION);
    expect(made.restsOn).toBe('venue');
    if (made.restsOn !== 'venue') throw new Error('unreachable');
    expect(made.prepared.intent).toMatchObject({ kind: 'place_order', reduceOnly: true, trigger: { role: 'take_profit', source: 'mark' } });
    expect((await send(made)).outcome).toMatchObject({ accepted: true, order: { status: 'open' } });
    const listed = (await p.list(person, owner)).find((v) => v.actionKey === made.actionKey)!;
    expect(listed).toMatchObject({
      kind: 'take_profit',
      restsOn: 'venue',
      label: VENUE_LABEL,
      status: 'armed',
      quantity: '1',
      triggerPrice: '3100',
    });
    expect(listed.venueOrderId).toMatch(/^sim-/);
  });

  it("on a venue whose trades a session key signs, a stop loss and a take profit are prepared for the person's session key, which signs them with no wallet prompt", async () => {
    await flat();
    await long('1');
    // The person's trading session key, approved on the venue by their wallet (as session-key.ts starts one).
    const session = privateKeyToAccount(keccak256(toHex(`intafaced TEST protections session ${id('k')}`)));
    const agent = session.address.toLowerCase();
    const approve = await door.prepare(person, {
      owner,
      signer: { role: 'owner', address: owner },
      intent: { kind: 'approve_agent', agentAddress: agent, agentName: 'desk', validUntil: null },
      actionKey: `agent-approve:${USER}:${id('a')}`,
    });
    expect((await send(approve)).outcome).toMatchObject({ accepted: true });
    for (const [kind, triggerPrice] of [
      ['stop_loss', '2900'],
      ['take_profit', '3100'],
    ] as const) {
      const made = await p.create(person, base({ kind, triggerPrice, signer: { role: 'agent', address: agent } }), REGION);
      if (made.restsOn !== 'venue') throw new Error(`${kind} rests on the venue`);
      expect(made.prepared.signer).toEqual({ role: 'agent', address: agent });
      const t = made.prepared.typedData as TestVenueTypedData;
      const signature = await session.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
      const sent = await door.submit(person, made.actionKey, { digest: made.prepared.digest, signature, signedBy: agent });
      expect(sent.outcome).toMatchObject({ accepted: true, order: { status: 'open' } });
    }
    // The wallet's own signer stays the default, and a signer that is neither is refused before anything is prepared.
    const plain = await p.create(person, base({ kind: 'stop_loss', triggerPrice: '2800', quantity: '0.5' }), REGION);
    if (plain.restsOn !== 'venue') throw new Error('stop loss rests on the venue');
    expect(plain.prepared.signer).toEqual({ role: 'owner', address: owner });
    expect(
      await refused(
        p.create(person, base({ kind: 'stop_loss', triggerPrice: '2800', signer: { role: 'builder', address: agent } }), REGION),
      ),
    ).toMatchObject({ code: 'trade.protection_request_invalid' });
  });

  it('refuses a take profit on the wrong side of the mark in words, a field a kind does not take, an exit that would enlarge, and more than the position', async () => {
    await flat();
    await long('1');
    const wrong = await refused(p.create(person, base({ kind: 'take_profit', triggerPrice: '2950' }), REGION));
    expect(wrong).toMatchObject({ code: 'trade.protection_wrong_side', status: 400 });
    expect(wrong.message).toBe('That price is on the wrong side of the mark price (now 3000): it must be above it. Nothing was saved.');
    for (const [kind, fields] of [
      ['stop_market', { triggerPrice: '2900', limitPrice: '2890' }],
      ['stop_limit', { triggerPrice: '2900', limitPrice: '2890', trailingDistance: '10' }],
      ['trailing_stop', { trailingDistance: '10', triggerPrice: '2900' }],
      ['take_profit', { triggerPrice: '3100', trailingDistance: '10' }],
    ] as const) {
      expect(await refused(p.create(person, base({ kind, ...fields }), REGION))).toMatchObject({
        code: 'trade.conditional_field_unsupported',
      });
    }
    expect(await refused(p.create(person, base({ kind: 'stop_market', side: 'buy', triggerPrice: '3100' }), REGION))).toMatchObject({
      code: 'trade.conditional_would_increase',
    });
    expect(await refused(p.create(person, base({ kind: 'stop_loss', quantity: '2', triggerPrice: '2900' }), REGION))).toMatchObject({
      code: 'trade.protection_above_position',
    });
    expect(store.rows.size).toBe(0);
  });

  it('a trailing stop needs the agent permission, then runs on our engine; crossed, two workers send it once and it closes the position', async () => {
    await flat();
    await long('1');
    expect(await refused(p.create(person, base({ kind: 'trailing_stop', trailingDistance: '50' }), REGION))).toMatchObject({
      code: 'trade.protection_agent_unapproved',
      status: 409,
    });
    const approval = await p.prepareAgent(person, owner);
    expect((await send(approval)).outcome).toMatchObject({ accepted: true });
    expect(await p.agent(person, owner)).toMatchObject({ approved: true });
    const made = await p.create(person, base({ kind: 'trailing_stop', trailingDistance: '50' }), REGION);
    if (made.restsOn !== 'engine') throw new Error('expected the engine');
    expect(made.protection).toMatchObject({ restsOn: 'engine', label: ENGINE_LABEL, status: 'armed', currentTrigger: '2950' });
    // The mark rises: the trigger trails it.
    sim.setMark(ETH, a('3100'));
    await p.tick();
    expect((await p.list(person, owner)).find((v) => v.id === made.protection.id)).toMatchObject({ currentTrigger: '3050' });
    // The mark falls past it: two workers in the same moment; one claims it, and one order is sent.
    sim.setMark(ETH, a('3040'));
    const other = new VenueProtections({
      door,
      store,
      keySeed: 'intafaced unit TEST protection seed',
      closeSlippageBps: CLOSE_BPS,
      liveTier,
      freeze,
      now: () => new Date(),
    });
    const [x, y] = await Promise.all([p.tick(), other.tick()]);
    expect(x.fired + y.fired).toBe(1);
    const done = (await p.list(person, owner)).find((v) => v.id === made.protection.id)!;
    expect(done).toMatchObject({ status: 'filled' });
    const account = await door.account(owner);
    const cloid = venueClientOrderId(account.venueId, `protection:fire:${owner}:${made.protection.clientOrderId}`);
    expect((await sim.fills(account, new Date(0))).value.filter((f) => f.venueClientOrderId === cloid)).toHaveLength(1);
    expect((await sim.positions(account)).value.find((x2) => x2.symbol === ETH)).toBeUndefined();
    // A later pass sends nothing more.
    await p.tick();
    expect((await sim.fills(account, new Date(0))).value.filter((f) => f.venueClientOrderId === cloid)).toHaveLength(1);
  });

  it("a stop on the index runs on our engine and fires on the venue's index, not its mark", async () => {
    await flat();
    await long('1');
    await send(await p.prepareAgent(person, owner)).catch(() => undefined);
    const made = await p.create(person, base({ kind: 'stop_market', triggerSource: 'index', triggerPrice: '2900' }), REGION);
    if (made.restsOn !== 'engine') throw new Error('expected the engine');
    sim.setMark(ETH, a('2800'));
    await p.tick();
    expect((await store.get(USER, made.protection.id))!.status).toBe('armed');
    sim.setIndex(ETH, a('2890'));
    await p.tick();
    expect((await store.get(USER, made.protection.id))!.status).toBe('fired');
  });

  it('an engine stop whose position is gone is cancelled, not sent', async () => {
    await flat();
    await long('1');
    await send(await p.prepareAgent(person, owner)).catch(() => undefined);
    const made = await p.create(person, base({ kind: 'trailing_stop', trailingDistance: '20' }), REGION);
    if (made.restsOn !== 'engine') throw new Error('expected the engine');
    await flat();
    sim.setMark(ETH, a('2900'));
    await p.tick();
    expect(await store.get(USER, made.protection.id)).toMatchObject({ status: 'cancelled', cancelReason: 'position_closed' });
  });

  it("our engine sends an order only on the person's level as identity holds it now, never one of its own", async () => {
    await flat();
    await long('1');
    await send(await p.prepareAgent(person, owner)).catch(() => undefined);
    // Arming checks the level as the door checks a new order: a person below trading arms nothing.
    const below = { ...person, tier: 'none' } as Principal;
    await expect(p.create(below, base({ kind: 'trailing_stop', trailingDistance: '20' }), REGION)).rejects.toMatchObject({
      code: 'tier.insufficient',
    });
    expect(store.rows.size).toBe(0);
    const account = await door.account(owner);
    const fills = async () => (await sim.fills(account, new Date(0))).value.length;
    // Identity can't be read when it crosses: nothing is sent, the stop stays claimed, and it is sent once identity answers.
    const first = await p.create(person, base({ kind: 'stop_market', triggerSource: 'index', triggerPrice: '2900' }), REGION);
    if (first.restsOn !== 'engine') throw new Error('expected the engine');
    const before = await fills();
    identity = 'unreadable';
    sim.setIndex(ETH, a('2890'));
    await p.tick();
    expect((await store.get(USER, first.protection.id))!.status).toBe('firing');
    expect(await fills()).toBe(before);
    // The person's level has dropped below trading since they armed it: the door refuses, nothing is sent, it fails in words.
    identity = 'none';
    await p.tick();
    const failed = (await store.get(USER, first.protection.id))!;
    expect(failed.status).toBe('failed');
    expect(failed.failure).toMatch(/^your verification level no longer allows an order/);
    expect(await fills()).toBe(before);
    expect((await sim.positions(account)).value.find((x) => x.symbol === ETH)).toMatchObject({ size: a('1') });
    // Back at basic, a new stop fires as before.
    identity = 'basic';
    sim.setIndex(ETH, a('3000'));
    const second = await p.create(person, base({ kind: 'stop_market', triggerSource: 'index', triggerPrice: '2900' }), REGION);
    if (second.restsOn !== 'engine') throw new Error('expected the engine');
    sim.setIndex(ETH, a('2890'));
    await p.tick();
    expect((await store.get(USER, second.protection.id))!.status).toBe('fired');
  });

  it("a frozen account, a freeze that can't be read, or a region where trading has closed: our engine sends nothing", async () => {
    await flat();
    await long('1');
    await send(await p.prepareAgent(person, owner)).catch(() => undefined);
    const account = await door.account(owner);
    const fills = async () => (await sim.fills(account, new Date(0))).value.length;
    const before = await fills();
    const stop = await p.create(person, base({ kind: 'stop_market', triggerSource: 'index', triggerPrice: '2900' }), REGION);
    if (stop.restsOn !== 'engine') throw new Error('expected the engine');
    // The freeze can't be read when it crosses: nothing is sent, and the stop stays claimed.
    freeze.down = true;
    sim.setIndex(ETH, a('2890'));
    await p.tick();
    expect((await store.get(USER, stop.protection.id))!.status).toBe('firing');
    expect(await fills()).toBe(before);
    // The person has frozen their own account: nothing is sent, and the stop fails saying so.
    freeze.down = false;
    freeze.frozenUsers.add(USER);
    await p.tick();
    expect(await store.get(USER, stop.protection.id)).toMatchObject({
      status: 'failed',
      failure: 'your account is frozen, so our engine sent no order and nothing was closed',
    });
    expect(await fills()).toBe(before);
    // Failed before any order was prepared, it is still listed with its words, and the list of the account still reads.
    expect((await p.list(person, owner)).find((x) => x.id === stop.protection.id)).toMatchObject({
      status: 'failed',
      failure: 'your account is frozen, so our engine sent no order and nothing was closed',
    });
    // Only "no order under that key" reads as no order: any other failure reading the order still fails the list.
    const spy = vi.spyOn(door, 'orderByKey').mockRejectedValueOnce(new Error('TEST: the order store is down'));
    await expect(p.list(person, owner)).rejects.toThrow('TEST: the order store is down');
    spy.mockRestore();
    // Armed from a region where trading is closed (recorded at arming, KP): checked again before sending, nothing is sent.
    freeze.frozenUsers.clear();
    sim.setIndex(ETH, a('3000'));
    const closed = await p.create(person, base({ kind: 'stop_market', triggerSource: 'index', triggerPrice: '2900' }), 'KP');
    if (closed.restsOn !== 'engine') throw new Error('expected the engine');
    sim.setIndex(ETH, a('2890'));
    await p.tick();
    const failed = (await store.get(USER, closed.protection.id))!;
    expect(failed.status).toBe('failed');
    expect(failed.failure).toMatch(/^trading is no longer allowed for this account/);
    expect((await p.list(person, owner)).find((x) => x.id === closed.protection.id)).toMatchObject({ status: 'failed' });
    expect(await fills()).toBe(before);
    expect((await sim.positions(account)).value.find((x) => x.symbol === ETH)).toMatchObject({ size: a('1') });
  });

  // A stop's market exit and a desk's reduce-only close cross by the owner's close tolerance, 10% on this stack
  // (TRADE_CLOSE_SLIPPAGE_BPS), never a figure of their own.
  it("a long's stop loss rests on the venue at 10% below its trigger, a short's at 10% above", async () => {
    await flat();
    await long('1');
    const sell = await p.create(person, base({ kind: 'stop_loss', triggerPrice: '2900' }), REGION);
    if (sell.restsOn !== 'venue') throw new Error('expected the venue');
    expect(sell.prepared.intent).toMatchObject({ side: 'sell', type: 'market', reduceOnly: true, price: a('2610') });
    await flat();
    await short('1');
    const buy = await p.create(person, base({ kind: 'stop_loss', side: 'buy', triggerPrice: '3100' }), REGION);
    if (buy.restsOn !== 'venue') throw new Error('expected the venue');
    expect(buy.prepared.intent).toMatchObject({ side: 'buy', type: 'market', reduceOnly: true, price: a('3410') });
    await flat();
  });

  it('an engine stop fires its market exit 10% past the mark it crossed at', async () => {
    await flat();
    await long('1');
    await send(await p.prepareAgent(person, owner)).catch(() => undefined);
    const made = await p.create(person, base({ kind: 'stop_market', triggerSource: 'index', triggerPrice: '2900' }), REGION);
    if (made.restsOn !== 'engine') throw new Error('expected the engine');
    const prepared = vi.spyOn(door, 'prepare');
    sim.setMark(ETH, a('2800'));
    sim.setIndex(ETH, a('2890'));
    await p.tick();
    const sent = prepared.mock.calls.map(([, input]) => input.intent).find((i) => i.kind === 'place_order');
    prepared.mockRestore();
    expect(sent).toMatchObject({ side: 'sell', type: 'market', reduceOnly: true, price: a('2520') });
    await flat();
  });

  it('with the close tolerance blank, no stop is armed and no reduce-only close is prepared: refused by name', async () => {
    await flat();
    await long('1');
    const blank = new VenueProtections({
      door,
      store,
      keySeed: 'intafaced unit TEST protection seed',
      closeSlippageBps: null,
      liveTier,
      freeze,
      now: () => new Date(),
    });
    await expect(blank.create(person, base({ kind: 'stop_loss', triggerPrice: '2900' }), REGION)).rejects.toMatchObject({
      code: 'trade.close_slippage_unset',
    });
    expect(store.rows.size).toBe(0);
    const blankDoor = new UserVenueDoor({
      connect: () => HttpUserVenue.connect({ baseUrl: url, timeoutMs: 5000 }),
      appEnv: 'test',
      store: new InMemoryPreparedActionStore(),
      stepUp: { check: async () => ({ ok: true }) } as never,
      builder: { address: BUILDER, feeBps: a('1') },
      listings: new StoreVenueRoutingGate(listedTestStore([ETH])),
      slippageCapBps: 50,
      closeSlippageBps: null,
      ordersPageMax: 100,
      now: () => new Date(),
    } as never);
    expect(await blankDoor.status()).toMatchObject({ closeSlippageBps: null });
    expect(await door.status()).toMatchObject({ closeSlippageBps: CLOSE_BPS });
    for (const type of ['market', 'limit'] as const) {
      await expect(
        blankDoor.prepare(person, {
          owner,
          signer: { role: 'owner', address: owner },
          intent: {
            kind: 'place_order',
            symbol: ETH,
            side: 'sell',
            type,
            amount: a('1'),
            price: a('2700'),
            timeInForce: 'IOC',
            reduceOnly: true,
            clientOrderKey: `order:${owner}:${id('blank')}`,
            builderFee: null,
          },
        }),
      ).rejects.toMatchObject({ code: 'trade.close_slippage_unset' });
    }
    await flat();
  });

  it('#11070: one press moves the stop to the fee-adjusted breakeven, and the venue then holds exactly one reduce-only stop there', async () => {
    await flat();
    const account = await door.account(owner);
    const fees = (await sim.markets(account)).value.find((m) => m.symbol === ETH)!;
    // TEST rates: the venue charges 4.5 bps to a taker; our builder fee on this TEST door is 1 bp.
    sim.setMarketFees(ETH, { makerFeeBps: { known: true, value: a('1.5') }, takerFeeBps: { known: true, value: a('4.5') } });
    try {
      const openedFrom = new Date(Date.now() - 1);
      await long('2');
      // Refused while the mark is under breakeven: the stop would fire at once.
      await expect(p.breakeven(person, { owner, symbol: ETH, clientOrderId: id('be') })).rejects.toMatchObject({
        code: 'trade.protection_wrong_side',
      });
      sim.setMark(ETH, a('3200'));
      // A stop loss already rests from before.
      const before = await p.create(person, base({ kind: 'stop_loss', quantity: '2', triggerPrice: '2900' }), REGION);
      if (before.restsOn !== 'venue') throw new Error('expected the venue');
      expect((await send(before)).outcome).toMatchObject({ accepted: true });

      // One press: the old stop's cancel first (the venue holds one whole stop at a time), then, called again, the new one.
      const clientOrderId = id('be');
      const first = await p.breakeven(person, { owner, symbol: ETH, clientOrderId });
      expect(first.steps.map((s) => s.does)).toEqual(['cancel_stop']);
      expect(first.replaces).toEqual([before.prepared.venueClientOrderId!.toLowerCase()]);
      expect(first.next).toBe('call_again');
      for (const step of first.steps) expect((await send(step)).outcome).toMatchObject({ definite: true, accepted: true });
      const press = await p.breakeven(person, { owner, symbol: ETH, clientOrderId });
      expect(press.triggerPrice).toBe(first.triggerPrice);
      expect(press.steps.map((s) => s.does)).toEqual(['place_stop']);
      expect(press.next).toBe('done');
      // The answer on the wire is the shared contract's.
      for (const answer of [first, press]) expect(breakevenAnswerSchema.safeParse(encodeVenueWire(answer)).success).toBe(true);
      expect(press.steps[0]!.prepared.intent).toMatchObject({
        kind: 'place_order',
        side: 'sell',
        amount: a('2'),
        reduceOnly: true,
        trigger: { price: a(press.triggerPrice), source: 'mark', role: 'stop_loss' },
      });

      // Worked here from the venue's own records, not from the service: closing the whole position at the trigger nets
      // zero or more after every fee, and one tick lower nets less than zero.
      const position = (await sim.positions(account)).value.find((x) => x.symbol === ETH)!;
      const paid = (await sim.fills(account, openedFrom)).value
        .filter((f) => f.symbol === ETH)
        .reduce((sum, f) => sum + f.venueFee + f.builderFee, 0n);
      expect(press.openingFees).toBe(formatAmount(paid));
      expect(press.closeFeeBps).toBe('5.5');
      const nets = (price: bigint) =>
        mul(sub(price, position.entryPrice), position.size) - paid - mul(mul(price, position.size), a('0.00055'));
      expect(nets(a(press.triggerPrice)) >= 0n).toBe(true);
      expect(nets(a(press.triggerPrice) - fees.tickSize) < 0n).toBe(true);

      for (const step of press.steps) expect((await send(step)).outcome).toMatchObject({ definite: true, accepted: true });
      const resting = (await sim.openOrders(account)).value.filter((o) => o.symbol === ETH && o.trigger);
      expect(resting).toHaveLength(1);
      expect(resting[0]).toMatchObject({
        side: 'sell',
        reduceOnly: true,
        amount: a('2'),
        trigger: { price: a(press.triggerPrice), role: 'stop_loss' },
      });

      // Pressed again: it already rests there alone, so nothing is prepared.
      const again = await p.breakeven(person, { owner, symbol: ETH, clientOrderId: id('be') });
      expect(again.steps).toEqual([]);
      expect(again.triggerPrice).toBe(press.triggerPrice);
    } finally {
      sim.setMarketFees(ETH, { makerFeeBps: fees.makerFeeBps, takerFeeBps: fees.takerFeeBps });
      sim.setMark(ETH, a('3000'));
      await flat();
    }
  });

  it('#11070: refused in words with no position, or with a fee the venue does not report', async () => {
    await flat();
    expect((await refused(p.breakeven(person, { owner, symbol: ETH, clientOrderId: id('be') }))).code).toBe('trade.breakeven_no_position');
    const account = await door.account(owner);
    const fees = (await sim.markets(account)).value.find((m) => m.symbol === ETH)!;
    sim.setMarketFees(ETH, { makerFeeBps: { known: false }, takerFeeBps: { known: false } });
    try {
      await long('1');
      expect((await refused(p.breakeven(person, { owner, symbol: ETH, clientOrderId: id('be') }))).code).toBe(
        'trade.breakeven_fees_unknown',
      );
    } finally {
      sim.setMarketFees(ETH, { makerFeeBps: fees.makerFeeBps, takerFeeBps: fees.takerFeeBps });
      await flat();
    }
  });

  it('#11089: an approval the venue refused (agent_removal_pending) is prepared and sent again under a new key; an accepted one never twice', async () => {
    // The venue still holds an ended agent's removal for the next `pending` approvals it is sent, as Hyperliquid does.
    let pending = 6;
    const sends: string[] = [];
    const held = new UserVenueDoor({
      connect: async () => {
        const inner = await HttpUserVenue.connect({ baseUrl: url, timeoutMs: 5000 });
        return new Proxy(inner, {
          get(target, prop, receiver) {
            const v = Reflect.get(target, prop, receiver) as unknown;
            if (prop !== 'submit') return typeof v === 'function' ? (v as (...args: unknown[]) => unknown).bind(target) : v;
            return async (prepared: PreparedVenueAction, signature: Parameters<HttpUserVenue['submit']>[1]) => {
              if (prepared.intent.kind === 'approve_agent') sends.push(prepared.digest);
              if (prepared.intent.kind === 'approve_agent' && pending > 0) {
                pending -= 1;
                return {
                  definite: true as const,
                  accepted: false as const,
                  refusal: { venueId: inner.venue.id, code: 'agent_removal_pending' as const, detail: 'User has pending agent removal' },
                  asOf: new Date(),
                };
              }
              return target.submit(prepared, signature);
            };
          },
        });
      },
      appEnv: 'test',
      store: new InMemoryPreparedActionStore(),
      stepUp: { check: async () => ({ ok: true }) } as never,
      builder: { address: BUILDER, feeBps: a('1') },
      listings: new StoreVenueRoutingGate(listedTestStore([ETH])),
      slippageCapBps: 50,
      closeSlippageBps: CLOSE_BPS,
      ordersPageMax: 100,
      now: () => new Date(),
      wait: async () => undefined,
    } as never);
    const q = new VenueProtections({
      door: held,
      store: new InMemoryEngineProtectionStore(),
      keySeed: 'intafaced unit TEST protection seed #11089',
      closeSlippageBps: CLOSE_BPS,
      liveTier,
      freeze,
      now: () => new Date(),
    });
    const sendHeld = async (x: { actionKey: string; prepared: PreparedVenueAction }) =>
      held.submit(person, x.actionKey, await signed(x.prepared));
    // The first approval and its four resends are all refused: the refusal stands, nothing is approved.
    const first = await q.prepareAgent(person, owner);
    expect((await sendHeld(first)).outcome).toMatchObject({ definite: true, accepted: false, refusal: { code: 'agent_removal_pending' } });
    expect(sends).toHaveLength(5);
    expect(await q.agent(person, owner)).toMatchObject({ approved: false });
    // Only the same approval's next try is waived: the refused key under any other business key is still refused.
    await expect(
      held.prepare(person, {
        owner,
        signer: { role: 'owner', address: owner },
        intent: {
          kind: 'approve_agent',
          agentAddress: q.protectionKey(USER, owner).address.toLowerCase(),
          agentName: 'other',
          validUntil: null,
        },
        actionKey: `other-agent:${owner}:11089`,
      }),
    ).rejects.toMatchObject({ code: 'trade.venue_session_key_reused' });
    // Approve again: a new key and new bytes, sent to the venue again, never the stored refusal replayed.
    const second = await q.prepareAgent(person, owner);
    expect(second.actionKey).not.toBe(first.actionKey);
    expect(second.reused).toBe(false);
    expect(second.prepared.digest).not.toBe(first.prepared.digest);
    const answered = await sendHeld(second);
    expect(answered).toMatchObject({ replayed: false, outcome: { definite: true, accepted: true } });
    expect(sends).toHaveLength(7);
    expect(sends[6]).toBe(second.prepared.digest);
    expect(await q.agent(person, owner)).toMatchObject({ approved: true });
    // Accepted: Approve again is that same stored approval, and sending it again sends nothing to the venue.
    const third = await q.prepareAgent(person, owner);
    expect(third).toMatchObject({ actionKey: second.actionKey, reused: true, signed: true });
    expect(await sendHeld(third)).toMatchObject({ replayed: true, outcome: { accepted: true } });
    expect(sends).toHaveLength(7);
    // The first, refused key still answers its own refusal: it is never sent again either.
    expect(await sendHeld(first)).toMatchObject({ replayed: true, outcome: { accepted: false } });
    expect(sends).toHaveLength(7);
  });

  /**
   * A venue that links no exit to an entry order, as Hyperliquid's adapter today (packages/venue-hyperliquid venue.ts
   * `orderWire`: an intent with `parentClientOrderKey` is refused `not_offered`, its markets offer no `attachedExits`).
   */
  async function likeHyperliquid(): Promise<UserVenue> {
    const venue = await HttpUserVenue.connect({ baseUrl: url, timeoutMs: 5000 });
    return new Proxy(venue, {
      get(target, key) {
        if (key === 'markets')
          return async (account: Parameters<UserVenue['markets']>[0]) => {
            const read = await target.markets(account);
            return { ...read, value: read.value.map((m) => ({ ...m, attachedExits: false })) };
          };
        if (key === 'prepare')
          return async (...args: Parameters<UserVenue['prepare']>) => {
            const intent = args[2];
            if (intent.kind === 'place_order' && intent.parentClientOrderKey)
              throw new VenueRefusalError({
                venueId: target.venue.id,
                code: 'not_offered',
                detail: 'an order attached to an entry is not offered on this venue yet',
              });
            return target.prepare(...args);
          };
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
  }

  function onVenueLikeHyperliquid() {
    door = doorOn(likeHyperliquid);
    p = new VenueProtections({
      door,
      store,
      keySeed: 'intafaced unit TEST protection seed',
      closeSlippageBps: CLOSE_BPS,
      liveTier,
      freeze,
      now: () => new Date(),
    });
  }

  it("J-derivatives-03 #4 on a venue that links no exit to an entry (#11255): the ticket's take profit and stop loss, attached once the entry filled, rest as reduce-only triggers on the filled size", async () => {
    onVenueLikeHyperliquid();
    await flat();
    const entry = await long('0.5');
    for (const [kind, triggerPrice] of [
      ['take_profit', '3200'],
      ['stop_loss', '2850'],
    ] as const) {
      const made = await p.create(person, base({ kind, triggerPrice, quantity: '0.5', attachTo: entry }), REGION);
      if (made.restsOn !== 'venue') throw new Error(`${kind} rests on the venue`);
      expect(made.prepared.intent).toMatchObject({ kind: 'place_order', reduceOnly: true, side: 'sell', trigger: { role: kind } });
      expect((made.prepared.intent as { parentClientOrderKey?: string | null }).parentClientOrderKey ?? null).toBeNull();
      expect((await send(made)).outcome).toMatchObject({ accepted: true, order: { status: 'open' } });
    }
    const armed = (await p.list(person, owner)).filter((v) => v.restsOn === 'venue' && v.status === 'armed');
    expect(armed.map((v) => [v.kind, v.triggerPrice, v.quantity]).sort()).toEqual([
      ['stop_loss', '2850', '0.5'],
      ['take_profit', '3200', '0.5'],
    ]);
  });

  it('J-derivatives-03 #4 on a venue that links no exit to an entry: an exit attached to an entry that filled nothing, or larger than its fill, is refused, nothing prepared', async () => {
    onVenueLikeHyperliquid();
    await flat();
    await long('0.5');
    const filled = await long('0.2');
    const over = await refused(
      p.create(person, base({ kind: 'stop_loss', triggerPrice: '2850', quantity: '0.3', attachTo: filled }), REGION),
    );
    expect(over.code).toBe('trade.protection_above_entry_fill');
    // A resting limit entry that has filled nothing: its exit would arm on nothing.
    const resting = `order:${owner}:${id('rest')}`;
    const placed = await door.prepare(person, {
      owner,
      signer: { role: 'owner', address: owner },
      intent: {
        kind: 'place_order',
        symbol: ETH,
        side: 'buy',
        type: 'limit',
        amount: a('0.5'),
        price: a('2500'),
        timeInForce: 'GTC',
        reduceOnly: false,
        clientOrderKey: resting,
        builderFee: null,
      },
    });
    expect((await send(placed)).outcome).toMatchObject({ accepted: true, order: { status: 'open' } });
    const none = await refused(
      p.create(person, base({ kind: 'take_profit', triggerPrice: '3200', quantity: '0.5', attachTo: resting }), REGION),
    );
    expect(none.code).toBe('trade.attached_entry_unfilled');
    const unknown = await refused(
      p.create(person, base({ kind: 'take_profit', triggerPrice: '3200', quantity: '0.5', attachTo: `order:${owner}:never-sent` }), REGION),
    );
    expect(unknown.code).toBe('trade.attached_entry_unfilled');
  });
});
