/**
 * The saved view of the markets list: which tab, chip, quote, status filter, sort and density the person left it in,
 * kept per signed-in user in device storage (`markets-view:<userId|guest>`). Pure functions over a storage object,
 * so every rule is unit tested (view-state.test.ts). Storage can throw (private mode, quota, blocked), and a saved
 * value can be hand-edited or from an older build: every read and write is guarded and anything unknown falls back
 * to the default instead of breaking the page.
 */
import type { Chip, Tab } from './select';

export type StatusFilter = 'open' | 'all';
export type Density = 'comfortable' | 'compact';
/** Same shape as the kit's sort state, so it goes straight to the Table. */
export interface ViewSort {
  columnId: SortColumnId;
  direction: 'asc' | 'desc';
}

export const SORT_COLUMNS = ['name', 'last', 'change', 'bid', 'ask', 'spread', 'high', 'low', 'volume'] as const;
export type SortColumnId = (typeof SORT_COLUMNS)[number];

export const isSortColumn = (id: string): id is SortColumnId => (SORT_COLUMNS as readonly string[]).includes(id);

const TABS: readonly Tab[] = ['favorites', 'spot'];
const CHIPS: readonly Chip[] = ['all', 'gainers', 'losers', 'new'];
const STATUSES: readonly StatusFilter[] = ['open', 'all'];
const DENSITIES: readonly Density[] = ['comfortable', 'compact'];
const QUOTE = /^[A-Z0-9]{1,12}$/;

export interface ViewState {
  tab: Tab;
  chip: Chip;
  /** Quote currency filter ("USDT"), or null for every quote. */
  quote: string | null;
  status: StatusFilter;
  sort: ViewSort | null;
  /** Null means "the default for the layout mode" (Comfortable in Simple, Compact in Pro). */
  density: Density | null;
}

export const DEFAULT_VIEW: ViewState = { tab: 'spot', chip: 'all', quote: null, status: 'open', sort: null, density: null };

/** The part of `Storage` this module uses, so tests can pass a fake that throws. */
export type ViewStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export const viewKey = (userId: string | null | undefined) => `markets-view:${userId ?? 'guest'}`;

/** The browser's local storage, or null when even asking for it throws. */
export function browserStorage(): ViewStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

const oneOf = <T extends string>(list: readonly T[], value: unknown): T | null =>
  typeof value === 'string' && (list as readonly string[]).includes(value) ? (value as T) : null;

function sortOf(value: unknown): ViewSort | null {
  if (typeof value !== 'object' || value === null) return null;
  const { columnId, direction } = value as Record<string, unknown>;
  const id = oneOf(SORT_COLUMNS, columnId);
  const dir = oneOf(['asc', 'desc'] as const, direction);
  return id && dir ? { columnId: id, direction: dir } : null;
}

/** Keep each known field that is valid; every other field takes its default. */
export function parseView(raw: unknown): ViewState {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_VIEW };
  const value = raw as Record<string, unknown>;
  return {
    tab: oneOf(TABS, value.tab) ?? DEFAULT_VIEW.tab,
    chip: oneOf(CHIPS, value.chip) ?? DEFAULT_VIEW.chip,
    quote: typeof value.quote === 'string' && QUOTE.test(value.quote) ? value.quote : null,
    status: oneOf(STATUSES, value.status) ?? DEFAULT_VIEW.status,
    sort: sortOf(value.sort),
    density: oneOf(DENSITIES, value.density),
  };
}

export function readView(storage: ViewStorage | null, key: string): ViewState {
  try {
    const text = storage?.getItem(key);
    return text ? parseView(JSON.parse(text)) : { ...DEFAULT_VIEW };
  } catch {
    return { ...DEFAULT_VIEW };
  }
}

/** True when the view was saved; false when storage refused (the view still works for this visit). */
export function writeView(storage: ViewStorage | null, key: string, view: ViewState): boolean {
  try {
    if (!storage) return false;
    storage.setItem(key, JSON.stringify(view));
    return true;
  } catch {
    return false;
  }
}

export function clearView(storage: ViewStorage | null, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    // Nothing saved that we could remove; the screen already shows the default.
  }
}

/**
 * Address parameters win over the saved view: `?tab=favorites`, `?filter=gainers`, `?quote=usdc`. A parameter with an
 * unknown value is ignored, so a mistyped link falls back to what the person saved.
 */
export function applyAddress(view: ViewState, search: string): ViewState {
  const params = new URLSearchParams(search);
  const tab = oneOf(TABS, params.get('tab'));
  const chip = oneOf(CHIPS, params.get('filter'));
  const quote = params.get('quote')?.toUpperCase() ?? '';
  return { ...view, tab: tab ?? view.tab, chip: chip ?? view.chip, quote: QUOTE.test(quote) ? quote : view.quote };
}

/** The search text from `?q=`. It is never saved. */
export const queryFromAddress = (search: string) => new URLSearchParams(search).get('q') ?? '';

/** True when the view is exactly the default for this layout mode (so there is nothing to reset). */
export function isDefaultView(view: ViewState, defaultDensity: Density): boolean {
  return (
    view.tab === DEFAULT_VIEW.tab &&
    view.chip === DEFAULT_VIEW.chip &&
    view.quote === DEFAULT_VIEW.quote &&
    view.status === DEFAULT_VIEW.status &&
    view.sort === DEFAULT_VIEW.sort &&
    (view.density ?? defaultDensity) === defaultDensity
  );
}
