import { describe, expect, it } from 'vitest';
import { parseBuilderFeeRecon, reconPeriod } from './builder-fee-recon-parse';

const line = {
  fillId: 'f1',
  userId: 'u1',
  assetId: 'USDC',
  venueAmount: '0.25',
  ledgerAmount: null,
  filledAt: '2026-11-09T10:00:00.000Z',
  status: 'not_in_ledger',
  refusalCode: null,
};
const venue = {
  state: 'read',
  venueId: 'test-venue-sim',
  displayName: 'TEST venue',
  test: true,
  asOf: '2026-11-09T10:00:01.000Z',
  matched: false,
  totals: [{ assetId: 'USDC', venueTotal: '0.25', ledgerTotal: '0', matched: false }],
  lines: [line],
};
const recon = { from: '2026-11-02T10:00:00.000Z', to: '2026-11-09T10:00:00.000Z', periodOpen: false, venues: [venue] };

describe('parseBuilderFeeRecon', () => {
  it('reads a recon with a break, keeping amounts as decimal strings', () => {
    expect(parseBuilderFeeRecon(recon)?.venues[0]).toMatchObject({ state: 'read', matched: false, lines: [{ status: 'not_in_ledger', venueAmount: '0.25' }] });
  });
  it('reads an unknown venue', () => {
    const unknown = { state: 'unknown', venueId: null, displayName: null, code: 'venue.venue_down', message: 'down' };
    expect(parseBuilderFeeRecon({ ...recon, venues: [unknown] })?.venues[0]).toMatchObject({ state: 'unknown', code: 'venue.venue_down' });
  });
  it('refuses the whole answer when one field is wrong: a number amount, an unknown status, a missing total', () => {
    expect(parseBuilderFeeRecon({ ...recon, venues: [{ ...venue, lines: [{ ...line, venueAmount: 0.25 }] }] })).toBeNull();
    expect(parseBuilderFeeRecon({ ...recon, venues: [{ ...venue, lines: [{ ...line, status: 'fine' }] }] })).toBeNull();
    expect(parseBuilderFeeRecon({ ...recon, venues: [{ ...venue, totals: [{ assetId: 'USDC' }] }] })).toBeNull();
  });
});

describe('reconPeriod', () => {
  const now = new Date('2026-11-09T10:00:00.000Z');
  it('takes a given ISO period, else the last 7 days to now', () => {
    expect(reconPeriod('2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z', now)).toEqual({
      from: '2026-11-01T00:00:00.000Z',
      to: '2026-11-02T00:00:00.000Z',
    });
    expect(reconPeriod('yesterday', undefined, now)).toEqual({ from: '2026-11-02T10:00:00.000Z', to: '2026-11-09T10:00:00.000Z' });
  });
});
