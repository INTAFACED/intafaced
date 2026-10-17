import { describe, expect, it } from 'vitest';
import { isSeparateFromSpot, opensLabel, rowStatus, toStatusMap } from './listing-status';

const rows = [
  { symbol: 'BTC/USDT', sessionOpen: true, nextSessionChange: null, degrade: null },
  {
    symbol: 'EUR/USD',
    sessionOpen: false,
    nextSessionChange: { open: true, timestamp: 1_700_000_000_000 },
    degrade: { separateFromSpot: true },
  },
  { symbol: 'XAU/USD', sessionOpen: false, nextSessionChange: { open: false, timestamp: 5 } },
  { symbol: 'ETH/USDT' },
];

describe('toStatusMap', () => {
  const map = toStatusMap(rows);
  it('reads the group, the session and when it opens', () => {
    expect(map['EUR/USD']).toEqual({ separateFromSpot: true, sessionOpen: false, opensAt: 1_700_000_000_000 });
    expect(map['BTC/USDT']).toEqual({ separateFromSpot: false, sessionOpen: true, opensAt: null });
    expect(map['XAU/USD']?.opensAt).toBeNull();
    expect(map['ETH/USDT']).toEqual({ separateFromSpot: false, sessionOpen: null, opensAt: null });
  });
  it('keeps FX pairs out of Spot, and everything in when the read failed', () => {
    expect(isSeparateFromSpot(map, 'EUR/USD')).toBe(true);
    expect(isSeparateFromSpot(map, 'BTC/USDT')).toBe(false);
    expect(isSeparateFromSpot(null, 'EUR/USD')).toBe(false);
  });
});

describe('rowStatus', () => {
  const map = toStatusMap(rows);
  it('is Open for an orderable market', () => expect(rowStatus(true, map['EUR/USD'])).toEqual({ kind: 'open' }));
  it('is Closed with the opening time when the session is shut', () =>
    expect(rowStatus(false, map['EUR/USD'])).toEqual({ kind: 'closed', opensAt: 1_700_000_000_000 }));
  it('is Paused when the session is not the reason or the read is missing', () => {
    expect(rowStatus(false, map['BTC/USDT'])).toEqual({ kind: 'paused' });
    expect(rowStatus(false, undefined)).toEqual({ kind: 'paused' });
  });
});

describe('opensLabel', () => {
  it('names the zone when it is not the device', () => {
    expect(opensLabel(1_700_000_000_000, 'UTC')).toBe('Tue 10:13 PM UTC');
  });
});
