/** J-charts-desk-19: the chart feed control's pure rules: transitions, owner values and the candle gate. TEST values only. */
import { describe, expect, it } from 'vitest';
import {
  candleGateOf,
  CHART_FEED_DELISTED,
  CHART_FEED_DISABLED,
  CHART_FEED_FALLBACK_UNSET,
  CHART_FEED_NO_CHANGE,
  CHART_FEED_SOURCE_NOT_CONNECTED,
  CHART_FEED_SOURCE_UNKNOWN,
  chartFeedPayloadHash,
  DEFAULT_SETTING,
  nextChartFeed,
  parseExportRowLimit,
  parseFallbackSources,
} from './chart-feed-controls.js';

const ON = { source: 'primary', state: 'on' } as const;
const LIST = ['test-backup'] as const;

function refusal(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe('nextChartFeed', () => {
  it('refuses a switch to a fallback while the owner list is blank, and names the code', () => {
    expect(refusal(() => nextChartFeed(ON, { kind: 'switch_source', to: 'test-backup' }, null))).toBe(CHART_FEED_FALLBACK_UNSET);
  });
  it('refuses a source that is not on the owner list', () => {
    expect(refusal(() => nextChartFeed(ON, { kind: 'switch_source', to: 'other' }, LIST))).toBe(CHART_FEED_SOURCE_UNKNOWN);
  });
  it('switches to a listed fallback, and back to primary with no list at all', () => {
    expect(nextChartFeed(ON, { kind: 'switch_source', to: 'test-backup' }, LIST)).toEqual({ source: 'test-backup', state: 'on' });
    expect(nextChartFeed({ source: 'test-backup', state: 'on' }, { kind: 'switch_source', to: 'primary' }, null)).toEqual(ON);
  });
  it('disables, enables and delists; a change that changes nothing refuses', () => {
    expect(nextChartFeed(ON, { kind: 'disable' }, null)).toEqual({ source: 'primary', state: 'disabled' });
    expect(nextChartFeed({ source: 'primary', state: 'disabled' }, { kind: 'enable' }, null)).toEqual(ON);
    expect(nextChartFeed(ON, { kind: 'delist_with_history' }, null)).toEqual({ source: 'primary', state: 'delisted_with_history' });
    expect(refusal(() => nextChartFeed(ON, { kind: 'enable' }, null))).toBe(CHART_FEED_NO_CHANGE);
    expect(refusal(() => nextChartFeed(ON, { kind: 'switch_source', to: 'primary' }, LIST))).toBe(CHART_FEED_NO_CHANGE);
  });
  it('a delisted chart takes only enable', () => {
    const delisted = { source: 'primary', state: 'delisted_with_history' } as const;
    expect(refusal(() => nextChartFeed(delisted, { kind: 'disable' }, null))).toBe(CHART_FEED_DELISTED);
    expect(refusal(() => nextChartFeed(delisted, { kind: 'switch_source', to: 'test-backup' }, LIST))).toBe(CHART_FEED_DELISTED);
    expect(nextChartFeed(delisted, { kind: 'enable' }, null)).toEqual(ON);
  });
});

describe('owner values', () => {
  it('parses the fallback list and refuses blank, malformed, duplicate or primary', () => {
    expect(parseFallbackSources(' test-backup , test-two ')).toEqual(['test-backup', 'test-two']);
    for (const raw of [undefined, '', '  ', 'Bad Name', 'a,a', 'primary', 'a,,b']) expect(parseFallbackSources(raw)).toBeNull();
  });
  it('parses the export row limit as a whole number, else not set', () => {
    expect(parseExportRowLimit('1000')).toBe(1000);
    for (const raw of [undefined, '', '0', '-1', '1.5', '10000000', 'ten']) expect(parseExportRowLimit(raw)).toBeNull();
  });
});

describe('the approval hash', () => {
  it('binds the action, the source, the version and the reason', () => {
    const base = {
      symbol: 'BTC/USDT',
      action: { kind: 'switch_source', to: 'test-backup' } as const,
      expectedVersion: '0',
      reason: 'TEST reason',
    };
    const h = chartFeedPayloadHash(base);
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(chartFeedPayloadHash({ ...base, action: { kind: 'switch_source', to: 'test-two' } })).not.toBe(h);
    expect(chartFeedPayloadHash({ ...base, expectedVersion: '1' })).not.toBe(h);
    expect(chartFeedPayloadHash({ ...base, reason: 'TEST other' })).not.toBe(h);
  });
});

describe('candleGateOf', () => {
  it('serves the primary source while on', () => {
    expect(candleGateOf('BTC/USDT', DEFAULT_SETTING)).toEqual({ kind: 'serve', until: null });
  });
  it('refuses a disabled chart feed by name', () => {
    expect(candleGateOf('BTC/USDT', { ...DEFAULT_SETTING, state: 'disabled' })).toMatchObject({
      kind: 'refuse',
      code: CHART_FEED_DISABLED,
    });
  });
  it('never serves our own fills under a fallback source name: it refuses while no adapter is connected', () => {
    const gate = candleGateOf('BTC/USDT', { ...DEFAULT_SETTING, source: 'test-backup' });
    expect(gate).toMatchObject({ kind: 'refuse', code: CHART_FEED_SOURCE_NOT_CONNECTED });
    expect(gate.kind === 'refuse' && gate.message).toContain('test-backup');
  });
  it('serves a delisted chart only up to its delisting', () => {
    const at = '2026-11-18T10:00:00.000Z';
    expect(candleGateOf('BTC/USDT', { ...DEFAULT_SETTING, state: 'delisted_with_history', delistedAt: at })).toEqual({
      kind: 'serve',
      until: new Date(at),
    });
  });
});
