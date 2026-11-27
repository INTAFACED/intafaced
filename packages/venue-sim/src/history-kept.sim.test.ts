import { describe, expect, it } from 'vitest';
import { keccak256, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseAmount } from '@intafaced/ledger-client/money';
import {
  decodeVenueWire,
  encodeVenueWire,
  type PreparedVenueAction,
  type UserVenueAccount,
  type VenueIntent,
} from '@intafaced/venue-contracts';
import { TestVenueSimulator } from './simulator.js';
import { answerTestVenue, seedTestVenue, TEST_VENUE_MARKETS } from './http-server.js';
import type { TestVenueTypedData } from './signing.js';

/**
 * J-portfolio-18 at the venue: the TEST perpetual XJRN-PERP whose trades fill a journal, and `/test/history-kept`, the
 * TEST venue keeping a market's fills and candles only from a time on, as a venue keeps a bounded history. Every figure
 * is TEST.
 */
const a = parseAmount;
const XJRN = 'XJRN-PERP';

describe('the TEST venue keeps a bounded history (J-portfolio-18 #3 #7)', () => {
  it('drops one market’s fills and candles before a time, for every account; other markets and null keep all', async () => {
    let now = Date.UTC(2026, 10, 28, 10, 0, 0);
    const sim = new TestVenueSimulator({ clock: () => new Date(now), markets: TEST_VENUE_MARKETS });
    await seedTestVenue(sim);
    const key = privateKeyToAccount(keccak256(toHex('intafaced TEST wallet history kept')));
    const owner = key.address.toLowerCase();
    const account: UserVenueAccount = { venueId: sim.venue.id, owner, subAccount: null };
    sim.deposit(account, 'USDC', a('100000'), 'chain:history:1');
    const run = async (intent: VenueIntent) => {
      const prepared: PreparedVenueAction = await sim.prepare(account, { role: 'owner', address: owner }, intent);
      const t = prepared.typedData as TestVenueTypedData;
      const signature = await key.signTypedData({ domain: t.domain, types: t.types, primaryType: t.primaryType, message: t.message });
      return sim.submit(prepared, { digest: prepared.digest, signature, signedBy: owner });
    };
    const buy = (symbol: string, price: string, n: number): VenueIntent => ({
      kind: 'place_order',
      symbol,
      side: 'buy',
      type: 'limit',
      amount: a('0.1'),
      price: a(price),
      timeInForce: 'IOC',
      reduceOnly: false,
      clientOrderKey: `order:history:${symbol}:${n}`,
      builderFee: null,
    });
    for (const symbol of [XJRN, 'BTC-PERP'])
      expect(await run({ kind: 'update_leverage', symbol, leverageBps: 100_000, marginMode: 'isolated' })).toMatchObject({
        accepted: true,
      });
    expect(await run(buy(XJRN, '101', 1))).toMatchObject({ accepted: true, order: { status: 'filled' } });
    expect(await run(buy('BTC-PERP', '60100', 1))).toMatchObject({ accepted: true, order: { status: 'filled' } });
    now += 120_000;
    const cut = new Date(now);
    expect(await run(buy(XJRN, '101', 2))).toMatchObject({ accepted: true, order: { status: 'filled' } });

    const fillsOf = async () => (await sim.fills(account, new Date(0))).value.map((f) => f.symbol);
    const candlesOf = async (symbol: string) => (await sim.candles(symbol, '1m', 720)).value.map((c) => c.openAt.getTime());
    expect(await fillsOf()).toEqual([XJRN, 'BTC-PERP', XJRN]);
    expect((await candlesOf(XJRN)).length).toBe(2);

    const call = async (body: unknown) => {
      const [status, out] = await answerTestVenue(sim, 'POST', '/test/history-kept', JSON.stringify(encodeVenueWire(body)));
      return { status, out: decodeVenueWire<Record<string, unknown>>(out) };
    };
    expect(await call({ symbol: XJRN, candlesFrom: cut.toISOString() })).toMatchObject({ status: 200, out: { label: 'TEST' } });
    expect(await fillsOf()).toEqual([XJRN, 'BTC-PERP', XJRN]);
    expect(await candlesOf(XJRN)).toEqual([cut.getTime()]);
    await call({ symbol: XJRN, fillsFrom: cut.toISOString() });
    expect(await fillsOf()).toEqual(['BTC-PERP', XJRN]);
    expect((await candlesOf('BTC-PERP')).length).toBe(1);
    await call({ symbol: XJRN, fillsFrom: null, candlesFrom: null });
    expect(await fillsOf()).toEqual([XJRN, 'BTC-PERP', XJRN]);
    expect((await candlesOf(XJRN)).length).toBe(2);
    expect((await call({ symbol: 'NOPE-PERP', fillsFrom: null })).status).not.toBe(200);
  });
});
