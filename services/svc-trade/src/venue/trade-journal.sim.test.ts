import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { add, div, formatAmount, max, min, mul, parseAmount, sub, sum } from '@intafaced/ledger-client/money';
import { tradeJournalSchema } from '@intafaced/contracts/trade-journal-procedures';
import type { PlaceUserOrderIntent, UserVenueAccount, VenueIntent } from '@intafaced/venue-contracts';
import { seedTestVenue, TEST_VENUE_MARKETS, TestVenueSimulator, type TestVenueTypedData } from '@intafaced/venue-sim';
import { readTradeJournal } from './trade-journal.js';

/**
 * A ROUND TRIP ON THE TEST VENUE, JOURNALLED: open a long on the TEST perpetual ETH-PERP, set a stop loss and a
 * take profit, close it, and read the journal over the venue's own fills, order history and candles. Every figure is
 * TEST, and each is checked against the venue's own records, not against the journal's code.
 */
const a = parseAmount;
const ETH = 'ETH-PERP';

describe('trade journal on the TEST venue', { timeout: 60_000 }, () => {
  it('a round trip comes back with every field, its MAE and MFE matching the venue candles of its window', async () => {
    let now = Date.UTC(2026, 10, 20, 8, 0, 0);
    const clock = () => new Date((now += 1000));
    const sim = new TestVenueSimulator({ clock, markets: TEST_VENUE_MARKETS, chainId: 84532 });
    const key = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet journal trader')));
    const owner = key.address.toLowerCase();
    const account: UserVenueAccount = { venueId: sim.venue.id, owner, subAccount: null };
    const run = async (intent: VenueIntent) => {
      const prepared = await sim.prepare(account, { role: 'owner', address: owner }, intent);
      const t = prepared.typedData as TestVenueTypedData;
      const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
      return sim.submit(prepared, { digest: prepared.digest, signature, signedBy: owner });
    };
    const order = (over: Partial<PlaceUserOrderIntent>): PlaceUserOrderIntent => ({
      kind: 'place_order',
      symbol: ETH,
      side: 'buy',
      type: 'market',
      amount: a('1'),
      price: a('3010'),
      timeInForce: 'IOC',
      reduceOnly: false,
      clientOrderKey: 'order:journal:open',
      builderFee: null,
      ...over,
    });

    await seedTestVenue(sim);
    sim.deposit(account, 'USDC', a('5000'), 'chain:journal:d1');
    expect(await run({ kind: 'update_leverage', symbol: ETH, leverageBps: 50_000, marginMode: 'isolated' })).toMatchObject({
      accepted: true,
    });
    const since = new Date(now);
    expect(await run(order({}))).toMatchObject({ accepted: true, order: { status: 'filled' } });
    const sl = { price: a('2950'), source: 'mark' as const, role: 'stop_loss' as const };
    const tp = { price: a('3100'), source: 'mark' as const, role: 'take_profit' as const };
    for (const [trigger, k] of [
      [sl, 'sl'],
      [tp, 'tp'],
    ] as const)
      expect(
        await run(order({ side: 'sell', reduceOnly: true, price: a('2900'), trigger, clientOrderKey: `order:journal:${k}` })),
      ).toMatchObject({ accepted: true });
    expect(await run(order({ side: 'sell', reduceOnly: true, price: a('2900'), clientOrderKey: 'order:journal:close' }))).toMatchObject({
      accepted: true,
      order: { status: 'filled' },
    });

    const journal = tradeJournalSchema.parse(
      await readTradeJournal(
        { venue: async () => sim, account: async () => account, now: () => new Date(now) },
        { owner, since: since.toISOString(), limit: 10 },
      ),
    );
    expect(journal.venue.test).toBe(true);
    expect(journal.trades).toHaveLength(1);
    const t = journal.trades[0]!;
    console.info(JSON.stringify(t));

    // The venue's own fills for the trade.
    const fills = (await sim.fills(account, since)).value.filter((f) => f.symbol === ETH);
    const buys = fills.filter((f) => f.side === 'buy');
    const sells = fills.filter((f) => f.side === 'sell');
    expect(buys.length).toBeGreaterThan(0);
    expect(sells.length).toBeGreaterThan(0);
    const entry = div(sum(buys.map((f) => mul(f.price, f.amount))), sum(buys.map((f) => f.amount)));
    const fees = sum(fills.map((f) => add(f.venueFee, f.builderFee)));
    const gross = sub(sum(sells.map((f) => mul(f.price, f.amount))), sum(buys.map((f) => mul(f.price, f.amount))));
    expect(t).toMatchObject({
      symbol: ETH,
      side: 'long',
      entryPrice: formatAmount(entry),
      size: '1',
      fees: formatAmount(fees),
      grossPnl: formatAmount(gross),
      netPnl: formatAmount(sub(gross, fees)),
      plannedStop: '2950',
      plannedTarget: '3100',
      candleInterval: '1m',
    });
    expect(t.rMultiple).not.toBeNull();

    // MAE and MFE: the venue's 1m candles overlapping the trade's window, with the trade's own fill prices.
    const candles = (await sim.candles!(ETH, '1m', { limit: 720, since: new Date(Math.floor(since.getTime() / 60_000) * 60_000) })).value;
    const opened = new Date(t.openedAt).getTime();
    const closed = new Date(t.closedAt).getTime();
    const window = candles.filter((c) => c.openAt.getTime() + 60_000 > opened && c.openAt.getTime() <= closed);
    expect(window.length).toBeGreaterThan(0);
    const low = [...window.map((c) => c.lowPrice), ...fills.map((f) => f.price)].reduce(min);
    const high = [...window.map((c) => c.highPrice), ...fills.map((f) => f.price)].reduce(max);
    expect([t.maePrice, t.mfePrice]).toEqual([formatAmount(low), formatAmount(high)]);
    expect(t.mae).toBe(formatAmount(max(a('0'), sub(entry, low))));
    expect(t.mfe).toBe(formatAmount(max(a('0'), sub(high, entry))));
  });
});
