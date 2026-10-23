import { describe, expect, it } from 'vitest';
import { watchlistsStoredSchema, refusalCode } from './store';

const stored = {
  namespace: 'trade.watchlists',
  version: 3,
  outcome: 'stored',
  value: [
    {
      id: 'majors',
      name: 'Majors',
      flag: null,
      sections: [{ id: 'main', title: 'Main', collapsed: false, symbols: ['BTC/USDT', 'ETH/USDT'] }],
    },
  ],
};

describe('watchlistsStoredSchema', () => {
  it('parses a real set reply: the record plus the stored outcome', () => {
    const parsed = watchlistsStoredSchema.safeParse(stored);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.version).toBe(3);
  });

  it('refuses a set reply with another outcome', () => {
    expect(watchlistsStoredSchema.safeParse({ ...stored, outcome: 'queued' }).success).toBe(false);
  });

  it('accepts a cleared record (value null) on a set reply', () => {
    expect(watchlistsStoredSchema.safeParse({ ...stored, value: null }).success).toBe(true);
  });
});

describe('refusalCode', () => {
  it('returns the identity code the service sent', () => {
    expect(refusalCode('identity.watchlist_cap_exceeded: over the cap')).toBe('identity.watchlist_cap_exceeded');
  });

  it('returns a version conflict as its own code', () => {
    expect(refusalCode('preferences.version_conflict')).toBe('preferences.version_conflict');
  });

  it('falls back to not-saved when no code is named', () => {
    expect(refusalCode('network down')).toBe('not-saved');
    expect(refusalCode(undefined)).toBe('not-saved');
  });
});
