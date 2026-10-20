import { describe, expect, it } from 'vitest';
import type { ConvertHistoryRow } from '../../../features/trade/tool-api';
import { RECENT_FETCH, RECENT_SHOWN, RECENT_WINDOW_DAYS, recentAt, recentRows, recentWindow } from './recent';

// TEST DATA written for these tests. None of it is a real conversion.
let n = 0;
const row = (over: Partial<ConvertHistoryRow>): ConvertHistoryRow => ({
  quoteId: `q${++n}`,
  inAsset: 'USDT',
  outAsset: 'BTC',
  inAmount: '10',
  outAmount: '0.0001',
  lifecycle: 'settled',
  createdAt: '2026-10-19T10:00:00.000Z',
  expiresAt: '2026-10-19T10:00:15.000Z',
  acceptedAt: '2026-10-19T10:00:05.000Z',
  settledAt: '2026-10-19T10:00:06.000Z',
  ...over,
});

describe('recentWindow', () => {
  it('asks for the last 30 days, inside the 92 days the service allows, with a limit (the service refuses without one)', () => {
    const now = Date.parse('2026-10-20T00:00:00.000Z');
    const w = recentWindow(now);
    expect(w.to).toBe('2026-10-20T00:00:00.000Z');
    expect(w.from).toBe('2026-09-20T00:00:00.000Z');
    expect((Date.parse(w.to) - Date.parse(w.from)) / 86_400_000).toBe(RECENT_WINDOW_DAYS);
    expect(w.limit).toBe(RECENT_FETCH);
    expect(RECENT_FETCH).toBeLessThanOrEqual(500);
  });
});

describe('recentRows', () => {
  it('drops quotes the customer never took up, and keeps every conversion that did not finish', () => {
    const rows = [
      row({ lifecycle: 'quoted' }),
      row({ lifecycle: 'expired' }),
      row({ lifecycle: 'settled' }),
      row({ lifecycle: 'accepted' }),
      row({ lifecycle: 'refused' }),
      row({ lifecycle: 'unknown' }),
    ];
    expect(recentRows(rows).map((r) => r.lifecycle)).toEqual(['settled', 'accepted', 'refused', 'unknown']);
  });
  it('shows at most 10, newest first as the service sent them, after the filter (not before)', () => {
    const rows = [...Array.from({ length: 30 }, () => row({ lifecycle: 'expired' })), ...Array.from({ length: 15 }, () => row({}))];
    const shown = recentRows(rows);
    expect(shown).toHaveLength(RECENT_SHOWN);
    expect(shown.every((r) => r.lifecycle === 'settled')).toBe(true);
  });
  it('is empty, not an error, when nothing was taken up', () => {
    expect(recentRows([row({ lifecycle: 'quoted' })])).toEqual([]);
  });
});

describe('recentAt', () => {
  it('uses the settle time, then the accept time, then the quote time', () => {
    expect(recentAt(row({}))).toBe('2026-10-19T10:00:06.000Z');
    expect(recentAt(row({ settledAt: null }))).toBe('2026-10-19T10:00:05.000Z');
    expect(recentAt(row({ settledAt: null, acceptedAt: null }))).toBe('2026-10-19T10:00:00.000Z');
  });
});
