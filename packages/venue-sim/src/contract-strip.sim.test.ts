import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client/money';
import { TestVenueSimulator } from './simulator.js';
import { TEST_VENUE_MARKETS } from './http-server.js';

// J-derivatives-01 #4: the contract strip's contract size, mark and funding are the venue's own, published on
// `markets()`; a figure the venue does not publish is not known, never zero.
const a = parseAmount;

function world(at: Date) {
  let now = at;
  const sim = new TestVenueSimulator({ clock: () => now, markets: TEST_VENUE_MARKETS });
  const market = async (symbol: string) => (await sim.markets(null)).value.find((m) => m.symbol === symbol)!;
  return { sim, market, setNow: (d: Date) => (now = d) };
}

describe('the TEST venue publishes the contract strip', () => {
  it('BTC-PERP: one BTC per contract, the mark as the venue moves it, and its TEST hourly funding with the next whole hour', async () => {
    const { sim, market, setNow } = world(new Date('2026-11-12T10:20:30.000Z'));
    const btc = await market('BTC-PERP');
    expect(btc.contractSize).toEqual({ known: true, value: a('1') });
    expect(btc.mark).toEqual({ known: true, value: a('60000') });
    expect(btc.funding).toEqual({
      known: true,
      value: { rate: a('0.0000125'), intervalSeconds: 3600, nextFundingAt: new Date('2026-11-12T11:00:00.000Z') },
    });
    sim.setMark('BTC-PERP', a('60123.5'));
    expect((await market('BTC-PERP')).mark).toEqual({ known: true, value: a('60123.5') });
    // On a whole hour the next settlement is the hour after, never now.
    setNow(new Date('2026-11-12T11:00:00.000Z'));
    const next = (await market('BTC-PERP')).funding;
    expect(next.known && next.value.nextFundingAt.toISOString()).toBe('2026-11-12T12:00:00.000Z');
  });

  it('a perpetual with no published funding reads not known, and a spot market has no mark, size or funding', async () => {
    const { market } = world(new Date('2026-11-12T10:00:00.000Z'));
    const gold = await market('XAU-PERP');
    expect(gold.funding).toEqual({ known: false });
    expect(gold.mark).toEqual({ known: true, value: a('2650') });
    const spot = await market('BTC-USDC');
    expect([spot.contractSize, spot.mark, spot.funding]).toEqual([{ known: false }, { known: false }, { known: false }]);
  });
});

// J-charts-desk-04 #6: the funding the TEST venue published at each settled interval, read by a chart's funding study.
describe('the TEST venue publishes its funding history', () => {
  it('BTC-PERP: its TEST rate at every settled whole hour since `since`, oldest first, never a future one', async () => {
    const { sim } = world(new Date('2026-11-12T10:20:30.000Z'));
    const read = await sim.fundingHistory('BTC-PERP', new Date('2026-11-12T07:30:00.000Z'));
    expect(read.value).toEqual([
      { fundingAt: new Date('2026-11-12T08:00:00.000Z'), rate: a('0.0000125') },
      { fundingAt: new Date('2026-11-12T09:00:00.000Z'), rate: a('0.0000125') },
      { fundingAt: new Date('2026-11-12T10:00:00.000Z'), rate: a('0.0000125') },
    ]);
    expect(read.asOf).toEqual(new Date('2026-11-12T10:20:30.000Z'));
  });

  it('reaches back one day at most, however early `since` is', async () => {
    const { sim } = world(new Date('2026-11-12T10:00:00.000Z'));
    const rows = (await sim.fundingHistory('BTC-PERP', new Date('2026-11-01T00:00:00.000Z'))).value;
    expect(rows).toHaveLength(25);
    expect(rows[0]!.fundingAt).toEqual(new Date('2026-11-11T10:00:00.000Z'));
    expect(rows.at(-1)!.fundingAt).toEqual(new Date('2026-11-12T10:00:00.000Z'));
  });

  it('a perpetual with no published funding and a spot market refuse not_offered; an unlisted symbol unknown_market', async () => {
    const { sim } = world(new Date('2026-11-12T10:00:00.000Z'));
    const since = new Date('2026-11-12T00:00:00.000Z');
    await expect(sim.fundingHistory('XAU-PERP', since)).rejects.toMatchObject({ refusal: { code: 'not_offered' } });
    await expect(sim.fundingHistory('BTC-USDC', since)).rejects.toMatchObject({ refusal: { code: 'not_offered' } });
    await expect(sim.fundingHistory('NOPE-PERP', since)).rejects.toMatchObject({ refusal: { code: 'unknown_market' } });
  });
});
