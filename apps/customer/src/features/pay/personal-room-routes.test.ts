import { describe, expect, it } from 'vitest';
import { findRoom, rooms } from '../../app/navigation';
import { featureById } from '../../app/feature-registry';
import { matchPersonalRoute, PERSONAL_ROUTES } from './personal-room-routes';

const sample = (pattern: string) => pattern.replace(/:[A-Za-z]+/g, 'abc123');

describe('personal Pay addresses (PP-order-02)', () => {
  it('every address is a navigation row in the pay area, with no screen of its own', () => {
    for (const route of PERSONAL_ROUTES) {
      const row = rooms.find((room) => room.path === route.pattern);
      expect(row, route.pattern).toBeDefined();
      expect(row?.area, route.pattern).toBe('pay');
      expect(row?.screen, route.pattern).toBeUndefined();
      expect(row?.business, route.pattern).toBeFalsy();
    }
  });

  it('every address opens its own row, not the business "Page not found" catch-all', () => {
    for (const route of PERSONAL_ROUTES) {
      const found = findRoom(sample(route.pattern));
      expect(found?.path, route.pattern).toBe(route.pattern);
      expect(found?.title, route.pattern).not.toBe('Page not found');
    }
  });

  it('every address is in the registry, which keeps it reachable and never hides it', () => {
    const feature = featureById('personal-pay-rooms');
    expect(feature?.status).toBe('blocked');
    expect([...(feature?.paths ?? [])].sort()).toEqual(PERSONAL_ROUTES.map((route) => route.pattern).sort());
  });

  it('keeps the business rooms and the five tabs where they were', () => {
    for (const path of [
      '/pay/disputes',
      '/pay/limits',
      '/pay/settings',
      '/pay/invoices/inv_1',
      '/pay/payments',
      '/pay/links/abc',
      '/pay/send',
      '/pay/request',
    ]) {
      expect(matchPersonalRoute(path), path).toBeUndefined();
    }
    expect(findRoom('/pay/limits')?.business).toBe(true);
    expect(findRoom('/pay/invoices/inv_1')?.path).toBe('/pay/invoices/:invoiceId');
    expect(findRoom('/pay/links/abc')?.path).toBe('/pay/links/:linkId');
    expect(findRoom('/pay/send')?.screen).toBe('pay');
  });

  it('lists the static pages for search and keeps record pages out of it', () => {
    for (const route of PERSONAL_ROUTES) {
      expect(rooms.find((room) => room.path === route.pattern)?.hidden === true, route.pattern).toBe(route.detail);
    }
  });

  it('reads an id once and refuses a malformed one without looking anything up', () => {
    expect(matchPersonalRoute('/pay/history/tr_1')).toMatchObject({ id: 'tr_1' });
    expect(matchPersonalRoute('/pay/history/tr%5F1')).toMatchObject({ id: 'tr_1' });
    expect(matchPersonalRoute('/pay/history/tr_1/')).toMatchObject({ id: 'tr_1' });
    for (const bad of [
      '/pay/history/%E0%A4%A',
      '/pay/history/a%2Fb',
      '/pay/history/.hidden',
      `/pay/history/${'a'.repeat(129)}`,
      '/pay/cases/%252F',
    ]) {
      expect(matchPersonalRoute(bad)?.invalid, bad).toBe(true);
    }
  });

  it('puts a literal section before the parameter route that shares its prefix', () => {
    const paths = PERSONAL_ROUTES.map((route) => route.pattern);
    expect(paths.indexOf('/pay/cases')).toBeLessThan(paths.indexOf('/pay/cases/:caseId'));
    expect(paths.indexOf('/pay/contacts')).toBeLessThan(paths.indexOf('/pay/contacts/groups/:groupId'));
  });
});
