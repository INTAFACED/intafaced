import { describe, expect, it } from 'vitest';
import { heldFigure, heldFigureWire } from './held-figure.js';

const now = new Date('2026-11-10T12:00:00.000Z');
const limit = 60_000;
const read = (over: Partial<Parameters<typeof heldFigure>[0]> = {}) =>
  heldFigure({ source: 'TEST partner bank', amount: '12.50', asOf: new Date(now.getTime() - 1_000), staleAfterMs: limit, now, ...over });

describe('heldFigure: the displayed-figure contract', () => {
  it('a figure the source reported with its own time, inside its limit, is known, with the source string untouched', () => {
    const f = read();
    expect(f).toEqual({
      state: 'known',
      source: 'TEST partner bank',
      amount: '12.50',
      asOf: new Date('2026-11-10T11:59:59.000Z'),
      staleAfterMs: limit,
    });
  });

  it('exactly at the limit is still known; one millisecond past it is stale, and still shows the amount', () => {
    expect(read({ asOf: new Date(now.getTime() - limit) }).state).toBe('known');
    const stale = read({ asOf: new Date(now.getTime() - limit - 1) });
    expect(stale.state).toBe('stale');
    expect(stale.amount).toBe('12.50');
  });

  it('a figure the source sent with no time is unknown (no_as_of), never known at our read time', () => {
    const f = read({ asOf: null });
    expect(f).toMatchObject({ state: 'unknown', amount: null, asOf: null, reason: 'no_as_of' });
  });

  it('a figure the source has not reported is unknown (not_reported), never zero', () => {
    expect(read({ amount: null })).toMatchObject({ state: 'unknown', amount: null, reason: 'not_reported' });
  });

  it('a source not answering with nothing earlier is unknown (source_unavailable)', () => {
    expect(read({ amount: null, asOf: null, unavailable: true })).toMatchObject({ state: 'unknown', reason: 'source_unavailable' });
  });

  it('an amount that is not a decimal string is unknown (malformed), never parsed', () => {
    for (const amount of ['1e3', '12.', '', 'NaN', '1,000', '0.0000000000000000001']) {
      expect(read({ amount }).state).toBe('unknown');
      expect(read({ amount })).toMatchObject({ reason: 'malformed' });
    }
  });

  it('a time ahead of our clock by more than the limit is unknown (as_of_ahead); within the limit is known', () => {
    expect(read({ asOf: new Date(now.getTime() + limit + 1) })).toMatchObject({ state: 'unknown', reason: 'as_of_ahead' });
    expect(read({ asOf: new Date(now.getTime() + limit) }).state).toBe('known');
  });

  it('a source that declares no limit, or an invalid time, throws: no silent default', () => {
    for (const staleAfterMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      expect(() => read({ staleAfterMs })).toThrow(/staleness limit/);
    }
    expect(() => read({ asOf: new Date('nope') })).toThrow(/not a time/);
  });

  it('on the wire, times are ISO strings and a known figure carries reason null', () => {
    expect(heldFigureWire(read())).toEqual({
      state: 'known',
      source: 'TEST partner bank',
      amount: '12.50',
      asOf: '2026-11-10T11:59:59.000Z',
      staleAfterMs: limit,
      reason: null,
    });
    expect(heldFigureWire(read({ asOf: null }))).toEqual({
      state: 'unknown',
      source: 'TEST partner bank',
      amount: null,
      asOf: null,
      staleAfterMs: limit,
      reason: 'no_as_of',
    });
  });
});
