import { describe, expect, it } from 'vitest';
import { appendPage, dayStart, NO_PARAMS, readParams, toQuery, writeParams } from './history-query';

describe('order history address', () => {
  it('reads and writes the filters, leaving the defaults out', () => {
    const params = readParams('?side=buy&status=canceled&from=2026-10-01&to=2026-10-02&size=50');
    expect(params).toEqual({ side: 'buy', status: 'canceled', type: '', from: '2026-10-01', to: '2026-10-02', size: 50 });
    expect(writeParams(params)).toBe('?side=buy&status=canceled&from=2026-10-01&to=2026-10-02&size=50');
    expect(writeParams(NO_PARAMS)).toBe('');
    expect(readParams('?size=7').size).toBe(20);
  });

  it('keeps a mistyped side or state as written, so the service refuses it', () => {
    const outcome = toQuery(readParams('?side=bye&status=gone'));
    expect(outcome).toEqual({ ok: true, query: { limit: 20, side: 'bye', status: 'gone' } });
  });

  it('turns days into the person’s own midnight, the end day included', () => {
    const outcome = toQuery({ ...NO_PARAMS, from: '2026-10-01', to: '2026-10-01' }, 'last-id');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.query.since).toBe(new Date(2026, 9, 1).getTime());
    expect(outcome.query.until).toBe(new Date(2026, 9, 2).getTime() - 1);
    expect(outcome.query.before).toBe('last-id');
  });

  it('refuses a day that is not a day, and an end before the start', () => {
    expect(dayStart('2026-02-30')).toBeNull();
    expect(toQuery({ ...NO_PARAMS, from: '2026-13-01' })).toEqual({ ok: false, problem: 'from' });
    expect(toQuery({ ...NO_PARAMS, to: 'yesterday' })).toEqual({ ok: false, problem: 'to' });
    expect(toQuery({ ...NO_PARAMS, from: '2026-10-02', to: '2026-10-01' })).toEqual({ ok: false, problem: 'range' });
  });

  it('adds a page without showing an order twice', () => {
    const { rows, repeated } = appendPage([{ id: 'a' }, { id: 'b' }], [{ id: 'b' }, { id: 'c' }]);
    expect(rows.map((row) => row.id)).toEqual(['a', 'b', 'c']);
    expect(repeated).toBe(1);
  });
});
