import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseAmount } from '@intafaced/ledger-client/money';
import {
  decodeVenueWire,
  encodeVenueWire,
  venueClientOrderId,
  type PlaceUserOrderIntent,
  type PreparedVenueAction,
  type UserVenueAccount,
  type VenueIntent,
} from '@intafaced/venue-contracts';
import { TEST_VENUE_MARKETS, answerTestVenue, seedTestVenue } from './http-server.js';
import type { TestVenueTypedData } from './signing.js';
import { TestVenueSimulator } from './simulator.js';

// J-derivatives-32 at the venue: a resting stop or take profit moved in place (`move_trigger`), the same order and
// client id at the new price, never a second order and never none; a move that would fire at once is refused; and the
// TEST switch that refuses every move of one account leaves its order exactly as it rested. Every figure is TEST.

const a = parseAmount;
const ETH = 'ETH-PERP';

function world() {
  let now = Date.UTC(2026, 10, 28, 8, 0, 0);
  const sim = new TestVenueSimulator({ clock: () => new Date((now += 1000)), markets: TEST_VENUE_MARKETS, chainId: 84532 });
  const key = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet trigger mover')));
  const owner = key.address.toLowerCase();
  const account: UserVenueAccount = { venueId: sim.venue.id, owner, subAccount: null };
  const signer = { role: 'owner' as const, address: owner };
  const sign = async (prepared: PreparedVenueAction) => {
    const t = prepared.typedData as TestVenueTypedData;
    const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
    return { digest: prepared.digest, signature, signedBy: owner };
  };
  const run = async (intent: VenueIntent) => {
    const prepared = await sim.prepare(account, signer, intent);
    return sim.submit(prepared, await sign(prepared));
  };
  return { sim, account, signer, sign, run };
}

const order = (key: string, over: Partial<PlaceUserOrderIntent>): PlaceUserOrderIntent => ({
  kind: 'place_order',
  symbol: ETH,
  side: 'sell',
  type: 'market',
  amount: a('1'),
  price: a('2900'),
  timeInForce: 'IOC',
  reduceOnly: true,
  clientOrderKey: key,
  builderFee: null,
  ...over,
});

/** Long 1 ETH at 3001 with a take profit at 3100 and a stop loss at 2950 resting, judged on the mark. */
async function protectedLong() {
  const w = world();
  await seedTestVenue(w.sim);
  w.sim.deposit(w.account, 'USDC', a('5000'), 'chain:trigger-move:d1');
  expect(await w.run({ kind: 'update_leverage', symbol: ETH, leverageBps: 50_000, marginMode: 'isolated' })).toMatchObject({
    accepted: true,
  });
  expect(
    await w.run(order('order:mover:open', { side: 'buy', reduceOnly: false, type: 'limit', price: a('3010'), timeInForce: 'IOC' })),
  ).toMatchObject({ accepted: true, order: { status: 'filled' } });
  const tp = order('order:mover:tp', { price: a('2790'), trigger: { price: a('3100'), source: 'mark', role: 'take_profit' } });
  const sl = order('order:mover:sl', { price: a('2655'), trigger: { price: a('2950'), source: 'mark', role: 'stop_loss' } });
  expect(await w.run(tp)).toMatchObject({ accepted: true });
  expect(await w.run(sl)).toMatchObject({ accepted: true });
  return { ...w, tp: venueClientOrderId(w.sim.venue.id, tp.clientOrderKey), sl: venueClientOrderId(w.sim.venue.id, sl.clientOrderKey) };
}

const open = async (w: Awaited<ReturnType<typeof protectedLong>>) =>
  (await w.sim.openOrders(w.account)).value.filter((o) => o.symbol === ETH);

describe('TEST venue simulator: a stop or target moved in place (J-derivatives-32)', { timeout: 60_000 }, () => {
  it('declares the move in place, and moves the take profit: the same order and client id at the new price, one of it', async () => {
    const w = await protectedLong();
    expect(w.sim.venue.movesTriggersInPlace).toBe(true);
    const before = (await open(w)).find((o) => o.venueClientOrderId === w.tp)!;
    const moved = await w.run({ kind: 'move_trigger', symbol: ETH, venueClientOrderId: w.tp, triggerPrice: a('3150'), price: a('2835') });
    expect(moved).toMatchObject({ definite: true, accepted: true });
    const after = await open(w);
    const tps = after.filter((o) => o.trigger?.role === 'take_profit');
    expect(tps).toHaveLength(1);
    expect(tps[0]).toMatchObject({
      venueOrderId: before.venueOrderId,
      venueClientOrderId: w.tp,
      side: 'sell',
      amount: before.amount,
      reduceOnly: true,
      price: a('2835'),
      trigger: { price: a('3150'), role: 'take_profit', source: 'mark', state: 'waiting' },
    });
    // The stop loss is untouched.
    expect(after.find((o) => o.venueClientOrderId === w.sl)!.trigger!.price).toBe(a('2950'));
  });

  it('refuses a move that would fire at once, and a move of an order that is not a waiting trigger; nothing moves', async () => {
    const w = await protectedLong();
    // The mark is 3000: a long's stop above it would fire at once.
    await expect(
      w.sim.prepare(w.account, w.signer, {
        kind: 'move_trigger',
        symbol: ETH,
        venueClientOrderId: w.sl,
        triggerPrice: a('3050'),
        price: a('2745'),
      }),
    ).rejects.toMatchObject({
      refusal: { code: 'venue_rejected', detail: expect.stringMatching(/must trigger below the mark price 3000/) },
    });
    await expect(
      w.sim.prepare(w.account, w.signer, {
        kind: 'move_trigger',
        symbol: ETH,
        venueClientOrderId: '0xnope',
        triggerPrice: a('2960'),
        price: a('2664'),
      }),
    ).rejects.toMatchObject({ refusal: { code: 'unknown_order' } });
    expect((await open(w)).find((o) => o.venueClientOrderId === w.sl)!.trigger!.price).toBe(a('2950'));
  });

  it('the TEST switch refuses each move of its account in the venue’s words, the order resting as it was', async () => {
    const w = await protectedLong();
    const answer = async (path: string, body: unknown) => {
      const [status, value] = await answerTestVenue(w.sim, 'POST', path, JSON.stringify(encodeVenueWire(body)));
      return { status, value: decodeVenueWire<Record<string, unknown>>(value) };
    };
    const reason = 'TEST: the venue refuses this change to a resting trigger order';
    expect((await answer('/test/account-switches', { owner: w.account.owner, refuseTriggerMoves: reason })).status).toBe(200);
    const intent: VenueIntent = { kind: 'move_trigger', symbol: ETH, venueClientOrderId: w.sl, triggerPrice: a('2970'), price: a('2673') };
    const prepared = await w.sim.prepare(w.account, w.signer, intent);
    const sent = await answer('/submit', { prepared, signature: await w.sign(prepared) });
    expect(sent.value).toMatchObject({ definite: true, accepted: false, refusal: { code: 'venue_rejected', detail: reason } });
    const stops = (await open(w)).filter((o) => o.trigger?.role === 'stop_loss');
    expect(stops).toHaveLength(1);
    expect(stops[0]!.trigger!.price).toBe(a('2950'));
    // Switched back off, the same move is taken.
    await answer('/test/account-switches', { owner: w.account.owner, refuseTriggerMoves: null });
    const again = await w.sim.prepare(w.account, w.signer, intent);
    expect(await w.sim.submit(again, await w.sign(again))).toMatchObject({ accepted: true });
    expect((await open(w)).find((o) => o.venueClientOrderId === w.sl)!.trigger!.price).toBe(a('2970'));
  });
});
