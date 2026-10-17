import { describe, expect, it } from 'vitest';
import { firstPageHref, hasActiveFilter, listInputFor, nextPageHref, parseMerchantListQuery, previousPageHref } from './list-params';

describe('merchant list URL state', () => {
  it('drops anything it does not recognise', () => {
    const q = parseMerchantListQuery({
      status: 'bogus',
      kyb: ['approved', 'x'],
      tier: 'Not A Slug',
      limit: '7',
      cursor: 'a b',
      trail: 'ok_1,bad one',
    });
    expect(q).toEqual({ status: null, kyb: 'approved', tier: null, limit: 50, cursor: null, trail: ['ok_1'] });
  });

  it('builds the service input from filters only', () => {
    const q = parseMerchantListQuery({ status: 'active', kyb: 'pending', limit: '25', cursor: 'abc_DEF-1' });
    expect(listInputFor(q)).toEqual({ limit: 25, cursor: 'abc_DEF-1', filter: { status: 'active', kybStatus: 'pending' } });
    expect(listInputFor(parseMerchantListQuery({}))).toEqual({ limit: 50 });
    expect(hasActiveFilter(q)).toBe(true);
    expect(hasActiveFilter(parseMerchantListQuery({}))).toBe(false);
  });

  it('walks forward and back through cursors', () => {
    const p1 = parseMerchantListQuery({ status: 'active' });
    expect(previousPageHref(p1)).toBeNull();
    const next1 = nextPageHref(p1, 'C1');
    expect(next1).toBe('/merchants/all?status=active&cursor=C1');
    const p2 = parseMerchantListQuery(Object.fromEntries(new URL(next1, 'https://x').searchParams));
    const next2 = nextPageHref(p2, 'C2');
    expect(next2).toBe('/merchants/all?status=active&cursor=C2&trail=C1');
    const p3 = parseMerchantListQuery(Object.fromEntries(new URL(next2, 'https://x').searchParams));
    expect(previousPageHref(p3)).toBe('/merchants/all?status=active&cursor=C1');
    expect(previousPageHref(p2)).toBe('/merchants/all?status=active');
    expect(firstPageHref(p3)).toBe('/merchants/all?status=active');
  });
});
