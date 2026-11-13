import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseAmount, ZERO } from '@intafaced/ledger-client/money';
import { venueClientOrderId, type PlaceUserOrderIntent, type UserVenueAccount, type VenueIntent } from '@intafaced/venue-contracts';
import { TEST_VENUE_MARKETS, pullTestLadder, seedTestVenue } from './http-server.js';
import type { TestVenueTypedData } from './signing.js';
import { TestVenueSimulator, crossed } from './simulator.js';

// J-derivatives-03 at the venue: trigger orders on the TEST perpetual ETH-PERP (a take profit, a stop loss, a stop
// market and a stop limit), judged on the mark or the last trade, resting on the venue until their price is crossed,
// firing once, and failing in the venue's words when nothing is there to fill them. Every figure is TEST.

const a = parseAmount;
const ETH = 'ETH-PERP';

function world() {
  let now = Date.UTC(2026, 10, 12, 8, 0, 0);
  const sim = new TestVenueSimulator({ clock: () => new Date((now += 1000)), markets: TEST_VENUE_MARKETS, chainId: 84532 });
  const key = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet trigger trader')));
  const owner = key.address.toLowerCase();
  const account: UserVenueAccount = { venueId: sim.venue.id, owner, subAccount: null };
  const signer = { role: 'owner' as const, address: owner };
  const run = async (intent: VenueIntent) => {
    const prepared = await sim.prepare(account, signer, intent);
    const t = prepared.typedData as TestVenueTypedData;
    const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
    return sim.submit(prepared, { digest: prepared.digest, signature, signedBy: owner });
  };
  return { sim, account, run };
}

let n = 0;
const order = (over: Partial<PlaceUserOrderIntent>): PlaceUserOrderIntent => ({
  kind: 'place_order',
  symbol: ETH,
  side: 'sell',
  type: 'market',
  amount: a('1'),
  price: a('2900'),
  timeInForce: 'IOC',
  reduceOnly: true,
  clientOrderKey: `order:trigger-trader:${(n += 1)}`,
  builderFee: null,
  ...over,
});
const tp = (price: string, over: Partial<PlaceUserOrderIntent> = {}) =>
  order({ trigger: { price: a(price), source: 'mark', role: 'take_profit' }, price: a('2900'), ...over });
const sl = (price: string, over: Partial<PlaceUserOrderIntent> = {}) =>
  order({ trigger: { price: a(price), source: 'mark', role: 'stop_loss' }, price: a('2900'), ...over });

/** Seeded, funded, 5x isolated on ETH-PERP and long 1 ETH, bought at the TEST ladder's best ask (3001). */
async function long() {
  const w = world();
  await seedTestVenue(w.sim);
  w.sim.deposit(w.account, 'USDC', a('5000'), 'chain:trigger:d1');
  expect(await w.run({ kind: 'update_leverage', symbol: ETH, leverageBps: 50_000, marginMode: 'isolated' })).toMatchObject({
    accepted: true,
  });
  const opened = await w.run(order({ side: 'buy', reduceOnly: false, price: a('3010'), clientOrderKey: 'order:trigger-trader:open' }));
  expect(opened).toMatchObject({ accepted: true, order: { status: 'filled', averagePrice: a('3001') } });
  return w;
}

const position = async (w: ReturnType<typeof world>) => (await w.sim.positions(w.account)).value.find((p) => p.symbol === ETH);
const byKey = async (w: ReturnType<typeof world>, key: string) =>
  (await w.sim.orderByClientId(w.account, venueClientOrderId(w.sim.venue.id, key))).value!;
const fillsOf = async (w: ReturnType<typeof world>, key: string) =>
  (await w.sim.fills(w.account, new Date(0))).value.filter((f) => f.venueClientOrderId === venueClientOrderId(w.sim.venue.id, key));

describe('TEST venue simulator: trigger orders (J-derivatives-03)', { timeout: 60_000 }, () => {
  it('lists the trigger sources and the TEST index of ETH-PERP; a market with none takes no trigger order', async () => {
    const w = world();
    const markets = (await w.sim.markets(null)).value;
    const eth = markets.find((m) => m.symbol === ETH)!;
    expect(eth.triggerSources).toEqual(['mark', 'last']);
    expect(eth.index).toEqual({ known: true, value: a('3000') });
    w.sim.setIndex(ETH, a('3002.5'));
    expect((await w.sim.markets(null)).value.find((m) => m.symbol === ETH)!.index).toEqual({ known: true, value: a('3002.5') });
    expect(markets.find((m) => m.symbol === 'BTC-PERP')!.triggerSources).toEqual([]);
    expect(markets.find((m) => m.symbol === 'BTC-USDC')!.triggerSources).toEqual([]);
    await expect(
      w.sim.prepare(w.account, { role: 'owner', address: w.account.owner }, tp('61000', { symbol: 'BTC-PERP', price: a('59000') })),
    ).rejects.toMatchObject({
      refusal: { code: 'not_offered', detail: 'trigger orders judged on the mark price are not offered on BTC-PERP' },
    });
  });

  it('#1 a take profit and a stop loss rest on the venue, waiting and off the book, each with its own venue order id', async () => {
    const w = await long();
    const book = (await w.sim.book(ETH, 10)).value;
    const t = await w.run(tp('3100', { clientOrderKey: 'order:trigger-trader:tp' }));
    const s = await w.run(sl('2950', { clientOrderKey: 'order:trigger-trader:sl', price: a('2850') }));
    for (const placed of [t, s]) expect(placed).toMatchObject({ accepted: true, order: { status: 'open', reduceOnly: true } });
    const [tpOrder, slOrder] = [await byKey(w, 'order:trigger-trader:tp'), await byKey(w, 'order:trigger-trader:sl')];
    expect(tpOrder.trigger).toEqual({
      price: a('3100'),
      source: 'mark',
      role: 'take_profit',
      state: 'waiting',
      triggeredAt: null,
      failure: null,
    });
    expect(slOrder.trigger).toMatchObject({ price: a('2950'), role: 'stop_loss', state: 'waiting' });
    expect(tpOrder.venueOrderId).not.toBe(slOrder.venueOrderId);
    // Waiting trigger orders are listed as the account's open orders, and the public book does not show them.
    expect((await w.sim.openOrders(w.account)).value.map((o) => o.venueClientOrderId)).toEqual([
      tpOrder.venueClientOrderId,
      slOrder.venueClientOrderId,
    ]);
    expect((await w.sim.book(ETH, 10)).value).toEqual(book);
    expect(await position(w)).toMatchObject({ size: a('1') });
  });

  it('#2 a take profit on the wrong side of the mark, an opening trigger and one larger than the position are refused, and nothing rests', async () => {
    const w = await long();
    const mark = (await w.sim.markets(null)).value.find((m) => m.symbol === ETH)!.mark;
    expect(mark).toEqual({ known: true, value: a('3000') });
    expect(await w.run(tp('2990'))).toMatchObject({
      accepted: false,
      refusal: {
        code: 'venue_rejected',
        detail: 'a take profit on this side must trigger above the mark price 3000: this one would fire at once',
      },
    });
    expect(await w.run(sl('3050'))).toMatchObject({
      accepted: false,
      refusal: { detail: expect.stringContaining('stop loss on this side must trigger below') },
    });
    await expect(
      w.sim.prepare(w.account, { role: 'owner', address: w.account.owner }, tp('3100', { reduceOnly: false })),
    ).rejects.toMatchObject({
      refusal: { code: 'not_offered' },
    });
    expect(await w.run(tp('3100', { amount: a('2') }))).toMatchObject({
      refusal: { detail: 'reduce-only order is larger than the position' },
    });
    expect(await w.run(tp('2900', { side: 'buy' }))).toMatchObject({
      refusal: { detail: 'reduce-only order would open or grow a position' },
    });
    expect((await w.sim.openOrders(w.account)).value).toEqual([]);
  });

  it('#6 the mark crosses the take profit: it fires once and closes the position on the venue, and the stop loss is cancelled with it', async () => {
    const w = await long();
    await w.run(tp('3100', { clientOrderKey: 'order:trigger-trader:tp' }));
    await w.run(sl('2950', { clientOrderKey: 'order:trigger-trader:sl', price: a('2850') }));
    w.sim.setMark(ETH, a('3050'));
    expect((await byKey(w, 'order:trigger-trader:tp')).trigger!.state).toBe('waiting');
    w.sim.setMark(ETH, a('3100'));
    // Fired: a reduce-only sell against the TEST bids, best first (2999 is the best bid).
    const fired = await byKey(w, 'order:trigger-trader:tp');
    expect(fired).toMatchObject({ status: 'filled', filled: a('1'), averagePrice: a('2999'), trigger: { state: 'triggered' } });
    expect(fired.trigger!.triggeredAt).toBeInstanceOf(Date);
    expect(await fillsOf(w, 'order:trigger-trader:tp')).toHaveLength(1);
    expect(await position(w)).toBeUndefined();
    expect(await byKey(w, 'order:trigger-trader:sl')).toMatchObject({ status: 'canceled', cancelReason: 'position_closed', locked: ZERO });
    // Once: the mark crossing again fires nothing more.
    w.sim.setMark(ETH, a('3200'));
    expect(await fillsOf(w, 'order:trigger-trader:tp')).toHaveLength(1);
    const usdc = (await w.sim.balances(w.account)).value.find((b) => b.asset === 'USDC')!;
    expect(usdc.locked).toBe(ZERO);
  });

  it('#3 a part take profit closes only its size; the stop loss on the whole then closes what is left, no more', async () => {
    const w = await long();
    await w.run(tp('3100', { amount: a('0.4'), clientOrderKey: 'order:trigger-trader:part' }));
    await w.run(sl('2950', { amount: a('1'), price: a('2850'), clientOrderKey: 'order:trigger-trader:whole' }));
    w.sim.setMark(ETH, a('3100'));
    expect(await byKey(w, 'order:trigger-trader:part')).toMatchObject({ status: 'filled', filled: a('0.4') });
    expect(await position(w)).toMatchObject({ size: a('0.6') });
    expect(await byKey(w, 'order:trigger-trader:whole')).toMatchObject({ status: 'open', trigger: { state: 'waiting' } });
    w.sim.setMark(ETH, a('2950'));
    expect(await byKey(w, 'order:trigger-trader:whole')).toMatchObject({
      status: 'filled',
      amount: a('0.6'),
      filled: a('0.6'),
      trigger: { state: 'triggered' },
    });
    expect(await position(w)).toBeUndefined();
  });

  it('#5 a stop judged on the last trade fires on a trade, not on the mark; a stop limit rests on the book at its limit once triggered', async () => {
    const w = await long();
    await w.run(
      order({
        trigger: { price: a('2997'), source: 'last', role: 'stop_loss' },
        amount: a('0.2'),
        clientOrderKey: 'order:trigger-trader:last',
      }),
    );
    await w.run(
      order({
        trigger: { price: a('2980'), source: 'mark', role: 'stop_loss' },
        type: 'limit',
        timeInForce: 'GTC',
        price: a('3000'),
        amount: a('0.3'),
        clientOrderKey: 'order:trigger-trader:limit',
      }),
    );
    // The mark moving below 2997 does not fire the stop judged on the last trade (the last trade is still the open, 3001).
    w.sim.setMark(ETH, a('2989'));
    expect((await byKey(w, 'order:trigger-trader:last')).trigger!.state).toBe('waiting');
    // Another trader sells 3 ETH into the TEST bids, 2999 to 2997: the last trade is 2997 and the stop fires.
    const other = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet trigger other')));
    const otherAccount: UserVenueAccount = { venueId: w.sim.venue.id, owner: other.address.toLowerCase(), subAccount: null };
    w.sim.deposit(otherAccount, 'USDC', a('100000'), 'chain:trigger:other');
    const otherRun = async (intent: VenueIntent) => {
      const prepared = await w.sim.prepare(otherAccount, { role: 'owner', address: otherAccount.owner }, intent);
      const t = prepared.typedData as TestVenueTypedData;
      const signature = await other.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
      return w.sim.submit(prepared, { digest: prepared.digest, signature, signedBy: otherAccount.owner });
    };
    await otherRun({ kind: 'update_leverage', symbol: ETH, leverageBps: 50_000, marginMode: 'isolated' });
    await otherRun(order({ reduceOnly: false, amount: a('3'), price: a('2990'), clientOrderKey: 'order:trigger-other:sweep' }));
    expect(await byKey(w, 'order:trigger-trader:last')).toMatchObject({
      status: 'filled',
      filled: a('0.2'),
      trigger: { state: 'triggered' },
    });
    expect((await byKey(w, 'order:trigger-trader:limit')).trigger!.state).toBe('waiting');
    // The mark at 2980 fires the stop limit, which rests at its limit, 3000, above every bid, as a reduce-only order.
    w.sim.setMark(ETH, a('2980'));
    const limit = await byKey(w, 'order:trigger-trader:limit');
    expect(limit).toMatchObject({ status: 'open', trigger: { state: 'triggered' }, price: a('3000'), remaining: a('0.3'), filled: ZERO });
    expect((await w.sim.book(ETH, 10)).value.asks[0]).toMatchObject({ price: a('3000') });
  });

  it('#7 a triggered order that finds no one to fill it fails in the venue’s words, and the position stays as it was', async () => {
    const w = await long();
    await w.run(sl('2950', { clientOrderKey: 'order:trigger-trader:no-bids', price: a('2940') }));
    expect(await pullTestLadder(w.sim, ETH, 'bid')).toBe(5);
    w.sim.setMark(ETH, a('2950'));
    const failed = await byKey(w, 'order:trigger-trader:no-bids');
    expect(failed).toMatchObject({
      status: 'rejected',
      filled: ZERO,
      locked: ZERO,
      trigger: {
        state: 'failed',
        failure: 'no buy order rests at or above the worst price 2940 USDC, so the triggered order did not fill',
      },
    });
    expect(await position(w)).toMatchObject({ size: a('1'), side: 'long' });
    // The ladder rests again on a second seed.
    await seedTestVenue(w.sim);
    expect((await w.sim.book(ETH, 10)).value.bids).toHaveLength(5);
  });

  it('#4 a protection attached to an entry waits while the entry has filled nothing, then arms on what it filled', async () => {
    const w = world();
    await seedTestVenue(w.sim);
    w.sim.deposit(w.account, 'USDC', a('5000'), 'chain:trigger:d1');
    await w.run({ kind: 'update_leverage', symbol: ETH, leverageBps: 50_000, marginMode: 'isolated' });
    // A resting entry below the asks: nothing filled yet.
    await w.run(
      order({
        side: 'buy',
        reduceOnly: false,
        type: 'limit',
        timeInForce: 'GTC',
        price: a('2998'),
        amount: a('2'),
        clientOrderKey: 'order:trigger-trader:entry',
      }),
    );
    await w.run(
      tp('3100', { amount: a('2'), parentClientOrderKey: 'order:trigger-trader:entry', clientOrderKey: 'order:trigger-trader:child' }),
    );
    // Crossed while the entry has filled nothing: it waits.
    w.sim.setMark(ETH, a('3200'));
    expect(await byKey(w, 'order:trigger-trader:child')).toMatchObject({ status: 'open', amount: a('2'), trigger: { state: 'waiting' } });
    w.sim.setMark(ETH, a('3000'));
    // Another trader sells 0.5 into the entry: the protection arms on 0.5, and the mark above its price fires it for 0.5.
    const other = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet trigger seller')));
    const otherAccount: UserVenueAccount = { venueId: w.sim.venue.id, owner: other.address.toLowerCase(), subAccount: null };
    w.sim.deposit(otherAccount, 'USDC', a('100000'), 'chain:trigger:seller');
    const otherRun = async (intent: VenueIntent) => {
      const prepared = await w.sim.prepare(otherAccount, { role: 'owner', address: otherAccount.owner }, intent);
      const t = prepared.typedData as TestVenueTypedData;
      const signature = await other.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
      return w.sim.submit(prepared, { digest: prepared.digest, signature, signedBy: otherAccount.owner });
    };
    await otherRun({ kind: 'update_leverage', symbol: ETH, leverageBps: 50_000, marginMode: 'isolated' });
    // A sell IOC at 2998 meets the TEST bids at 2999 first (1 ETH), so it is priced to reach only the entry.
    await pullTestLadder(w.sim, ETH, 'bid');
    await otherRun(order({ reduceOnly: false, amount: a('0.5'), price: a('2998'), clientOrderKey: 'order:trigger-seller:hit' }));
    expect(await byKey(w, 'order:trigger-trader:entry')).toMatchObject({ filled: a('0.5') });
    // The protection is sized to the 0.5 filled and still waits for 3100 (the oracle mark is 3000; a fill does not move it).
    expect(await byKey(w, 'order:trigger-trader:child')).toMatchObject({ amount: a('0.5'), trigger: { state: 'waiting' } });
    await seedTestVenue(w.sim);
    w.sim.setMark(ETH, a('3100'));
    expect(await byKey(w, 'order:trigger-trader:child')).toMatchObject({ status: 'filled', filled: a('0.5') });
  });

  it('#8 a linked pair on part of the position: one leg fills, the venue cancels the other as linked, and the rest stays open', async () => {
    const w = await long();
    // An entry of 0.5 on top of the long 1, with a take profit and a stop loss attached to it.
    await w.run(order({ side: 'buy', reduceOnly: false, amount: a('0.5'), price: a('3010'), clientOrderKey: 'order:trigger-trader:e8' }));
    await w.run(
      tp('3100', { amount: a('0.5'), parentClientOrderKey: 'order:trigger-trader:e8', clientOrderKey: 'order:trigger-trader:tp8' }),
    );
    await w.run(
      sl('2950', {
        amount: a('0.5'),
        price: a('2850'),
        parentClientOrderKey: 'order:trigger-trader:e8',
        clientOrderKey: 'order:trigger-trader:sl8',
      }),
    );
    expect(await position(w)).toMatchObject({ side: 'long', size: a('1.5') });
    w.sim.setMark(ETH, a('2940'));
    expect(await byKey(w, 'order:trigger-trader:sl8')).toMatchObject({ status: 'filled', filled: a('0.5') });
    expect(await byKey(w, 'order:trigger-trader:tp8')).toMatchObject({ status: 'canceled', cancelReason: 'linked', locked: ZERO });
    expect(await position(w)).toMatchObject({ side: 'long', size: a('1') });
    // The cancelled leg never fires: the mark at its price closes nothing more.
    w.sim.setMark(ETH, a('3100'));
    expect(await fillsOf(w, 'order:trigger-trader:tp8')).toHaveLength(0);
    expect(await position(w)).toMatchObject({ side: 'long', size: a('1') });
  });

  it('a cancelled trigger order never fires, and its lock returns', async () => {
    const w = await long();
    await w.run(tp('3100', { clientOrderKey: 'order:trigger-trader:cancel-me' }));
    expect(await w.run({ kind: 'cancel_order', symbol: ETH, clientOrderKey: 'order:trigger-trader:cancel-me' })).toMatchObject({
      accepted: true,
    });
    w.sim.setMark(ETH, a('3100'));
    expect(await byKey(w, 'order:trigger-trader:cancel-me')).toMatchObject({ status: 'canceled', filled: ZERO, locked: ZERO });
    expect(await position(w)).toMatchObject({ size: a('1') });
  });

  it('crossed: a take profit fires in the position’s favour, a stop loss against it, on either side', () => {
    const t = { price: a('100'), source: 'mark' as const, role: 'take_profit' as const };
    const s = { ...t, role: 'stop_loss' as const };
    expect([crossed('sell', t, a('100')), crossed('sell', t, a('99')), crossed('buy', t, a('100')), crossed('buy', t, a('101'))]).toEqual([
      true,
      false,
      true,
      false,
    ]);
    expect([crossed('sell', s, a('100')), crossed('sell', s, a('101')), crossed('buy', s, a('100')), crossed('buy', s, a('99'))]).toEqual([
      true,
      false,
      true,
      false,
    ]);
  });
});
