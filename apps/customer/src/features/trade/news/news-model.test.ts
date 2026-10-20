import { describe, expect, it } from 'vitest';
import {
  allEvents,
  allNews,
  cleanSymbol,
  filterEvents,
  filterNews,
  filtersActive,
  splitTimeline,
  surprise,
  type CalendarEvent,
  type NewsItem,
} from './news-model';

// TEST items only: none of these is real news or a real release.
const news = (id: string, over: Partial<NewsItem> = {}): NewsItem => ({
  id,
  title: `TEST ${id}`,
  source: 'TEST source',
  category: 'markets',
  language: 'en',
  symbols: [],
  publishedAt: '2026-10-20T08:00:00Z',
  ...over,
});
const event = (id: string, over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id,
  title: `TEST ${id}`,
  country: 'XX',
  priority: 'medium',
  releaseAt: '2026-10-21T08:00:00Z',
  actual: null,
  forecast: null,
  previous: null,
  ...over,
});

describe('news filters', () => {
  const items = [
    news('a'),
    news('b', { category: 'crypto', symbols: ['btc'] }),
    news('c', { language: 'es', category: 'crypto', symbols: ['ETH'] }),
  ];
  it('keeps everything with no filter, and filters by category, language and symbol together', () => {
    expect(filterNews(items, allNews).map((i) => i.id)).toEqual(['a', 'b', 'c']);
    expect(filterNews(items, { ...allNews, category: 'crypto' }).map((i) => i.id)).toEqual(['b', 'c']);
    expect(filterNews(items, { ...allNews, category: 'crypto', language: 'es' }).map((i) => i.id)).toEqual(['c']);
    expect(filterNews(items, { ...allNews, symbol: ' Btc ' }).map((i) => i.id)).toEqual(['b']);
  });
  it('gives nothing for a language with no items, and treats an empty store as empty', () => {
    expect(filterNews(items, { ...allNews, language: 'fr' })).toEqual([]);
    expect(filterNews([], allNews)).toEqual([]);
  });
  it('cleans the symbol and knows when a filter is on', () => {
    expect(cleanSymbol(' btc/usdt<script> ')).toBe('BTC/USDTSCRIPT');
    expect(filtersActive(allNews)).toBe(false);
    expect(filtersActive({ ...allNews, symbol: '  ' })).toBe(false);
    expect(filtersActive({ ...allNews, language: 'en' })).toBe(true);
  });
});

describe('calendar', () => {
  it('filters by priority and country', () => {
    const events = [event('a', { priority: 'high' }), event('b', { country: 'YY' })];
    expect(filterEvents(events, { ...allEvents, priority: 'high' }).map((e) => e.id)).toEqual(['a']);
    expect(filterEvents(events, { ...allEvents, country: 'YY' }).map((e) => e.id)).toEqual(['b']);
  });
  it('orders the timeline by release time and counts events with no usable release time apart', () => {
    const events = [
      event('late', { releaseAt: '2026-10-22T00:00:00Z' }),
      event('none', { releaseAt: null }),
      event('bad', { releaseAt: 'soon' }),
      event('early', { releaseAt: '2026-10-21T00:00:00Z' }),
    ];
    const { timeline, noReleaseTime } = splitTimeline(events);
    expect(timeline.map((e) => e.id)).toEqual(['early', 'late']);
    expect(noReleaseTime).toBe(2);
  });
  it('colours actual against forecast only when both are exact numbers', () => {
    expect(surprise({ actual: '3.2', forecast: '3.1' })).toBe('above');
    expect(surprise({ actual: '3.0', forecast: '3.1' })).toBe('below');
    expect(surprise({ actual: '3.10', forecast: '3.1' })).toBe('inline');
    expect(surprise({ actual: '3.2', forecast: null })).toBe('none');
    expect(surprise({ actual: null, forecast: '3.1' })).toBe('none');
    expect(surprise({ actual: '3.2%', forecast: '3.1' })).toBe('none');
  });
});
