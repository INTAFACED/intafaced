import type http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { Principal } from '@intafaced/auth';
import { parseAmount } from '@intafaced/ledger-client/money';
import { venueClientOrderId, type PreparedVenueAction } from '@intafaced/venue-contracts';
import { seedTestVenue, startTestVenueServer, type TestVenueSimulator, type TestVenueTypedData } from '@intafaced/venue-sim';
import { HttpUserVenue } from './http-user-venue.js';
import { InMemoryPreparedActionStore } from './prepared-action-store.js';
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
} as unknown as Principal;
const wallet = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet svc-trade protections')));
const owner = wallet.address.toLowerCase();
const BUILDER = '0x00000000000000000000000000000000000000b3';

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

  /** Prepare through the door as the person and sign in their wallet. */
  async function send(prepared: { actionKey: string; prepared: PreparedVenueAction }) {
    return door.submit(person, prepared.actionKey, await signed(prepared.prepared));
  }

  beforeEach(async () => {
    sim.setMark(ETH, a('3000'));
    sim.setIndex(ETH, a('3000'));
    await seedTestVenue(sim);
    door = new UserVenueDoor({
      connect: () => HttpUserVenue.connect({ baseUrl: url, timeoutMs: 5000 }),
      appEnv: 'test',
      store: new InMemoryPreparedActionStore(),
      stepUp: { check: async () => ({ ok: true }) } as never,
      builder: { address: BUILDER, feeBps: a('1') },
      listings: new StoreVenueRoutingGate(listedTestStore([ETH])),
      ordersPageMax: 100,
      now: () => new Date(),
    } as never);
    store = new InMemoryEngineProtectionStore();
    p = new VenueProtections({ door, store, keySeed: 'intafaced unit TEST protection seed', now: () => new Date() });
  });

  /** A TEST long of `size` ETH on the person's venue account: funded, 5x, our builder fee approved, bought at market. */
  async function long(size: string) {
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
    const made = await p.create(person, base({ kind: 'take_profit', triggerPrice: '3100' }));
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

  it('refuses a take profit on the wrong side of the mark in words, a field a kind does not take, an exit that would enlarge, and more than the position', async () => {
    await flat();
    await long('1');
    const wrong = await refused(p.create(person, base({ kind: 'take_profit', triggerPrice: '2950' })));
    expect(wrong).toMatchObject({ code: 'trade.protection_wrong_side', status: 400 });
    expect(wrong.message).toBe('That price is on the wrong side of the mark price (now 3000): it must be above it. Nothing was saved.');
    for (const [kind, fields] of [
      ['stop_market', { triggerPrice: '2900', limitPrice: '2890' }],
      ['stop_limit', { triggerPrice: '2900', limitPrice: '2890', trailingDistance: '10' }],
      ['trailing_stop', { trailingDistance: '10', triggerPrice: '2900' }],
      ['take_profit', { triggerPrice: '3100', trailingDistance: '10' }],
    ] as const) {
      expect(await refused(p.create(person, base({ kind, ...fields })))).toMatchObject({ code: 'trade.conditional_field_unsupported' });
    }
    expect(await refused(p.create(person, base({ kind: 'stop_market', side: 'buy', triggerPrice: '3100' })))).toMatchObject({
      code: 'trade.conditional_would_increase',
    });
    expect(await refused(p.create(person, base({ kind: 'stop_loss', quantity: '2', triggerPrice: '2900' })))).toMatchObject({
      code: 'trade.protection_above_position',
    });
    expect(store.rows.size).toBe(0);
  });

  it('a trailing stop needs the agent permission, then runs on our engine; crossed, two workers send it once and it closes the position', async () => {
    await flat();
    await long('1');
    expect(await refused(p.create(person, base({ kind: 'trailing_stop', trailingDistance: '50' })))).toMatchObject({
      code: 'trade.protection_agent_unapproved',
      status: 409,
    });
    const approval = await p.prepareAgent(person, owner);
    expect((await send(approval)).outcome).toMatchObject({ accepted: true });
    expect(await p.agent(person, owner)).toMatchObject({ approved: true });
    const made = await p.create(person, base({ kind: 'trailing_stop', trailingDistance: '50' }));
    if (made.restsOn !== 'engine') throw new Error('expected the engine');
    expect(made.protection).toMatchObject({ restsOn: 'engine', label: ENGINE_LABEL, status: 'armed', currentTrigger: '2950' });
    // The mark rises: the trigger trails it.
    sim.setMark(ETH, a('3100'));
    await p.tick();
    expect((await p.list(person, owner)).find((v) => v.id === made.protection.id)).toMatchObject({ currentTrigger: '3050' });
    // The mark falls past it: two workers in the same moment; one claims it, and one order is sent.
    sim.setMark(ETH, a('3040'));
    const other = new VenueProtections({ door, store, keySeed: 'intafaced unit TEST protection seed', now: () => new Date() });
    const [x, y] = await Promise.all([p.tick(), other.tick()]);
    expect(x.fired + y.fired).toBe(1);
    const done = (await p.list(person, owner)).find((v) => v.id === made.protection.id)!;
    expect(done).toMatchObject({ status: 'filled' });
    const account = await door.account(owner);
    const cloid = venueClientOrderId(account.venueId, `protection:fire:${made.protection.id}`);
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
    const made = await p.create(person, base({ kind: 'stop_market', triggerSource: 'index', triggerPrice: '2900' }));
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
    const made = await p.create(person, base({ kind: 'trailing_stop', trailingDistance: '20' }));
    if (made.restsOn !== 'engine') throw new Error('expected the engine');
    await flat();
    sim.setMark(ETH, a('2900'));
    await p.tick();
    expect(await store.get(USER, made.protection.id)).toMatchObject({ status: 'cancelled', cancelReason: 'position_closed' });
  });
});
