import { parseAmount } from '../../shared/money';

export type ListingRow = {
  id: string;
  vendorId: string;
  title: string;
  description: string;
  offerType: 'one_time' | 'subscription';
  assetId: string;
  price: string;
  periodSeconds: number | null;
  status: 'active' | 'archived';
  createdAt: string;
};
export type ListingFilter = {
  query: string;
  offer: 'all' | 'one_time' | 'subscription';
  asset: string;
  vendorId: string;
  sort: 'newest' | 'price_asc' | 'price_desc' | 'title';
};
export const NO_FILTER: ListingFilter = { query: '', offer: 'all', asset: '', vendorId: '', sort: 'newest' };

/** Narrow and order the loaded catalogue. Prices compare as exact decimals. */
export function filterListings<T extends ListingRow>(rows: readonly T[], filter: ListingFilter): T[] {
  const query = filter.query.trim().toLowerCase();
  const kept = rows.filter(
    (row) =>
      (filter.offer === 'all' || row.offerType === filter.offer) &&
      (!filter.asset || row.assetId === filter.asset) &&
      (!filter.vendorId || row.vendorId === filter.vendorId) &&
      (!query || row.title.toLowerCase().includes(query) || row.description.toLowerCase().includes(query)),
  );
  const price = (row: T) => parseAmount(row.price);
  const cmpPrice = (a: T, b: T) => (price(a) < price(b) ? -1 : price(a) > price(b) ? 1 : 0);
  return [...kept].sort((a, b) => {
    switch (filter.sort) {
      case 'price_asc':
        return cmpPrice(a, b) || a.title.localeCompare(b.title);
      case 'price_desc':
        return cmpPrice(b, a) || a.title.localeCompare(b.title);
      case 'title':
        return a.title.localeCompare(b.title);
      default:
        return Date.parse(b.createdAt) - Date.parse(a.createdAt);
    }
  });
}

/** Distinct assets priced in the loaded catalogue, sorted. */
export function assetsOf(rows: readonly ListingRow[]): string[] {
  return [...new Set(rows.map((row) => row.assetId))].sort();
}

/** True when any narrowing is applied. */
export function isFiltered(filter: ListingFilter): boolean {
  return Boolean(filter.query.trim() || filter.offer !== 'all' || filter.asset || filter.vendorId);
}

/** "Every N seconds" as the largest whole unit; otherwise seconds. */
export function periodUnit(seconds: number): { value: number; unit: 'days' | 'hours' | 'minutes' | 'seconds' } {
  if (seconds % 86_400 === 0) return { value: seconds / 86_400, unit: 'days' };
  if (seconds % 3_600 === 0) return { value: seconds / 3_600, unit: 'hours' };
  if (seconds % 60 === 0) return { value: seconds / 60, unit: 'minutes' };
  return { value: seconds, unit: 'seconds' };
}
