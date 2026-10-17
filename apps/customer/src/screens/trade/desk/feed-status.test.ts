import { describe, expect, it } from 'vitest';
import { overall, staleAfterMs, streamOf } from './feed-status';
import type { Loadable } from './deps';

const ready = (asOf: number): Loadable<unknown> => ({ status: 'ready', data: [], asOf });
const base = { now: 100_000, intervalMs: 2_000 };

describe('data status per stream', () => {
  it('calls a stream old after two missed polling intervals, so one failed read shows before the data layer gives up', () => {
    expect(staleAfterMs(2_000)).toBe(5_000);
    expect(staleAfterMs(10_000)).toBe(21_000);
  });
  it('fresh, old, down, loading and signed out are different states', () => {
    expect(streamOf('book', ready(99_000), base)).toEqual({ id: 'book', state: 'ok', ageSeconds: 1 });
    expect(streamOf('book', ready(80_000), base)).toEqual({ id: 'book', state: 'old', ageSeconds: 20 });
    expect(streamOf('book', ready(95_001), base).state).toBe('ok');
    expect(streamOf('book', ready(94_999), base).state).toBe('old');
    expect(streamOf('book', { status: 'error', retry: () => undefined }, base).state).toBe('down');
    expect(streamOf('book', { status: 'refused', code: 'trade.matching_unavailable' }, base).state).toBe('down');
    expect(streamOf('book', { status: 'loading' }, base).state).toBe('loading');
    expect(streamOf('orders', { status: 'refused', code: 'auth.required' }, { ...base, signedIn: false, privateRead: true }).state).toBe(
      'off',
    );
  });
  it('judges the book by the time the service stamped it as well as by when it was last read', () => {
    expect(streamOf('book', ready(99_000), { ...base, stampedAt: 70_000, stampStaleMs: 15_000 })).toEqual({
      id: 'book',
      state: 'old',
      ageSeconds: 30,
    });
    expect(streamOf('book', ready(99_000), { ...base, stampedAt: 90_000, stampStaleMs: 15_000 }).state).toBe('ok');
  });
  it('signed-out private streams are off, not a failure', () => {
    const stream = streamOf('balances', { status: 'loading' }, { ...base, signedIn: false, privateRead: true });
    expect(stream.state).toBe('off');
    expect(overall([stream])).toBe('ok');
  });
  it('one failed stream makes the whole chip a problem even when the others are fresh', () => {
    const streams = [
      streamOf('book', ready(99_500), base),
      streamOf('orders', { status: 'error', retry: () => undefined }, { ...base, signedIn: true, privateRead: true }),
    ];
    expect(overall(streams)).toBe('problem');
  });
  it('an old stream is delayed, and a problem outranks delayed', () => {
    const old = streamOf('book', ready(10_000), base);
    expect(overall([old])).toBe('delayed');
    expect(overall([old, { id: 'ticker', state: 'down', ageSeconds: null }])).toBe('problem');
  });
});
