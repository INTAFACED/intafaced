import { describe, expect, it } from 'vitest';
import { parseAmount } from '@intafaced/ledger-client/money';
import { venueBalanceFigures, venueFigure, venuePositionFigures } from './venue-figure.js';

const now = new Date('2026-11-10T12:00:00.000Z');
const venue = { displayName: 'TEST venue simulator', figureStaleAfterMs: 60_000 };
const at = (msAgo: number) => new Date(now.getTime() - msAgo);

describe('venueFigure: the venue side of the displayed-figure contract (b2 change 6)', () => {
  it("a read with the venue's own time inside its limit is known, with the venue's figure as its own decimal string", () => {
    expect(venueFigure(venue, parseAmount('12.50'), { reportedAt: at(1_000) }, now)).toEqual({
      state: 'known',
      source: 'TEST venue simulator',
      amount: '12.5',
      asOf: at(1_000),
      staleAfterMs: 60_000,
    });
  });

  it("past the venue's own limit it is stale, still with its amount", () => {
    expect(venueFigure(venue, parseAmount('3'), { reportedAt: at(60_001) }, now)).toMatchObject({ state: 'stale', amount: '3' });
  });

  it('a read the venue sent with no time, or from an adapter that has not said, is unknown, never known at our read time', () => {
    for (const read of [{ reportedAt: null }, {}]) {
      expect(venueFigure(venue, parseAmount('3'), read, now)).toMatchObject({ state: 'unknown', amount: null, reason: 'no_as_of' });
    }
  });

  it('a venue that declares no staleness limit is refused: no silent default', () => {
    expect(() => venueFigure({ displayName: 'x' }, parseAmount('1'), { reportedAt: now }, now)).toThrow(/staleness limit/);
  });

  it('every balance and position figure is one, on the wire with ISO times', () => {
    const read = { venueId: 'v', asOf: now, reportedAt: at(5_000) };
    const [b] = venueBalanceFigures(
      venue,
      { ...read, value: [{ asset: 'USDC', free: parseAmount('1'), locked: parseAmount('0'), total: parseAmount('1') }] },
      now,
    );
    expect(b).toMatchObject({
      asset: 'USDC',
      free: { state: 'known', amount: '1', asOf: at(5_000).toISOString() },
      locked: { amount: '0' },
    });
    const [p] = venuePositionFigures(
      venue,
      {
        ...read,
        reportedAt: null,
        value: [
          {
            symbol: 'BTC-PERP',
            side: 'long',
            size: parseAmount('0.1'),
            entryPrice: parseAmount('60000'),
            markPrice: parseAmount('60100'),
            unrealisedPnl: parseAmount('10'),
            marginMode: 'cross',
            margin: parseAmount('600'),
            leverageBps: 100_000,
            liquidationPrice: { known: false },
          },
        ],
      },
      now,
    );
    for (const k of ['size', 'entryPrice', 'markPrice', 'unrealisedPnl', 'margin'] as const) {
      expect(p![k], k).toMatchObject({ state: 'unknown', amount: null, reason: 'no_as_of' });
    }
  });
});
