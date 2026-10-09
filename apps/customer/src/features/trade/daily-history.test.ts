import { describe, expect, it } from 'vitest';
import type { OHLCV } from '@intafaced/exchange-contract/schemas';
import { dailyHistoryWindow, deriveUtc8Daily, utc8DailyStart } from './daily-history';
import { createTradeApi } from './trade-api';
import { createApiClient } from '../../shared/api';

const HOUR = 3_600_000, DAY = 24 * HOUR;
const now = Date.parse('2026-10-09T02:20:00Z');
const window = dailyHistoryWindow(now);
const candle = (time: number, values = ['100', '102', '99', '101', '0.000000000000000001']): OHLCV => [time, ...values] as OHLCV;

describe('bounded exact UTC+8 daily history', () => {
  it('crosses midnight at 16:00 UTC independently of the display timezone', () => {
    const before = Date.parse('2026-10-08T15:00:00Z'), after = before + HOUR;
    expect(deriveUtc8Daily([candle(before), candle(after)], window, now).map((row) => row[0]))
      .toEqual([Date.parse('2026-10-07T16:00:00Z'), after]);
    expect(utc8DailyStart(Date.parse('2026-10-08T15:59:59.999Z'))).toBe(Date.parse('2026-10-07T16:00:00Z'));
    expect(utc8DailyStart(after)).toBe(after);
  });
  it('preserves exact first/last source decimals and computes high/low/volume beyond float precision', () => {
    const start = utc8DailyStart(now);
    const rows = [
      candle(start, ['100.000000000000000001', '102.000000000000000001', '99.000000000000000002', '101', '0.000000000000000001']),
      candle(start + 2 * HOUR, ['100', '102.000000000000000002', '99.000000000000000001', '100.000000000000000009', '0.000000000000000002']),
    ];
    expect(deriveUtc8Daily(rows, window, now)).toEqual([
      [start, rows[0]![1], rows[1]![2], rows[1]![3], rows[1]![4], '0.000000000000000003'],
    ]);
    expect(rows[0]![5]).toBe('0.000000000000000001');
  });
  it('keeps missing hours/days absent and accepts a partial current hour without declaring completion', () => {
    const start = utc8DailyStart(now);
    const rows = [candle(start - 2 * DAY), candle(Math.floor(now / HOUR) * HOUR)];
    expect(deriveUtc8Daily(rows, window, now)).toEqual([
      [start - 2 * DAY, '100', '102', '99', '101', '0.000000000000000001'],
      [start, '100', '102', '99', '101', '0.000000000000000001'],
    ]);
    expect(deriveUtc8Daily([], window, now)).toEqual([]);
  });
  it('validates 481 source hours across read-time midnight and keeps only 19 prior days plus the new current day', () => {
    const request = Date.parse('2026-10-08T15:59:59.999Z'), w = dailyHistoryWindow(request);
    const rows = Array.from({ length: 481 }, (_, index) => candle(w.sinceMs + index * HOUR));
    expect(deriveUtc8Daily(rows, w, request + 1)).toHaveLength(20);
    expect(deriveUtc8Daily(rows, w, request + 1)[0]![0]).toBe(w.sinceMs + DAY);
  });
  it.each(['duplicate', 'descending', 'unaligned', 'before since', 'future', 'cap', 'extra field', 'numeric money', 'bad high', 'zero price', 'negative volume', 'over precision'] as const)
    ('refuses %s source history as one result without a partially rendered prefix', (kind) => {
      const start = utc8DailyStart(now);
      let rows = [candle(start), candle(start + HOUR)];
      if (kind === 'duplicate') rows[1]![0] = start;
      if (kind === 'descending') rows.reverse();
      if (kind === 'unaligned') rows[1]![0] += 1;
      if (kind === 'before since') rows[0]![0] = window.sinceMs - HOUR;
      if (kind === 'future') rows[1]![0] = Math.floor(now / HOUR) * HOUR + HOUR;
      if (kind === 'cap') rows = Array.from({ length: 500 }, (_, i) => candle(window.sinceMs + i * HOUR));
      if (kind === 'extra field') (rows[1] as unknown[]).push('extra');
      if (kind === 'numeric money') (rows[1] as unknown[])[1] = 100;
      if (kind === 'bad high') rows[1]![2] = '98';
      if (kind === 'zero price') rows[1]![3] = '0';
      if (kind === 'negative volume') rows[1]![5] = '-1';
      if (kind === 'over precision') rows[1]![5] = '0.0000000000000000001';
      expect(() => deriveUtc8Daily(rows, window, now)).toThrowError('invalid_hourly_history');
    });
  it.each([now - 1, now + 15_001, Number.NaN, Number.POSITIVE_INFINITY])('refuses an unvalidated read clock %s', (readAt) => {
    expect(() => deriveUtc8Daily([], window, readAt)).toThrowError('invalid_clock_window');
  });
  it('refuses a shortened or unaligned lower bound rather than implying its first day is whole', () => {
    for (const sinceMs of [window.sinceMs + HOUR, window.sinceMs + 1])
      expect(() => deriveUtc8Daily([], { ...window, sinceMs }, now)).toThrowError('invalid_clock_window');
  });
  it('does not assert venue-sequence equivalence across source hours', () => {
    const start = utc8DailyStart(now);
    // An engine may sequence a later wall-time hour before an earlier one.
    // The published hourly tuples supply neither range, so chronological open
    // cannot be called the sequence-ordered venue daily open.
    const earlierHour = candle(start, ['100', '100', '100', '100', '1']);
    const laterHour = candle(start + HOUR, ['99', '99', '99', '99', '1']);
    const chronological = deriveUtc8Daily([earlierHour, laterHour], window, now)[0]!;
    const sequenceOrderedOpen = '99';
    expect(chronological[1]).toBe('100');
    expect(chronological[1]).not.toBe(sequenceOrderedOpen);
  });
});

describe('daily history public transport seam', () => {
  it('uses the existing hourly/since/500 read and replaces corrected history exactly without a write', async () => {
    const reads: { method: string; url: URL }[] = [];
    const start = utc8DailyStart(now);
    let close = '100.000000000000000001';
    const api = createTradeApi(createApiClient({ fetch: async (input, options) => {
      reads.push({ method: options?.method ?? 'GET', url: new URL(String(input), 'http://test.invalid') });
      return new Response(JSON.stringify([candle(start, ['100', '101', '99', close, '0.000000000000000001'])]));
    } }), () => now);
    expect(await api.dailyHistory('BTC/USDT')).toMatchObject({ ok: true, data: [[start, '100', '101', '99', close, '0.000000000000000001']] });
    close = '100.000000000000000009';
    expect(await api.dailyHistory('BTC/USDT')).toMatchObject({ ok: true, data: [[start, '100', '101', '99', close, '0.000000000000000001']] });
    expect(reads).toHaveLength(2);
    for (const read of reads) {
      expect(read.method).toBe('GET');
      expect(read.url.pathname).toBe('/api/v1/ohlcv/BTC%2FUSDT');
      expect(Object.fromEntries(read.url.searchParams)).toEqual({ timeframe: '1h', limit: '500', since: String(window.sinceMs) });
    }
  });
  it('retains the opaque server refusal and returns a typed invalid-source failure', async () => {
    const failed = createTradeApi(createApiClient({ fetch: async () => new Response(JSON.stringify({ message: 'opaque original', code: 'original.refusal' }), { status: 503 }) }), () => now);
    expect(await failed.dailyHistory('BTC/USDT')).toMatchObject({ ok: false, reason: 'unreachable', message: 'opaque original', code: 'original.refusal' });
    const invalid = createTradeApi(createApiClient({ fetch: async () => new Response(JSON.stringify([candle(now)])) }), () => now);
    expect(await invalid.dailyHistory('BTC/USDT')).toMatchObject({ ok: false, reason: 'invalid_response' });
  });
});
