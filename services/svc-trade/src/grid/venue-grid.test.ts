import type http from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { keccak256, toHex, type TypedDataDefinition } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import type { Principal } from '@intafaced/auth';
import { add, formatAmount, mul, parseAmount, sub } from '@intafaced/ledger-client/money';
import type { PlaceUserOrderIntent, PreparedVenueAction, UserVenueAccount } from '@intafaced/venue-contracts';
import { seedTestVenue, startTestVenueServer, type TestVenueSimulator } from '@intafaced/venue-sim';
import { HttpUserVenue } from '../venue/http-user-venue.js';
import { InMemoryPreparedActionStore } from '../venue/prepared-action-store.js';
import { MemoryFreezeRead } from '../quant/live-run/ports.js';
import { UserVenueDoor } from '../venue/user-venue-door.js';
import { MemoryVenueListingStore } from '../venue/venue-listing-store.js';
import { StoreVenueRoutingGate } from '../venue/venue-listing.js';
import { GridError } from './errors.js';
import { gridTrpcError } from './router.js';
import { gridClientOrderId } from './types.js';
import { InMemoryVenueGridStore } from './venue-grid-store.js';
import { WITHDRAW_REFUSED, VenueGrid, gridAgentKey, pairProfit } from './venue-grid.js';

// J-copy-bots-otc-14 in svc-trade: the spot grid on the person's own venue account, against the TEST venue simulator over
// HTTP. The venue holds the coins, the locks and the fills; nothing here is posted. Every figure is TEST. Each test lists a
// TEST spot market of its own, so its book is only what the test puts there.

const a = parseAmount;
const USER = '11111111-1111-4111-8111-11111111c514';
const person = {
  sub: USER,
  userId: USER,
  sid: '33333333-3333-4333-8333-3333333333c9',
  scopes: ['trade:read', 'trade:write'],
  tier: 'full',
  mfa: false,
  expiresAt: new Date(Date.now() + 600_000),
} as Principal;
const wallet = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet svc-trade venue grid')));
const owner = wallet.address.toLowerCase();
const BUILDER = '0x00000000000000000000000000000000000000b4';
const REGION = 'DE';
const SEED = 'intafaced unit TEST venue grid seed';
const trader = (name: string) => privateKeyToAccount(keccak256(toHex(`intafaced TEST venue grid trader ${name}`)));
const POLICY = { countRange: { min: 2, max: 100 }, boundsMaxDistanceBps: 1000, presetSource: null, withdrawDailyCap: new Map() } as const;

async function refused(p: Promise<unknown>): Promise<GridError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof GridError) return err;
    throw err;
  }
  throw new Error('expected a GridError');
}

describe('the spot grid on the venue (J-copy-bots-otc-14)', { timeout: 60_000 }, () => {
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
  let grid: VenueGrid;
  let freeze: MemoryFreezeRead;
  let n = 0;
  const id = (tag: string) => `${tag}-${(n += 1)}`;
  let SYM = '';
  let BASE = '';

  const account = (who = owner): UserVenueAccount => ({ venueId, owner: who, subAccount: null });
  const balance = async (asset: string, who = owner) =>
    (await sim.balances(account(who))).value.find((b) => b.asset === asset) ?? { free: a('0'), locked: a('0') };
  const ourOpen = async () => (await sim.openOrders(account())).value.filter((o) => o.symbol === SYM);

  async function signAndSend(prepared: { actionKey: string; prepared: PreparedVenueAction }) {
    const signature = await wallet.signTypedData(prepared.prepared.typedData as TypedDataDefinition);
    return door.submit(person, prepared.actionKey, { digest: prepared.prepared.digest, signature, signedBy: owner });
  }

  /** Another TEST trader acts on the venue directly with their own key. */
  async function outside(key: PrivateKeyAccount, intent: Omit<PlaceUserOrderIntent, 'kind' | 'builderFee' | 'reduceOnly'>) {
    const who = key.address.toLowerCase();
    const prepared = await sim.prepare(
      account(who),
      { role: 'owner', address: who },
      { kind: 'place_order', reduceOnly: false, builderFee: null, ...intent },
    );
    const signature = await key.signTypedData(prepared.typedData as TypedDataDefinition);
    return sim.submit(prepared, { digest: prepared.digest, signature, signedBy: who });
  }
  async function outsideCancel(key: PrivateKeyAccount, clientOrderKey: string) {
    const who = key.address.toLowerCase();
    const prepared = await sim.prepare(
      account(who),
      { role: 'owner', address: who },
      { kind: 'cancel_order', symbol: SYM, clientOrderKey },
    );
    const signature = await key.signTypedData(prepared.typedData as TypedDataDefinition);
    return sim.submit(prepared, { digest: prepared.digest, signature, signedBy: who });
  }

  const maker = trader('maker');
  const taker = trader('taker');
  let bidKey = '';

  beforeEach(async () => {
    BASE = `VG${(n += 1)}X`;
    SYM = `${BASE}-USDC`;
    const added = await fetch(`${url}/test/market-add`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ symbol: SYM, baseAsset: BASE, quoteAsset: 'USDC', maxOrderQty: null, maxOrderNotional: null }),
    });
    expect(added.status).toBe(200);
    const listings = new MemoryVenueListingStore();
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
    grid = new VenueGrid({
      door,
      store: new InMemoryVenueGridStore(),
      policy: POLICY,
      verification: () => ({ mode: 'required', level: 'full' }),
      keySeed: SEED,
      liveTier: async () => 'full',
      freeze,
      now: () => new Date(),
    });
    for (const [who, asset, amount] of [
      [owner, 'USDC', '1000'],
      [maker.address.toLowerCase(), BASE, '100'],
      [maker.address.toLowerCase(), 'USDC', '100000'],
      [taker.address.toLowerCase(), BASE, '100'],
      [taker.address.toLowerCase(), 'USDC', '100000'],
    ] as const)
      sim.deposit(account(who), asset, a(amount), `chain:venue-grid:${id('d')}`);
    // A two-sided book around 105: the mark the grid is planned and placed around.
    bidKey = `order:maker:${id('bid')}`;
    await outside(maker, {
      symbol: SYM,
      side: 'buy',
      type: 'limit',
      amount: a('0.01'),
      price: a('104.5'),
      timeInForce: 'GTC',
      clientOrderKey: bidKey,
    });
    await outside(maker, {
      symbol: SYM,
      side: 'sell',
      type: 'limit',
      amount: a('5'),
      price: a('105.5'),
      timeInForce: 'GTC',
      clientOrderKey: `order:maker:${id('ask')}`,
    });
  });

  async function approveBuilder() {
    await signAndSend(
      await door.prepare(person, {
        owner,
        signer: { role: 'owner', address: owner },
        intent: { kind: 'approve_builder_fee', builder: BUILDER, maxFeeBps: a('5') },
        actionKey: `builder-fee:${owner}:${id('fee')}`,
      }),
    );
  }

  const create = (over: Record<string, unknown> = {}) =>
    grid.create(
      person,
      {
        clientRequestId: `grid-${id('k')}`,
        symbol: SYM,
        lowerPrice: '100',
        upperPrice: '110',
        gridCount: 11,
        investment: '550',
        owner,
        ...over,
      },
      REGION,
    );

  /** The wallet signs the bot's agent permission the view asks for, and it goes to the venue through the bot. */
  async function sign(view: Awaited<ReturnType<typeof create>>) {
    // The permission is one per person and account: a later test's bot finds it on the venue already.
    if (!view.next) return grid.get(person, view.botId);
    const next = view.next;
    const stored = await door.stored(person, next.actionKey);
    const signature = await wallet.signTypedData(stored!.prepared.typedData as TypedDataDefinition);
    return grid.submitPermission(person, {
      botId: view.botId,
      actionKey: next.actionKey,
      signature: { digest: next.digest, signature, signedBy: owner },
    });
  }

  it('refuses blank bounds, one grid, more than the free quote and an unapproved builder fee by name, placing nothing', async () => {
    expect(await refused(create({ lowerPrice: '' }))).toMatchObject({
      code: 'trade.bots_grid_bounds_not_set',
      message: 'Lower price is required',
    });
    expect(await refused(create({ gridCount: 1 }))).toMatchObject({
      code: 'trade.bots_grid_count_out_of_range',
      message: 'Grids must be from 2 to 100',
    });
    expect((await refused(create({ owner: '' }))).code).toBe('trade.bots_grid_wallet_required');
    expect(await refused(create())).toMatchObject({ code: 'trade.bots_grid_builder_fee_unapproved' });
    await approveBuilder();
    expect(await refused(create({ investment: '5000' }))).toMatchObject({ code: 'trade.grid_reserve_exceeds_balance' });
    expect(await ourOpen()).toEqual([]);
  });

  it('asks the wallet for the agent permission first and places nothing until it is signed; a rejected signature places nothing', async () => {
    await approveBuilder();
    const made = await create();
    expect(made.status).toBe('signing');
    expect(made.next?.actionKey).toBe(gridAgentKey(owner, made.venue.agentAddress));
    expect(made.next?.typedData.primaryType).toBeTruthy();
    // The person rejects it in their wallet: nothing is sent, and on the next pass the bot still places nothing.
    await grid.tickAll();
    expect(await ourOpen()).toEqual([]);
    expect((await grid.get(person, made.botId)).status).toBe('signing');
    expect(await ourOpen()).toEqual([]);
  });

  it('once signed, places one buy per level below the mark under the agent permission; the same key returns the same bot', async () => {
    await approveBuilder();
    const key = `grid-${id('k')}`;
    const made = await create({ clientRequestId: key });
    const running = await sign(made);
    expect(running.status).toBe('running');
    // Levels 100..110; the mark is 105: buys at 100 to 104, five, each one venue order under its own key.
    const open = await ourOpen();
    expect(open.map((o) => o.side)).toEqual(Array(5).fill('buy'));
    expect(open.map((o) => formatAmount(o.price)).sort()).toEqual(['100', '101', '102', '103', '104']);
    expect(running.orders.map((o) => o.clientOrderId).sort()).toEqual(
      [0, 1, 2, 3, 4].map((i) => gridClientOrderId(made.botId, i, 'buy', 0)).sort(),
    );
    // Each holds only what the venue locks for it, and together no more than the investment.
    const locked = (await balance('USDC')).locked;
    expect(locked).toBe(open.reduce((t, o) => add(t, mul(o.price, o.amount)), a('0')));
    expect(locked <= a('550')).toBe(true);
    // The venue signed each with the grid key, never the wallet.
    for (const o of running.orders) {
      expect((await door.stored(person, o.clientOrderId))?.prepared.signer).toEqual({ role: 'agent', address: made.venue.agentAddress });
    }
    // The same request again is the same bot and places nothing more.
    const again = await create({ clientRequestId: key });
    expect(again.botId).toBe(made.botId);
    expect(await ourOpen()).toHaveLength(5);
    // The same key with other terms is refused.
    expect((await refused(create({ clientRequestId: key, gridCount: 12 }))).code).toBe('trade.grid_request_conflict');
    // A second bot of the same person on the same account needs no second signature.
    const second = await create({ lowerPrice: '101', upperPrice: '109', gridCount: 9, investment: '100' });
    expect(second.status).not.toBe('signing');
    expect(second.next).toBeNull();
  });

  it('closes two level pairs from the venue’s fills: grid profit is their sum net of the venue’s fee and our builder fee', async () => {
    await approveBuilder();
    const made = await sign(await create());
    await outsideCancel(maker, bidKey);
    // A seller takes our top two buys (104 and 103) whole.
    const at = Object.fromEntries(made.orders.map((o) => [o.price, o]));
    const two = add(a(at['104']!.qty), a(at['103']!.qty));
    await outside(taker, {
      symbol: SYM,
      side: 'sell',
      type: 'limit',
      amount: two,
      price: a('103'),
      timeInForce: 'IOC',
      clientOrderKey: `order:taker:${id('s')}`,
    });
    await grid.tickAll();
    const bought = await grid.get(person, made.botId);
    const sells = bought.orders.filter((o) => o.side === 'sell');
    expect(sells.map((o) => o.price).sort()).toEqual(['104', '105']);
    expect(sells.every((o) => o.status === 'open')).toBe(true);
    // A buyer takes both sells.
    const sold = sells.reduce((t, o) => add(t, a(o.qty)), a('0'));
    await outside(taker, {
      symbol: SYM,
      side: 'buy',
      type: 'limit',
      amount: sold,
      price: a('105'),
      timeInForce: 'IOC',
      clientOrderKey: `order:taker:${id('b')}`,
    });
    await grid.tickAll();
    const closed = await grid.get(person, made.botId);
    expect(closed.closedPairs).toBe(2);
    const fills = (await sim.fills(account(), new Date(0))).value.filter((f) => f.symbol === SYM);
    let sum = a('0');
    const fee = (f: (typeof fills)[number], asset: string) => (f.feeAsset === asset ? add(f.venueFee, f.builderFee) : a('0'));
    for (const sell of closed.orders.filter((o) => o.side === 'sell')) {
      const bf = fills.filter((f) => f.side === 'buy' && formatAmount(f.price) === closed.levels[sell.levelIndex]!.price);
      const sf = fills.filter((f) => f.side === 'sell' && formatAmount(f.price) === sell.price);
      expect(bf).toHaveLength(1);
      expect(sf).toHaveLength(1);
      // Our builder fee is charged on each sell, and the pair's profit is net of it and of the venue's fee.
      expect(sf[0]!.builderFee > a('0')).toBe(true);
      // By hand: the sell's quote less its fees, less what the base it sold cost (the buy's fee is taken in the base).
      const received = sub(bf[0]!.amount, fee(bf[0]!, BASE));
      expect(sf[0]!.amount).toBe((received / a('0.001')) * a('0.001'));
      const cost = add(mul(bf[0]!.price, bf[0]!.amount), fee(bf[0]!, 'USDC'));
      const share = (cost * sf[0]!.amount + received - 1n) / received;
      const want = sub(sub(mul(sf[0]!.price, sf[0]!.amount), fee(sf[0]!, 'USDC')), share);
      expect(sell.pairProfit).toBe(formatAmount(want));
      expect(formatAmount(pairProfit({ baseAsset: BASE, quoteAsset: 'USDC' }, bf, sf))).toBe(formatAmount(want));
      expect(want > a('0')).toBe(true);
      sum = add(sum, want);
    }
    expect(closed.gridProfit).toBe(formatAmount(sum));
    expect(closed.fees.find((f) => f.asset === 'USDC')?.builderFee).not.toBe('0');
    // An APR with zero days reads "Not set".
    expect(closed.gridApr).toEqual({ state: 'under_a_day', percent: null });
  });

  it('pauses on a mark above the upper bound: no new buy is placed', async () => {
    await approveBuilder();
    const made = await sign(await create());
    const before = (await ourOpen()).length;
    // The book moves above 110: the maker's ask is taken and a new book rests at 115.
    await outside(taker, {
      symbol: SYM,
      side: 'buy',
      type: 'limit',
      amount: a('5'),
      price: a('105.5'),
      timeInForce: 'IOC',
      clientOrderKey: `order:taker:${id('lift')}`,
    });
    await outsideCancel(maker, bidKey);
    await outside(maker, {
      symbol: SYM,
      side: 'buy',
      type: 'limit',
      amount: a('0.01'),
      price: a('114.5'),
      timeInForce: 'GTC',
      clientOrderKey: `order:maker:${id('hb')}`,
    });
    await outside(maker, {
      symbol: SYM,
      side: 'sell',
      type: 'limit',
      amount: a('1'),
      price: a('115.5'),
      timeInForce: 'GTC',
      clientOrderKey: `order:maker:${id('ha')}`,
    });
    await grid.tickAll();
    const paused = await grid.get(person, made.botId);
    expect(paused).toMatchObject({ status: 'paused_range', statusReason: 'mark_outside_range' });
    await grid.tickAll();
    expect((await ourOpen()).filter((o) => o.side === 'buy').length).toBeLessThanOrEqual(before);
    expect((await grid.get(person, made.botId)).orders.filter((o) => o.side === 'buy')).toHaveLength(5);
  });

  it('refuses a withdrawal through the bot: its agent permission can’t withdraw, and nothing moves', async () => {
    await approveBuilder();
    const made = await sign(await create());
    const before = await balance('USDC');
    expect(await refused(grid.withdrawProfit(person, made.botId))).toMatchObject({
      code: 'trade.bots_grid_withdraw_not_permitted',
      message: WITHDRAW_REFUSED,
    });
    // A refusal of permission: the door answers it 403, like the API key's withdraw refusal.
    expect(gridTrpcError(new GridError(WITHDRAW_REFUSED, 'trade.bots_grid_withdraw_not_permitted'))).toMatchObject({ code: 'FORBIDDEN' });
    expect(await balance('USDC')).toEqual(before);
    // The venue itself refuses the grid key a withdrawal too.
    await expect(
      door.prepare(person, {
        owner,
        signer: { role: 'agent', address: made.venue.agentAddress },
        intent: {
          kind: 'withdraw',
          asset: 'USDC',
          amount: a('1'),
          destination: owner,
          withdrawalKey: `withdraw:${owner}:${id('w')}`,
        } as never,
      }),
    ).rejects.toThrow();
  });

  it('a stop cancels every open level order on the venue; what filled stays on the account', async () => {
    await approveBuilder();
    const lockedBefore = (await balance('USDC')).locked;
    const made = await sign(await create());
    expect((await ourOpen()).length).toBe(5);
    const stopped = await grid.stop(person, made.botId);
    expect(stopped).toMatchObject({ status: 'stopped', statusReason: 'user_stop' });
    expect(await ourOpen()).toEqual([]);
    expect((await balance('USDC')).locked).toBe(lockedBefore);
    expect(stopped.orders.every((o) => o.status === 'cancelled')).toBe(true);
  });

  it('pairProfit rounds the cost share up, so a profit is never overstated', () => {
    const fill = (side: 'buy' | 'sell', price: string, amount: string, venueFee: string, builderFee: string, feeAsset: string) =>
      ({
        fillId: id('f'),
        venueClientOrderId: null,
        symbol: 'X-USDC',
        side,
        price: a(price),
        amount: a(amount),
        role: 'maker',
        venueFee: a(venueFee),
        builderFee: a(builderFee),
        feeAsset,
        realisedPnl: null,
        filledAt: new Date(),
      }) as const;
    const m = { baseAsset: 'X', quoteAsset: 'USDC' };
    // Bought 1 X at 100 paying 0.001 X; sold 0.999 at 101 paying 0.05 + 0.01 USDC: 100.899 - 0.06 - 100 = 0.839.
    expect(
      formatAmount(pairProfit(m, [fill('buy', '100', '1', '0.001', '0', 'X')], [fill('sell', '101', '0.999', '0.05', '0.01', 'USDC')])),
    ).toBe('0.839');
  });
});
