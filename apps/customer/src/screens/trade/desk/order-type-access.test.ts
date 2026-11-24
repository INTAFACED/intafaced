import { describe, expect, it } from 'vitest';
import { refusedTypes } from './order-type-access';

const NOW = Date.parse('2026-11-24T00:00:00Z');
const open = { state: 'OPEN', openingWindowEndsAt: null, zone: null } as const;

describe('refusedTypes (J-cex-spot-04 #1)', () => {
  it('an open market and an ordinary account refuse no ticket type', () => {
    expect([...refusedTypes(open, { lead: undefined }, NOW)]).toEqual([]);
    expect([...refusedTypes({ ...open, state: null }, { lead: false }, NOW)]).toEqual([]);
  });

  it('limit-only refuses a market order only, as svc-trade does', () => {
    expect([...refusedTypes({ ...open, state: 'LIMIT_ONLY' }, { lead: undefined }, NOW)]).toEqual([['market', 'Type reason limit only']]);
  });

  it('an opening window refuses market and both stops until it ends, and nothing after', () => {
    const windowed = { ...open, openingWindowEndsAt: NOW + 60_000 };
    expect([...refusedTypes(windowed, { lead: undefined }, NOW)]).toEqual([
      ['market', 'Type reason opening window'],
      ['stop_limit', 'Type reason opening window'],
      ['stop_market', 'Type reason opening window'],
    ]);
    expect([...refusedTypes(windowed, { lead: undefined }, NOW + 60_000)]).toEqual([]);
  });

  it('the higher-risk zone refuses market and both stops', () => {
    expect([...refusedTypes({ ...open, zone: 'higher_risk' }, { lead: undefined }, NOW)].map(([k, r]) => `${k} ${r}`)).toEqual([
      'market Type reason zone',
      'stop_limit Type reason zone',
      'stop_market Type reason zone',
    ]);
  });

  it('a lead trade refuses the types with no price; one reason per type, the market rule first', () => {
    expect([...refusedTypes(open, { lead: true }, NOW)]).toEqual([
      ['market', 'Type reason lead'],
      ['stop_market', 'Type reason lead'],
    ]);
    expect(refusedTypes({ ...open, state: 'LIMIT_ONLY' }, { lead: true }, NOW).get('market')).toBe('Type reason limit only');
  });

  it('never refuses a limit order', () => {
    const all = refusedTypes({ state: 'LIMIT_ONLY', openingWindowEndsAt: NOW + 1, zone: 'higher_risk' }, { lead: true }, NOW);
    expect(all.has('limit')).toBe(false);
  });
});
