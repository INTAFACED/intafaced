import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseAmount } from '@intafaced/ledger-client/money';
import {
  ordersTakenTogether,
  venueClientOrderId,
  type PlaceUserOrderIntent,
  type PlaceUserOrdersIntent,
  type UserVenueAccount,
  type VenueIntent,
} from '@intafaced/venue-contracts';
import { TEST_VENUE_MARKETS, seedTestVenue } from './http-server.js';
import type { TestVenueTypedData } from './signing.js';
import { TestVenueSimulator } from './simulator.js';

// J-derivatives-03 #9 at the venue: orders signed together (`place_orders`), as one-tap reverse sends its close and its
// open on a venue that takes them in one signed action. Every figure is TEST.

const a = parseAmount;
const ETH = 'ETH-PERP';

function world(ordersPerAction?: number) {
  let now = Date.UTC(2026, 10, 15, 8, 0, 0);
  const sim = new TestVenueSimulator({
    clock: () => new Date((now += 1000)),
    markets: TEST_VENUE_MARKETS,
    chainId: 84532,
    ...(ordersPerAction !== undefined ? { ordersPerAction } : {}),
  });
  const key = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet reverse trader')));
  const owner = key.address.toLowerCase();
  const account: UserVenueAccount = { venueId: sim.venue.id, owner, subAccount: null };
  const signer = { role: 'owner' as const, address: owner };
  let signatures = 0;
  const sign = async (intent: VenueIntent) => {
    const prepared = await sim.prepare(account, signer, intent);
    const t = prepared.typedData as TestVenueTypedData;
    const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
    signatures += 1;
    return { prepared, signature: { digest: prepared.digest, signature, signedBy: owner } };
  };
  const run = async (intent: VenueIntent) => {
    const { prepared, signature } = await sign(intent);
    return sim.submit(prepared, signature);
  };
  return { sim, account, signer, sign, run, signatures: () => signatures };
}

const order = (over: Partial<PlaceUserOrderIntent>): PlaceUserOrderIntent => ({
  kind: 'place_order',
  symbol: ETH,
  side: 'sell',
  type: 'market',
  amount: a('1'),
  price: a('2900'),
  timeInForce: 'IOC',
  reduceOnly: true,
  clientOrderKey: 'order:reverse-trader:x',
  builderFee: null,
  ...over,
});

const reverse = (key: string, over: Partial<PlaceUserOrderIntent> = {}): PlaceUserOrdersIntent => ({
  kind: 'place_orders',
  actionKey: key,
  orders: [
    order({ clientOrderKey: `${key}:close`, reduceOnly: true }),
    order({ clientOrderKey: `${key}:open`, reduceOnly: false, ...over }),
  ],
});

/** Seeded, funded, 5x isolated on ETH-PERP and long 1 ETH. */
async function long(ordersPerAction?: number) {
  const w = world(ordersPerAction);
  await seedTestVenue(w.sim);
  w.sim.deposit(w.account, 'USDC', a('5000'), 'chain:reverse:d1');
  expect(await w.run({ kind: 'update_leverage', symbol: ETH, leverageBps: 50_000, marginMode: 'isolated' })).toMatchObject({
    accepted: true,
  });
  expect(
    await w.run(order({ side: 'buy', reduceOnly: false, price: a('3010'), clientOrderKey: 'order:reverse-trader:entry' })),
  ).toMatchObject({
    accepted: true,
    order: { status: 'filled' },
  });
  return w;
}

const position = async (w: ReturnType<typeof world>) => (await w.sim.positions(w.account)).value.find((p) => p.symbol === ETH) ?? null;
const byKey = async (w: ReturnType<typeof world>, key: string) =>
  (await w.sim.orderByClientId(w.account, venueClientOrderId(w.sim.venue.id, key))).value;

describe('TEST venue simulator: orders signed together (J-derivatives-03 #9)', { timeout: 60_000 }, () => {
  it('declares how many orders it takes in one signed action; one that declares none takes one per signature', () => {
    expect(world(10).sim.venue.ordersPerAction).toBe(10);
    expect(ordersTakenTogether(world(10).sim.venue)).toBe(10);
    expect(world().sim.venue.ordersPerAction).toBeUndefined();
    expect(ordersTakenTogether(world().sim.venue)).toBe(1);
  });

  it('a close and an open signed once: applied in order, each answered on its own, the long becomes a short of the same size', async () => {
    const w = await long(10);
    const before = w.signatures();
    const outcome = await w.run(reverse('reverse:trader:1'));
    expect(w.signatures() - before).toBe(1);
    expect(outcome).toMatchObject({ definite: true, accepted: true, order: null });
    if (!outcome.definite || !outcome.accepted) throw new Error('not accepted');
    expect(outcome.legs).toHaveLength(2);
    expect(outcome.legs![0]).toMatchObject({ accepted: true, order: { side: 'sell', reduceOnly: true, status: 'filled', filled: a('1') } });
    expect(outcome.legs![1]).toMatchObject({
      accepted: true,
      order: { side: 'sell', reduceOnly: false, status: 'filled', filled: a('1') },
    });
    expect(await position(w)).toMatchObject({ side: 'short', size: a('1') });
    // Each order keeps its own client id on the venue.
    expect(await byKey(w, 'reverse:trader:1:close')).toMatchObject({ status: 'filled', reduceOnly: true });
    expect(await byKey(w, 'reverse:trader:1:open')).toMatchObject({ status: 'filled', reduceOnly: false });
  });

  it('the same signed action sent again answers its first outcome and places nothing new', async () => {
    const w = await long(10);
    const { prepared, signature } = await w.sign(reverse('reverse:trader:2'));
    const first = await w.sim.submit(prepared, signature);
    const fills = (await w.sim.fills(w.account, new Date(0))).value.length;
    const again = await w.sim.submit(prepared, signature);
    expect(again).toEqual(first);
    expect((await w.sim.fills(w.account, new Date(0))).value).toHaveLength(fills);
    expect(await position(w)).toMatchObject({ side: 'short', size: a('1') });
  });

  it('one order refused does not undo the one before it: the first close fills, a second close with nothing left is refused', async () => {
    const w2 = await long(10);
    const twoCloses: PlaceUserOrdersIntent = {
      kind: 'place_orders',
      actionKey: 'reverse:trader:4',
      orders: [order({ clientOrderKey: 'reverse:trader:4:close' }), order({ clientOrderKey: 'reverse:trader:4:again' })],
    };
    const both = await w2.run(twoCloses);
    if (!both.definite || !both.accepted) throw new Error('not accepted');
    expect(both.legs![0]).toMatchObject({ accepted: true, order: { status: 'filled' } });
    expect(both.legs![1]).toMatchObject({ accepted: false, refusal: { code: 'venue_rejected' } });
    expect(await position(w2)).toBeNull();
  });

  it('a venue that takes one order per signature refuses orders signed together, before anything is signed', async () => {
    const w = await long();
    await expect(w.sim.prepare(w.account, w.signer, reverse('reverse:trader:5'))).rejects.toMatchObject({
      refusal: { code: 'not_offered', detail: 'TEST venue simulator takes one order per signature: sign each order on its own' },
    });
    expect(await position(w)).toMatchObject({ side: 'long', size: a('1') });
  });

  it('refuses at prepare: one order alone, more than it takes, a repeated client key, and a trigger order', async () => {
    const w = await long(2);
    const refusedWith = (intent: PlaceUserOrdersIntent, code: string) =>
      expect(w.sim.prepare(w.account, w.signer, intent)).rejects.toMatchObject({ refusal: { code } });
    await refusedWith(
      { kind: 'place_orders', actionKey: 'reverse:trader:6', orders: [order({ clientOrderKey: 'reverse:trader:6:a' })] },
      'venue_rejected',
    );
    await refusedWith(
      {
        kind: 'place_orders',
        actionKey: 'reverse:trader:7',
        orders: ['a', 'b', 'c'].map((x) => order({ clientOrderKey: `reverse:trader:7:${x}` })),
      },
      'not_offered',
    );
    await refusedWith(
      {
        kind: 'place_orders',
        actionKey: 'reverse:trader:8',
        orders: [order({ clientOrderKey: 'reverse:trader:8:a' }), order({ clientOrderKey: 'reverse:trader:8:a' })],
      },
      'venue_rejected',
    );
    await refusedWith(
      {
        kind: 'place_orders',
        actionKey: 'reverse:trader:9',
        orders: [
          order({ clientOrderKey: 'reverse:trader:9:a' }),
          order({ clientOrderKey: 'reverse:trader:9:b', trigger: { price: a('3200'), source: 'mark', role: 'take_profit' } }),
        ],
      },
      'not_offered',
    );
    expect(await position(w)).toMatchObject({ side: 'long', size: a('1') });
  });
});
