import { KYB_STATUSES, MERCHANT_STATUSES } from './chips';

/**
 * All-merchants list state lives in the URL (spec B3): filters, page size, the
 * cursor and the trail of cursors already visited (for "previous page").
 * Parsing is strict: anything unrecognised is dropped, never forwarded.
 */

export type SearchParams = Record<string, string | string[] | undefined>;

export const PAGE_SIZES = [25, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 50;
const CURSOR = /^[A-Za-z0-9_-]{1,256}$/;
const MAX_TRAIL = 40;

export interface MerchantListQuery {
  readonly status: (typeof MERCHANT_STATUSES)[number] | null;
  readonly kyb: (typeof KYB_STATUSES)[number] | null;
  readonly tier: string | null;
  readonly limit: number;
  readonly cursor: string | null;
  readonly trail: readonly string[];
}

const first = (value: string | string[] | undefined): string | null => (Array.isArray(value) ? (value[0] ?? null) : (value ?? null));

export function parseMerchantListQuery(params: SearchParams): MerchantListQuery {
  const status = first(params.status);
  const kyb = first(params.kyb);
  const tier = first(params.tier);
  const limitRaw = Number(first(params.limit));
  const cursor = first(params.cursor);
  const trail = (first(params.trail) ?? '')
    .split(',')
    .filter((c) => CURSOR.test(c))
    .slice(-MAX_TRAIL);
  return {
    status: (MERCHANT_STATUSES as readonly string[]).includes(status ?? '') ? (status as MerchantListQuery['status']) : null,
    kyb: (KYB_STATUSES as readonly string[]).includes(kyb ?? '') ? (kyb as MerchantListQuery['kyb']) : null,
    tier: tier !== null && /^[a-z][a-z0-9_-]{1,31}$/.test(tier) ? tier : null,
    limit: (PAGE_SIZES as readonly number[]).includes(limitRaw) ? limitRaw : DEFAULT_PAGE_SIZE,
    cursor: cursor !== null && CURSOR.test(cursor) ? cursor : null,
    trail,
  };
}

/** The `founderAdmin.merchants.list` input for a parsed query. */
export function listInputFor(query: MerchantListQuery): {
  limit: number;
  cursor?: string;
  filter?: { status?: string; kybStatus?: string; tierId?: string };
} {
  const filter: { status?: string; kybStatus?: string; tierId?: string } = {};
  if (query.status) filter.status = query.status;
  if (query.kyb) filter.kybStatus = query.kyb;
  if (query.tier) filter.tierId = query.tier;
  return {
    limit: query.limit,
    ...(query.cursor ? { cursor: query.cursor } : {}),
    ...(Object.keys(filter).length ? { filter } : {}),
  };
}

function qs(entries: Record<string, string | number | null | undefined>): string {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(entries)) {
    if (value !== null && value !== undefined && value !== '') out.set(key, String(value));
  }
  const text = out.toString();
  return text ? `?${text}` : '';
}

const base = (query: MerchantListQuery) => ({
  status: query.status,
  kyb: query.kyb,
  tier: query.tier,
  limit: query.limit === DEFAULT_PAGE_SIZE ? null : query.limit,
});

export function firstPageHref(query: MerchantListQuery): string {
  return `/merchants/all${qs(base(query))}`;
}

export function nextPageHref(query: MerchantListQuery, nextCursor: string): string {
  const trail = [...query.trail, ...(query.cursor ? [query.cursor] : [])].slice(-MAX_TRAIL);
  return `/merchants/all${qs({ ...base(query), cursor: nextCursor, trail: trail.join(',') })}`;
}

/** The page before this one, or null on the first page. */
export function previousPageHref(query: MerchantListQuery): string | null {
  if (query.cursor === null) return null;
  const trail = [...query.trail];
  const back = trail.pop() ?? null;
  return `/merchants/all${qs({ ...base(query), cursor: back, trail: trail.join(',') })}`;
}

/** The merchant filter form submits no cursor: changing a filter starts again from page one. */
export const hasActiveFilter = (query: MerchantListQuery): boolean => query.status !== null || query.kyb !== null || query.tier !== null;
