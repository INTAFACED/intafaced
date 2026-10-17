import { describe, expect, it } from 'vitest';
import { assetsOf, filterListings, isFiltered, NO_FILTER, periodUnit, type ListingRow } from './market-explorer';

const row = (id: string, over: Partial<ListingRow>): ListingRow => ({
  id,
  vendorId: 'v1',
  title: id,
  description: '',
  offerType: 'one_time',
  assetId: 'IFC',
  price: '10',
  periodSeconds: null,
  status: 'active',
  createdAt: '2026-10-01T00:00:00.000Z',
  ...over,
});
const rows = [
  row('Alpha signals', { price: '9.5', createdAt: '2026-10-03T00:00:00.000Z', description: 'daily ideas' }),
  row('Beta course', { price: '100', vendorId: 'v2', createdAt: '2026-10-02T00:00:00.000Z' }),
  row('Gamma feed', {
    price: '10',
    offerType: 'subscription',
    periodSeconds: 2_592_000,
    assetId: 'USDT',
    createdAt: '2026-10-01T00:00:00.000Z',
  }),
];

describe('market catalogue filters', () => {
  it('returns everything newest first when nothing is applied', () => {
    expect(filterListings(rows, NO_FILTER).map((r) => r.id)).toEqual(['Alpha signals', 'Beta course', 'Gamma feed']);
    expect(isFiltered(NO_FILTER)).toBe(false);
  });
  it('searches title and description', () => {
    expect(filterListings(rows, { ...NO_FILTER, query: 'IDEAS' }).map((r) => r.id)).toEqual(['Alpha signals']);
    expect(filterListings(rows, { ...NO_FILTER, query: 'course' }).map((r) => r.id)).toEqual(['Beta course']);
  });
  it('filters by offer, asset and seller', () => {
    expect(filterListings(rows, { ...NO_FILTER, offer: 'subscription' }).map((r) => r.id)).toEqual(['Gamma feed']);
    expect(filterListings(rows, { ...NO_FILTER, asset: 'USDT' }).map((r) => r.id)).toEqual(['Gamma feed']);
    expect(filterListings(rows, { ...NO_FILTER, vendorId: 'v2' }).map((r) => r.id)).toEqual(['Beta course']);
    expect(isFiltered({ ...NO_FILTER, vendorId: 'v2' })).toBe(true);
  });
  it('sorts prices as exact numbers, not text', () => {
    expect(filterListings(rows, { ...NO_FILTER, sort: 'price_asc' }).map((r) => r.price)).toEqual(['9.5', '10', '100']);
    expect(filterListings(rows, { ...NO_FILTER, sort: 'price_desc' }).map((r) => r.price)).toEqual(['100', '10', '9.5']);
  });
  it('lists the assets in the catalogue once', () => {
    expect(assetsOf(rows)).toEqual(['IFC', 'USDT']);
  });
  it('names a period in its largest whole unit', () => {
    expect(periodUnit(2_592_000)).toEqual({ value: 30, unit: 'days' });
    expect(periodUnit(7_200)).toEqual({ value: 2, unit: 'hours' });
    expect(periodUnit(90)).toEqual({ value: 90, unit: 'seconds' });
    expect(periodUnit(300)).toEqual({ value: 5, unit: 'minutes' });
  });
});
