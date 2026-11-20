import type http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { keccak256, toHex, type TypedDataDefinition } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { Principal } from '@intafaced/auth';
import { formatAmount, parseAmount } from '@intafaced/ledger-client/money';
import type { PlaceUserOrderIntent, PreparedVenueAction, UserVenueAccount } from '@intafaced/venue-contracts';
import { seedTestVenue, startTestVenueServer, type TestVenueSimulator } from '@intafaced/venue-sim';
import { HttpUserVenue } from './http-user-venue.js';
import { InMemoryPreparedActionStore } from './prepared-action-store.js';
import { MemoryFreezeRead } from '../quant/live-run/ports.js';
import { InMemorySpotConditionalStore } from './spot-conditional-store.js';
import { SPOT_ENGINE_LABEL, SpotConditionalError, VenueSpotConditionals, spotKeys, spotStopRestsOn } from './spot-conditionals.js';
import { UserVenueDoor } from './user-venue-door.js';
import { MemoryVenueListingStore } from './venue-listing-store.js';
import { StoreVenueRoutingGate } from './venue-listing.js';

// J-cex-spot-08 in svc-trade: conditional spot orders on the person's own venue account, against the TEST venue simulator
// over HTTP. The venue holds the funds and the locks; nothing here is posted. Every figure is TEST. Each test lists a
// TEST spot market of its own, so its book and its last trade are only what the test puts there.

const a = parseAmount;
const f = formatAmount;
const USER = '11111111-1111-4111-8111-11111111c508';
const person = {
  sub: USER,
  userId: USER,
  sid: '33333333-3333-4333-8333-3333333333c8',
  scopes: ['trade:read', 'trade:write'],
  tier: 'basic',
  mfa: false,
  expiresAt: new Date(Date.now() + 600_000),
} as Principal;
const wallet = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet svc-trade spot conditionals')));
const owner = wallet.address.toLowerCase();
const BUILDER = '0x00000000000000000000000000000000000000b3';
const REGION = 'DE';
const SEED = 'intafaced unit TEST spot conditional seed';
const trader = (name: string) => privateKeyToAccount(keccak256(toHex(`intafaced TEST spot conditional trader ${name}`)));

async function refused(p: Promise<unknown>): Promise<SpotConditionalError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof SpotConditionalError) return err;
    throw err;
  }
  throw new Error('expected a SpotConditionalError');
}

describe('conditional spot orders on the venue (J-cex-spot-08)', { timeout: 60_000 }, () => {
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

  let door: UserVenueDoor;
  let listings: MemoryVenueListingStore;
  let store: InMemorySpotConditionalStore;
  let s: VenueSpotConditionals;
  let freeze: MemoryFreezeRead;
  let n = 0;
  const id = (tag: string) => `${tag}-${(n += 1)}`;
  let SYM = '';
  let BASE = '';
  const engine = () =>
    new VenueSpotConditionals({ door, store, keySeed: SEED, liveTier: async () => 'basic', freeze, now: () => new Date() });

  const account = (who = owner): UserVenueAccount => ({ venueId, owner: who, subAccount: null });
  const balance = async (asset: string, who = owner) =>
    (await sim.balances(account(who))).value.find((b) => b.asset === asset) ?? { free: a('0'), locked: a('0') };
  const order = async (key: string) => (await door.orderByKey(person, key)).order;
  const fillsOf = async (cloid: string | null) =>
    (await sim.fills(account(), new Date(0))).value.filter((x) => x.venueClientOrderId === cloid);

  /** The person's wallet signs and the door sends. */
  async function signAndSend(prepared: { actionKey: string; prepared: PreparedVenueAction }) {
    const t = prepared.prepared.typedData as TypedDataDefinition;
    const signature = await wallet.signTypedData(t);
    return door.submit(person, prepared.actionKey, { digest: prepared.prepared.digest, signature, signedBy: owner });
  }

  /** Another TEST trader acts on the venue directly with their own key (no builder fee: they are not our customer). */
  async function outside(
    key: PrivateKeyAccount,
    intent: Omit<PlaceUserOrderIntent, 'kind' | 'builderFee' | 'reduceOnly' | 'clientOrderKey'>,
  ) {
    const who = key.address.toLowerCase();
    const prepared = await sim.prepare(
      account(who),
      { role: 'owner', address: who },
      {
        kind: 'place_order',
        reduceOnly: false,
        builderFee: null,
        clientOrderKey: `order:${who}:${id('o')}`,
        ...intent,
      },
    );
    const signature = await key.signTypedData(prepared.typedData as TypedDataDefinition);
    return sim.submit(prepared, { digest: prepared.digest, signature, signedBy: who });
  }

  const seller = trader('seller');
  const buyer = trader('buyer');
  /** One TEST print at `price`: the last trade a stop here is judged on. */
  async function printAt(price: string) {
    await outside(seller, { symbol: SYM, side: 'sell', type: 'limit', amount: a('0.1'), price: a(price), timeInForce: 'GTC' });
    await outside(buyer, { symbol: SYM, side: 'buy', type: 'limit', amount: a('0.1'), price: a(price), timeInForce: 'IOC' });
  }

  beforeEach(async () => {
    BASE = `SC${(n += 1)}X`;
    SYM = `${BASE}-USDC`;
    const added = await fetch(`${url}/test/market-add`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ symbol: SYM, baseAsset: BASE, quoteAsset: 'USDC', maxOrderQty: null, maxOrderNotional: null }),
    });
    expect(added.status).toBe(200);
    listings = new MemoryVenueListingStore();
    await listings.appendListing({
      venueId,
      symbol: SYM,
      version: 1,
      change: 'listing',
      opensAt: new Date('2026-01-01T00:00:00.000Z'),
      delistsAt: null,
      routing: 'show',
      approvalId: `test-stack-listing:${venueId}:${SYM}`,
      proposerId: 'TEST fixture',
      approverId: 'TEST fixture approval',
      executorId: 'TEST fixture',
      reason: 'TEST fixture listing',
      recordedAt: new Date('2026-01-01T00:00:00.000Z'),
    });
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
    freeze = new MemoryFreezeRead();
    store = new InMemorySpotConditionalStore();
    s = engine();
    for (const [who, asset] of [
      [owner, BASE],
      [owner, 'USDC'],
      [seller.address.toLowerCase(), BASE],
      [buyer.address.toLowerCase(), 'USDC'],
    ] as const)
      sim.deposit(account(who), asset, a(asset === 'USDC' ? '100000' : '10'), `chain:spot-cond:${id('d')}`);
    // The person approves our builder fee (a spot sell carries it) and, once, the spot-order key.
    await signAndSend(
      await door.prepare(person, {
        owner,
        signer: { role: 'owner', address: owner },
        intent: { kind: 'approve_builder_fee', builder: BUILDER, maxFeeBps: a('5') },
        actionKey: `builder-fee:${owner}:${id('fee')}`,
      }),
    );
    await printAt('100');
  });

  async function approveAgent() {
    if ((await s.agent(person, owner)).approved) return;
    expect((await signAndSend(await s.prepareAgent(person, owner))).outcome).toMatchObject({ accepted: true });
  }

  const req = (over: Record<string, unknown>) => ({ owner, symbol: SYM, side: 'sell', quantity: '1', clientOrderId: id('c'), ...over });

  it('reads whether the venue holds a stop on spot from the market’s own declaration', () => {
    expect(spotStopRestsOn({ kind: 'spot', triggerSources: [] })).toBe('engine');
    expect(spotStopRestsOn({ kind: 'spot', triggerSources: undefined })).toBe('engine');
    expect(spotStopRestsOn({ kind: 'spot', triggerSources: ['last'] })).toBe('venue');
    expect(spotStopRestsOn({ kind: 'perpetual', triggerSources: ['last'] })).toBe('engine');
  });

  it('a stop-limit needs the agent permission, runs on our engine locking nothing, and a cancel leaves nothing locked', async () => {
    expect(await refused(s.create(person, req({ kind: 'stop_limit', triggerPrice: '95', limitPrice: '94' }), REGION))).toMatchObject({
      code: 'trade.spot_agent_unapproved',
      status: 409,
    });
    await approveAgent();
    const before = await balance(BASE);
    const made = await s.create(person, req({ kind: 'stop_limit', triggerPrice: '95', limitPrice: '94' }), REGION);
    if (made.restsOn !== 'engine') throw new Error('expected the engine');
    expect(made.conditional).toMatchObject({
      kind: 'stop_limit',
      status: 'armed',
      label: SPOT_ENGINE_LABEL,
      triggerPrice: '95',
      limitPrice: '94',
      referencePrice: '100',
    });
    expect(made.conditional.legs).toEqual([expect.objectContaining({ role: 'stop', restsOn: 'engine', status: 'armed', locked: null })]);
    // Nothing locked at the venue, and nothing on the book.
    expect(await balance(BASE)).toEqual(before);
    expect((await sim.openOrders(account())).value.filter((o) => o.symbol === SYM)).toEqual([]);
    const cancelled = await s.cancel(person, made.conditional.id);
    expect(cancelled).toMatchObject({ status: 'cancelled' });
    expect(await balance(BASE)).toEqual(before);
    await s.tick();
    await expect(door.orderByKey(person, spotKeys.fire(store.rows.get(made.conditional.id)!))).rejects.toThrow();
  });

  it('refuses a blank trigger with a typed reason in words and holds nothing; and a trigger already crossed', async () => {
    await approveAgent();
    const blank = await refused(s.create(person, req({ kind: 'stop_limit', limitPrice: '94' }), REGION));
    expect(blank).toMatchObject({ code: 'trade.spot_conditional_trigger_missing', status: 400 });
    expect(blank.message).toBe(
      'A stop-limit needs a trigger price: it is the price that sets it off. Nothing was placed and nothing is held.',
    );
    expect(await refused(s.create(person, req({ kind: 'stop_market', triggerPrice: '' }), REGION))).toMatchObject({
      code: 'trade.spot_conditional_trigger_missing',
    });
    expect(await refused(s.create(person, req({ kind: 'stop_market', triggerPrice: '101' }), REGION))).toMatchObject({
      code: 'trade.spot_conditional_wrong_side',
    });
    expect(await refused(s.create(person, req({ kind: 'stop_market', triggerPrice: '95', limitPrice: '94' }), REGION))).toMatchObject({
      code: 'trade.spot_conditional_field_unsupported',
    });
    expect(store.rows.size).toBe(0);
    expect((await balance(BASE)).locked).toBe(a('0'));
  });

  it('a crossed stop is sent once, signed by the agent key under its business key, even with two workers and a crash after the claim', async () => {
    await approveAgent();
    const made = await s.create(person, req({ kind: 'stop_limit', triggerPrice: '95', limitPrice: '94' }), REGION);
    if (made.restsOn !== 'engine') throw new Error('expected the engine');
    const row = store.rows.get(made.conditional.id)!;
    await printAt('94.5');
    // A worker claims it and stops before it sends: the claim stays `firing`.
    expect(await store.move(row.id, 'armed', 'firing', new Date())).toBe(true);
    const other = engine();
    await Promise.all([s.tick(), other.tick()]);
    await s.tick();
    const sent = await order(spotKeys.fire(row));
    expect(sent).toMatchObject({ side: 'sell', type: 'limit', timeInForce: 'GTC', status: 'open' });
    expect(sent!.price).toBe(a('94'));
    expect(sent!.amount).toBe(a('1'));
    // One order of the person's on the venue: the stop's limit, locking exactly its size.
    expect((await sim.openOrders(account())).value.filter((o) => o.symbol === SYM).map((o) => o.venueClientOrderId)).toEqual([
      sent!.venueClientOrderId,
    ]);
    expect((await balance(BASE)).locked).toBe(a('1'));
    expect(store.rows.get(row.id)).toMatchObject({ status: 'fired' });
    // The person cancels it: the resting limit is cancelled on the venue and its lock released.
    const view = await s.cancel(person, row.id);
    expect(view.legs[0]).toMatchObject({ role: 'stop', status: 'cancelled', locked: '0' });
    expect(await order(spotKeys.fire(row))).toMatchObject({ status: 'canceled' });
    expect((await balance(BASE)).locked).toBe(a('0'));
  });

  it('a stop-market fires as one IOC sell at the owner’s protection; a frozen account gets no order and the stop fails in words', async () => {
    await approveAgent();
    // A bid for the print at 94 and the stop's whole sell: nothing of it is left for the next print.
    await outside(buyer, { symbol: SYM, side: 'buy', type: 'limit', amount: a('1.1'), price: a('94'), timeInForce: 'GTC' });
    const made = await s.create(person, req({ kind: 'stop_market', triggerPrice: '95' }), REGION);
    if (made.restsOn !== 'engine') throw new Error('expected the engine');
    await printAt('94');
    await s.tick();
    const row = store.rows.get(made.conditional.id)!;
    const sent = await order(spotKeys.fire(row));
    expect(sent).toMatchObject({ side: 'sell', type: 'market', status: 'filled' });
    expect(row.status).toBe('fired');

    const frozen = await s.create(person, req({ kind: 'stop_market', triggerPrice: '93' }), REGION);
    if (frozen.restsOn !== 'engine') throw new Error('expected the engine');
    freeze.frozenUsers.add(USER);
    await printAt('92');
    await s.tick();
    expect(store.rows.get(frozen.conditional.id)).toMatchObject({
      status: 'failed',
      failure: 'your account is frozen, so our engine sent no order',
    });
    expect(await door.stored(person, spotKeys.fire(store.rows.get(frozen.conditional.id)!))).toBeNull();
  });

  it('a sell OCO rests its take profit on one venue lock; a replay is the same group; a full take-profit fill cancels the stop loss once', async () => {
    await approveAgent();
    const body = req({ kind: 'oco', takeProfitPrice: '110', triggerPrice: '95' });
    const made = await s.create(person, body, REGION);
    if (made.restsOn !== 'engine') throw new Error('expected the engine');
    expect(made.conditional).toMatchObject({ kind: 'oco', status: 'open', label: SPOT_ENGINE_LABEL });
    const [tp, sl] = made.conditional.legs;
    expect(tp).toMatchObject({ role: 'take_profit', restsOn: 'venue', status: 'open', locked: '1', lockedAsset: BASE, signedBy: 'agent' });
    expect(sl).toMatchObject({ role: 'stop_loss', restsOn: 'engine', status: 'armed', triggerPrice: '95', locked: null });
    // One venue lock: the take profit's, of the base.
    expect((await balance(BASE)).locked).toBe(a('1'));
    expect((await sim.openOrders(account())).value.filter((o) => o.symbol === SYM)).toHaveLength(1);
    // The same client id again: the same group, nothing new on the venue.
    const again = await s.create(person, body, REGION);
    if (again.restsOn !== 'engine') throw new Error('expected the engine');
    expect(again).toMatchObject({ reused: true, conditional: { id: made.conditional.id } });
    expect((await sim.openOrders(account())).value.filter((o) => o.symbol === SYM)).toHaveLength(1);
    expect(await refused(s.create(person, { ...body, takeProfitPrice: '111' }, REGION))).toMatchObject({
      code: 'trade.spot_conditional_key_reused',
    });
    // A buyer takes the whole take profit: the engine ends the stop loss, once; nothing stays locked.
    await outside(buyer, { symbol: SYM, side: 'buy', type: 'limit', amount: a('1'), price: a('110'), timeInForce: 'IOC' });
    await s.tick();
    await s.tick();
    expect(store.rows.get(made.conditional.id)).toMatchObject({ status: 'filled' });
    expect((await balance(BASE)).locked).toBe(a('0'));
    // The stop loss never fires now, even crossed.
    await printAt('90');
    await s.tick();
    expect(await door.stored(person, spotKeys.fire(store.rows.get(made.conditional.id)!))).toBeNull();
  });

  it('a partial take-profit fill keeps the remaining lock for the remaining leg, and a cancel releases exactly that', async () => {
    await approveAgent();
    const made = await s.create(person, req({ kind: 'oco', takeProfitPrice: '110', triggerPrice: '95' }), REGION);
    if (made.restsOn !== 'engine') throw new Error('expected the engine');
    await outside(buyer, { symbol: SYM, side: 'buy', type: 'limit', amount: a('0.4'), price: a('110'), timeInForce: 'IOC' });
    await s.tick();
    const [listed] = await s.list(person, owner);
    expect(listed).toMatchObject({ status: 'open' });
    expect(listed!.legs[0]).toMatchObject({ role: 'take_profit', status: 'partially_filled', filled: '0.4', locked: '0.6' });
    expect(listed!.legs[1]).toMatchObject({ role: 'stop_loss', status: 'armed', quantity: '0.6' });
    expect((await balance(BASE)).locked).toBe(a('0.6'));
    const free = (await balance(BASE)).free;
    expect(await s.cancel(person, made.conditional.id)).toMatchObject({ status: 'cancelled' });
    expect((await balance(BASE)).locked).toBe(a('0'));
    expect((await balance(BASE)).free).toBe(free + a('0.6'));
  });

  it('a crossed stop loss first cancels the take profit, releasing its lock, then sells what the take profit did not', async () => {
    await approveAgent();
    await outside(buyer, { symbol: SYM, side: 'buy', type: 'limit', amount: a('2'), price: a('94'), timeInForce: 'GTC' });
    const made = await s.create(person, req({ kind: 'oco', takeProfitPrice: '110', triggerPrice: '95' }), REGION);
    if (made.restsOn !== 'engine') throw new Error('expected the engine');
    await printAt('94');
    await s.tick();
    const row = store.rows.get(made.conditional.id)!;
    expect(row.status).toBe('fired');
    expect(await order(spotKeys.leg(row, 'tp'))).toMatchObject({ status: 'canceled', locked: a('0') });
    const sl = await order(spotKeys.fire(row));
    expect(sl).toMatchObject({ side: 'sell', type: 'market', status: 'filled' });
    expect(sl!.filled).toBe(a('1'));
    expect((await balance(BASE)).locked).toBe(a('0'));
    expect(await fillsOf(sl!.venueClientOrderId)).not.toHaveLength(0);
  });

  it('refuses a buy OCO with no stop-loss limit, and legs out of order, in words; nothing stored', async () => {
    await approveAgent();
    const noLimit = await refused(s.create(person, req({ kind: 'oco', side: 'buy', takeProfitPrice: '90', triggerPrice: '105' }), REGION));
    expect(noLimit).toMatchObject({ code: 'trade.oco_stop_limit_missing' });
    expect(noLimit.message).toBe('A buy stop loss needs a stop-loss limit: the most you will pay when it fires. Nothing was placed.');
    const outOfOrder = await refused(s.create(person, req({ kind: 'oco', takeProfitPrice: '95', triggerPrice: '110' }), REGION));
    expect(outOfOrder).toMatchObject({ code: 'trade.oco_legs_out_of_order' });
    expect(outOfOrder.message).toBe('The take-profit price must be above the stop-loss trigger: 95 is not above 110. Nothing was placed.');
    expect(
      await refused(
        s.create(person, req({ kind: 'oco', side: 'buy', takeProfitPrice: '90', triggerPrice: '105', limitPrice: '104' }), REGION),
      ),
    ).toMatchObject({ code: 'trade.oco_legs_out_of_order' });
    expect(store.rows.size).toBe(0);
  });

  it('prices the take profit as maker and the stop loss as taker from the published schedule', async () => {
    const review = await s.review(person, req({ kind: 'oco', takeProfitPrice: '110', triggerPrice: '95', limitPrice: '94' }));
    const market = (await sim.markets(null)).value.find((m) => m.symbol === SYM)!;
    if (!market.makerFeeBps.known || !market.takerFeeBps.known) throw new Error('TEST market publishes its fees');
    expect(review.legs).toEqual([
      expect.objectContaining({ role: 'take_profit', liquidity: 'maker', venueFeeBps: f(market.makerFeeBps.value), builderFeeBps: '1' }),
      expect.objectContaining({ role: 'stop_loss', liquidity: 'taker', venueFeeBps: f(market.takerFeeBps.value), builderFeeBps: '1' }),
    ]);
    // 1 at 110 sold: (1 + 1) bps of 110 USDC; 1 at 94: (3.5 + 1) bps of 94.
    expect(review.legs[0]).toMatchObject({ estimatedFee: '0.022', feeAsset: 'USDC' });
    expect(review.legs[1]).toMatchObject({ estimatedFee: '0.0423', feeAsset: 'USDC' });
  });

  it('a bracket: an entry that fills nothing places no exit; a resting entry waits and a cancel places none; a filled one locks what it received behind the pair', async () => {
    await approveAgent();
    // IOC at 99 meets nothing (no ask there): no exit.
    const ioc = await s.create(
      person,
      req({ kind: 'bracket', side: 'buy', entryPrice: '99', entryTif: 'IOC', takeProfitPrice: '110', triggerPrice: '95' }),
      REGION,
    );
    if (ioc.restsOn !== 'engine' || !ioc.entry) throw new Error('expected an entry to sign');
    expect((await signAndSend(ioc.entry)).outcome).toMatchObject({ accepted: true });
    await s.tick();
    const iocRow = store.rows.get(ioc.conditional.id)!;
    expect(iocRow).toMatchObject({ status: 'cancelled', cancelReason: 'entry_filled_nothing' });
    expect(await door.stored(person, spotKeys.leg(iocRow, 'tp'))).toBeNull();

    // A resting GTC entry waits; the cancel cancels it on the venue, and no exit is placed.
    const rest = await s.create(
      person,
      req({ kind: 'bracket', side: 'buy', entryPrice: '98', takeProfitPrice: '110', triggerPrice: '95' }),
      REGION,
    );
    if (rest.restsOn !== 'engine' || !rest.entry) throw new Error('expected an entry to sign');
    await signAndSend(rest.entry);
    await s.tick();
    const restRow = store.rows.get(rest.conditional.id)!;
    expect(restRow.status).toBe('entry');
    expect(await order(spotKeys.leg(restRow, 'entry'))).toMatchObject({ status: 'open' });
    expect(await s.cancel(person, rest.conditional.id)).toMatchObject({ status: 'cancelled' });
    expect(await order(spotKeys.leg(restRow, 'entry'))).toMatchObject({ status: 'canceled' });
    expect(await door.stored(person, spotKeys.leg(restRow, 'tp'))).toBeNull();
    expect((await balance('USDC')).locked).toBe(a('0'));

    // An entry that fills: the coins it received, net of the fee it paid in them, behind one OCO exit pair.
    await outside(seller, { symbol: SYM, side: 'sell', type: 'limit', amount: a('1'), price: a('100'), timeInForce: 'GTC' });
    const lockedBefore = (await balance(BASE)).locked;
    const filled = await s.create(
      person,
      req({ kind: 'bracket', side: 'buy', entryPrice: '100', entryTif: 'IOC', takeProfitPrice: '110', triggerPrice: '95' }),
      REGION,
    );
    if (filled.restsOn !== 'engine' || !filled.entry) throw new Error('expected an entry to sign');
    await signAndSend(filled.entry);
    await s.tick();
    const row = store.rows.get(filled.conditional.id)!;
    expect(row.status).toBe('open');
    const entry = await order(spotKeys.leg(row, 'entry'));
    const fees = (await fillsOf(entry!.venueClientOrderId)).reduce((sum, x) => sum + x.venueFee + x.builderFee, 0n);
    const received = entry!.filled - fees - ((entry!.filled - fees) % a('0.001'));
    expect(row.exitQuantity).toBe(received);
    const tp = await order(spotKeys.leg(row, 'tp'));
    expect(tp).toMatchObject({ side: 'sell', status: 'open' });
    expect(tp!.amount).toBe(received);
    expect((await balance(BASE)).locked - lockedBefore).toBe(received);
  });

  it('a linked close is listed linked to its entry, cancelled with it, and placed when the entry fills', async () => {
    await approveAgent();
    const made = await s.create(person, req({ kind: 'oto', side: 'buy', entryPrice: '98', closePrice: '105' }), REGION);
    if (made.restsOn !== 'engine' || !made.entry) throw new Error('expected an entry to sign');
    await signAndSend(made.entry);
    await s.tick();
    const [listed] = await s.list(person, owner);
    expect(listed!.legs.map((l) => [l.role, l.status, l.linkedTo])).toEqual([
      ['entry', 'open', null],
      ['close', 'waiting', 'entry'],
    ]);
    await s.cancel(person, made.conditional.id);
    const row = store.rows.get(made.conditional.id)!;
    expect(row.status).toBe('cancelled');
    expect(await order(spotKeys.leg(row, 'entry'))).toMatchObject({ status: 'canceled' });
    expect(await door.stored(person, spotKeys.leg(row, 'close'))).toBeNull();

    await outside(seller, { symbol: SYM, side: 'sell', type: 'limit', amount: a('1'), price: a('100'), timeInForce: 'GTC' });
    const fills = await s.create(person, req({ kind: 'oto', side: 'buy', entryPrice: '100', entryTif: 'IOC', closePrice: '105' }), REGION);
    if (fills.restsOn !== 'engine' || !fills.entry) throw new Error('expected an entry to sign');
    await signAndSend(fills.entry);
    await s.tick();
    const placed = store.rows.get(fills.conditional.id)!;
    expect(placed.status).toBe('fired');
    expect(await order(spotKeys.leg(placed, 'close'))).toMatchObject({ side: 'sell', type: 'limit', status: 'open' });
  });

  it('modifies a live stop’s trigger, judged as a new one', async () => {
    await approveAgent();
    const made = await s.create(person, req({ kind: 'stop_market', triggerPrice: '95' }), REGION);
    if (made.restsOn !== 'engine') throw new Error('expected the engine');
    expect(await s.modify(person, made.conditional.id, { triggerPrice: '96' })).toMatchObject({ triggerPrice: '96', status: 'armed' });
    expect(await refused(s.modify(person, made.conditional.id, { triggerPrice: '101' }))).toMatchObject({
      code: 'trade.spot_conditional_wrong_side',
    });
    expect(store.rows.get(made.conditional.id)!.triggerPrice).toBe(a('96'));
  });
});
