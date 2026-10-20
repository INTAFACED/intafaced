import { describe, expect, it } from 'vitest';
import { formatAmount, parseAmount as amt } from '@intafaced/ledger-client';
import {
  INDEX_BELOW_FLOOR,
  INDEX_PARAMS_UNSET,
  INDEX_STALE,
  NOT_CONNECTED_FEED_MARKET,
  NotConnectedError,
  buildIndex,
  notConnectedIndexFeed,
  type IndexParams,
  type IndexQuote,
  type IndexSourceConfig,
} from './index-construction.js';

// TEST figures only: sources, weights and bands here are fixtures, not owner numbers.
const AT = new Date('2026-10-20T12:00:00.000Z');
const sources: IndexSourceConfig[] = [
  { sourceId: 'src-a', weight: 1, enabled: true },
  { sourceId: 'src-b', weight: 1, enabled: true },
  { sourceId: 'src-c', weight: 2, enabled: true },
  { sourceId: 'src-off', weight: 1, enabled: false },
];
const params: IndexParams = { minSources: 2, outlierBandBps: 500, maxAgeSeconds: 30 };
const fresh = new Date(AT.getTime() - 5_000);

function q(sourceId: string, price: string, observedAt: Date = fresh): IndexQuote {
  return { sourceId, price: amt(price), observedAt };
}

describe('feed port', () => {
  it('answers NotConnected feed.market as a typed result, never a number', async () => {
    const result = await notConnectedIndexFeed().read({ marketId: 'm1', sourceIds: ['src-a'], at: AT });
    expect(result).toMatchObject({ connected: false, notConnected: 'feed.market' });
    expect('quotes' in result).toBe(false);
    expect(new NotConnectedError().code).toBe(NOT_CONNECTED_FEED_MARKET);
  });
});

describe('buildIndex', () => {
  it('is the weighted average of in-band fresh sources', () => {
    const r = buildIndex({ quotes: [q('src-a', '100'), q('src-b', '102'), q('src-c', '101')], sources, params, at: AT });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // (100*1 + 102*1 + 101*2) / 4 = 101
    expect(formatAmount(r.price)).toBe('101');
    expect(r.used.map((u) => u.sourceId).sort()).toEqual(['src-a', 'src-b', 'src-c']);
  });

  it('rejects an outlier beyond the owner band and builds from the rest', () => {
    const r = buildIndex({ quotes: [q('src-a', '100'), q('src-b', '101'), q('src-c', '150')], sources, params, at: AT });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rejected).toEqual([{ sourceId: 'src-c', reason: 'outlier' }]);
    expect(formatAmount(r.price)).toBe('100.5');
  });

  it('quotes inside the band are all kept', () => {
    // median of (100, 105) is 102.5; both are about 2.4% away, inside 500 bps.
    const r = buildIndex({ quotes: [q('src-a', '100'), q('src-b', '105')], sources, params, at: AT });
    expect(r.ok).toBe(true);
  });

  it('drops disabled, unknown, repeated and non-positive quotes with a reason', () => {
    const r = buildIndex({
      quotes: [q('src-a', '100'), q('src-b', '100'), q('src-off', '100'), q('nobody', '100'), q('src-a', '100'), q('src-c', '0')],
      sources,
      params,
      at: AT,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rejected.map((x) => x.reason).sort()).toEqual(['disabled', 'duplicate', 'non_positive', 'unknown_source']);
  });

  it('every source stale is trade.index_stale', () => {
    const old = new Date(AT.getTime() - 120_000);
    const r = buildIndex({ quotes: [q('src-a', '100', old), q('src-b', '100', old)], sources, params, at: AT });
    expect(r).toMatchObject({ ok: false, code: INDEX_STALE });
  });

  it('no quote at all is trade.index_stale, not a zero index', () => {
    const r = buildIndex({ quotes: [], sources, params, at: AT });
    expect(r).toMatchObject({ ok: false, code: INDEX_STALE });
  });

  it('a quote dated in the future is stale', () => {
    const future = new Date(AT.getTime() + 120_000);
    const r = buildIndex({ quotes: [q('src-a', '100', future), q('src-b', '100')], sources, params, at: AT });
    expect(r).toMatchObject({ ok: false, code: INDEX_STALE });
  });

  it('fewer fresh sources than the floor, with none aged out, is below floor', () => {
    const r = buildIndex({ quotes: [q('src-a', '100')], sources, params: { ...params, minSources: 2 }, at: AT });
    expect(r).toMatchObject({ ok: false, code: INDEX_BELOW_FLOOR });
  });

  it('outlier rejection that leaves fewer than the floor is below floor', () => {
    const r = buildIndex({
      quotes: [q('src-a', '100'), q('src-b', '200')],
      sources,
      params: { ...params, minSources: 2, outlierBandBps: 100 },
      at: AT,
    });
    expect(r).toMatchObject({ ok: false, code: INDEX_BELOW_FLOOR });
  });

  it.each([
    ['minSources', { minSources: null }],
    ['outlierBandBps', { outlierBandBps: null }],
    ['maxAgeSeconds', { maxAgeSeconds: null }],
  ] as const)('a blank %s refuses with trade.index_params_unset', (field, patch) => {
    const r = buildIndex({ quotes: [q('src-a', '100'), q('src-b', '100')], sources, params: { ...params, ...patch }, at: AT });
    expect(r).toMatchObject({ ok: false, code: INDEX_PARAMS_UNSET, missing: [field] });
  });
});
