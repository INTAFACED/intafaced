import type { HistoryQuery } from '../trade-api';

/** The page sizes the order history offers; the service answers at most this many orders per page. */
export const PAGE_SIZES = [20, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 20;

/** The order-history filters as the address holds them (`/trade/orders?side=buy&status=canceled&from=2026-10-01`). */
export interface HistoryParams {
  readonly side: string;
  readonly status: string;
  readonly type: string;
  /** Calendar days in the person's own time, `YYYY-MM-DD`; blank is no bound. */
  readonly from: string;
  readonly to: string;
  readonly size: number;
}

export const NO_PARAMS: HistoryParams = { side: '', status: '', type: '', from: '', to: '', size: DEFAULT_PAGE_SIZE };

export function readParams(search: string): HistoryParams {
  const params = new URLSearchParams(search);
  const size = Number(params.get('size'));
  return {
    side: params.get('side') ?? '',
    status: params.get('status') ?? '',
    type: params.get('type') ?? '',
    from: params.get('from') ?? '',
    to: params.get('to') ?? '',
    size: (PAGE_SIZES as readonly number[]).includes(size) ? size : DEFAULT_PAGE_SIZE,
  };
}

export function writeParams(params: HistoryParams): string {
  const out = new URLSearchParams();
  for (const key of ['side', 'status', 'type', 'from', 'to'] as const) if (params[key] !== '') out.set(key, params[key]);
  if (params.size !== DEFAULT_PAGE_SIZE) out.set('size', String(params.size));
  const text = out.toString();
  return text === '' ? '' : `?${text}`;
}

/** Midnight at the start of a `YYYY-MM-DD` day in the person's own time, or null when it names no real day. */
export function dayStart(day: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return null;
  const [year, month, date] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
  const start = new Date(year, month, date);
  return start.getFullYear() === year && start.getMonth() === month && start.getDate() === date ? start : null;
}

export type QueryOutcome =
  { readonly ok: true; readonly query: HistoryQuery } | { readonly ok: false; readonly problem: 'from' | 'to' | 'range' };

/**
 * The service query for these filters. Side, state and type go as written, so the service refuses one it does not know
 * (in words on the page); a date this page cannot read is refused here, before anything is sent. `to` includes its whole day.
 */
export function toQuery(params: HistoryParams, before?: string): QueryOutcome {
  const from = params.from === '' ? null : dayStart(params.from);
  if (params.from !== '' && from === null) return { ok: false, problem: 'from' };
  const toDay = params.to === '' ? null : dayStart(params.to);
  if (params.to !== '' && toDay === null) return { ok: false, problem: 'to' };
  const until = toDay === null ? undefined : new Date(toDay.getFullYear(), toDay.getMonth(), toDay.getDate() + 1).getTime() - 1;
  if (from !== null && until !== undefined && until < from.getTime()) return { ok: false, problem: 'range' };
  return {
    ok: true,
    query: {
      limit: params.size,
      ...(params.side ? { side: params.side } : {}),
      ...(params.status ? { status: params.status } : {}),
      ...(params.type ? { type: params.type } : {}),
      ...(from ? { since: from.getTime() } : {}),
      ...(until !== undefined ? { until } : {}),
      ...(before ? { before } : {}),
    },
  };
}

/** Add a page to what is shown, never showing one order twice (a page that repeats an order is a service fault). */
export function appendPage<T extends { id: string }>(shown: readonly T[], page: readonly T[]): { rows: T[]; repeated: number } {
  const seen = new Set(shown.map((row) => row.id));
  const fresh = page.filter((row) => !seen.has(row.id));
  return { rows: [...shown, ...fresh], repeated: page.length - fresh.length };
}
