import { describe, expect, it } from 'vitest';
import { askedOfTheBank, hasFilters, NO_FILTERS, serverOptions } from './activity-filter';
import { createActivityFeed } from '../../data/activity';
import { createApiClient } from '../../shared/api';

/** PF-activity-01 screen half: what the page asks the bank for (order, account, year, address). */

describe('filters the bank applies', () => {
  it('sends nothing for the default view, so Home and Money keep one request', () => {
    expect(serverOptions(NO_FILTERS)).toEqual({});
    expect(askedOfTheBank(NO_FILTERS)).toBe(false);
  });
  it('sends oldest first, one account, one UTC year and a long-enough address', () => {
    const f = { ...NO_FILTERS, sort: 'asc' as const, accountId: 'main', year: '2025', address: ' 0xAbCd ' };
    expect(serverOptions(f)).toEqual({ sort: 'asc', accountId: 'main', year: 2025, address: '0xAbCd' });
    expect(hasFilters(f)).toBe(true);
  });
  it('does not send an address under four characters or a year that is not four digits', () => {
    expect(serverOptions({ ...NO_FILTERS, address: '0x1', year: '20' })).toEqual({});
  });
  it('counts each of them as a filter, so Clear filters shows', () => {
    for (const over of [{ sort: 'asc' as const }, { accountId: 'main' }, { year: '2025' }, { address: '0x1' }])
      expect(hasFilters({ ...NO_FILTERS, ...over })).toBe(true);
  });
});

describe('the activity read carries them', () => {
  it('puts the chosen order, account, year and address on the request', async () => {
    const urls: string[] = [];
    const api = createApiClient({
      fetch: async (url) => {
        urls.push(String(url));
        return new Response(JSON.stringify({ result: { data: { items: [], nextCursor: null } } }));
      },
    });
    const feed = createActivityFeed(api, { sort: 'asc', accountId: 'main', year: 2025, address: '0xAbCd' });
    const stop = feed.subscribe(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    stop();
    const input = JSON.parse(decodeURIComponent(urls[0]!.split('input=')[1]!));
    expect(input).toMatchObject({ sort: 'asc', accountId: 'main', year: 2025, address: '0xAbCd' });
  });
  it('sends only the default fields when nothing is chosen', async () => {
    const urls: string[] = [];
    const api = createApiClient({
      fetch: async (url) => {
        urls.push(String(url));
        return new Response(JSON.stringify({ result: { data: { items: [], nextCursor: null } } }));
      },
    });
    const stop = createActivityFeed(api).subscribe(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    stop();
    expect(JSON.parse(decodeURIComponent(urls[0]!.split('input=')[1]!))).toEqual({ limit: 50 });
  });
});

describe('reordering alone', () => {
  it('is not a narrowing, so an empty list still says there is no activity', () => {
    expect(askedOfTheBank({ ...NO_FILTERS, sort: 'asc' })).toBe(false);
    expect(askedOfTheBank({ ...NO_FILTERS, sort: 'asc', year: '2025' })).toBe(true);
  });
});
