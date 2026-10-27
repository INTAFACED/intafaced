import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import './markets.css';
import { useSession } from '../../../features/session/session';
import { marketsCopy } from './copy';
import { Skeleton, isHiddenPath, type Decimal } from './deps';
import { MarketRow, type FavoriteControl } from './MarketRow';
import { ALL_COLUMNS, marketTarget, nextSort, type Entry, type MarketColumn, type Mode, type Sort, type SortKey } from './select';
import type { MarketData } from './deps';

/** Past this many rows the table draws only the rows on screen (TanStack Virtual). */
export const VIRTUALIZE_AFTER = 50;
/** Row height in px (measured on OKX). */
export const ROW_HEIGHT = 60;

/** Grid track of each column. Fixed-ish so header and rows line up; the flexible ones share what is left. */
const TRACK: Record<MarketColumn, string> = {
  name: 'minmax(220px, 1.25fr)',
  price: 'minmax(120px, 1fr)',
  change: 'minmax(110px, 0.8fr)',
  spark: '150px',
  range: 'minmax(180px, 1.3fr)',
  volume: 'minmax(110px, 0.9fr)',
  action: '184px',
};
/**
 * Narrower screens keep fewer columns. Below 1280 the range and volume go; below 1024 the line chart goes and the
 * action shrinks to one button; below 768 only name, price and change stay (the whole row is still a link).
 */
const NARROW_DROP: readonly MarketColumn[] = ['range', 'volume'];
const TABLET_KEEP: readonly MarketColumn[] = ['name', 'price', 'change', 'action'];
const PHONE_KEEP: readonly MarketColumn[] = ['name', 'price', 'change'];
const TRACK_SMALL: Partial<Record<MarketColumn, string>> = {
  name: 'minmax(150px, 1.25fr)',
  price: 'minmax(100px, 1fr)',
  change: 'minmax(100px, 0.8fr)',
  action: '88px',
};
const TRACK_PHONE: Partial<Record<MarketColumn, string>> = {
  name: 'minmax(0, 1.3fr)',
  price: 'minmax(84px, 1fr)',
  change: 'minmax(84px, 0.9fr)',
};

const SORT_KEY: Partial<Record<MarketColumn, SortKey>> = { name: 'name', price: 'price', change: 'change', volume: 'volume' };
const NUMERIC: readonly MarketColumn[] = ['price', 'change', 'volume'];

export interface MarketsTableProps {
  /**
   * The rows to draw, already filtered and sorted by the caller (`visibleEntries` in `./select`).
   * `ticker` may be undefined while prices load; the row then shows "—".
   */
  entries: readonly Entry[];
  /** Hourly closes by symbol from `useSparklines`. Missing symbols draw no line. */
  sparklines?: Record<string, Decimal[]>;
  /** Simple: row and button go to the Buy card, button says "Buy". Pro: both go to the desk, button says "Trade". */
  mode: Mode;
  /** Which columns to draw, in order. Default: all seven. Home Pro can ask for `['name','price','change','spark']`. */
  columns?: readonly MarketColumn[];
  /**
   * `table` (default) is the full-width list with a 40 px header. `panel` is the desk's 280 px markets panel:
   * two-line 60 px rows (star, pair, name and volume; price and change) under a "Name / 24h volume, Last price /
   * 24h change" header.
   */
  variant?: 'table' | 'panel';
  /** Current sort, or null for the caller's own order. Headers are plain text when `onSortChange` is missing. */
  sort?: Sort | null;
  onSortChange?: (sort: Sort | null) => void;
  /** Star for a market, or undefined for no star on that row. */
  favorite?: (market: MarketData) => FavoriteControl | undefined;
  /** Overrides where a row goes. Default: `marketTarget(market, mode)`. */
  hrefFor?: (market: MarketData, mode: Mode) => string;
  /** Symbol to highlight (the desk's current pair). */
  selectedSymbol?: string;
  /** Draw `skeletonRows` rows of placeholders at the final row size, under the real header. */
  loading?: boolean;
  skeletonRows?: number;
  /**
   * Called with the symbols whose rows are on screen, so the owner fetches sparklines for those only. Without
   * virtualisation that is every row. Fires only when the set changes.
   */
  onVisibleSymbolsChange?: (symbols: readonly string[]) => void;
  /** Accessible name of the table. */
  label: string;
  /** Shown in place of the rows when `entries` is empty and not loading. */
  empty?: ReactNode;
}

function columnLabelKey(column: MarketColumn) {
  return {
    name: 'Name',
    price: 'Price',
    change: '24h change',
    spark: 'Last 24h',
    range: '24h range',
    volume: '24h volume',
    action: 'Action',
  }[column] as 'Name' | 'Price' | '24h change' | 'Last 24h' | '24h range' | '24h volume' | 'Action';
}

function SortButton({
  sortKey,
  label,
  sort,
  onSortChange,
}: {
  sortKey: SortKey;
  label: string;
  sort: Sort | null;
  onSortChange: (sort: Sort | null) => void;
}) {
  const { t } = marketsCopy.useCopy();
  const active = sort?.key === sortKey ? sort.dir : null;
  const Icon = active === 'asc' ? ArrowUp : active === 'desc' ? ArrowDown : ArrowUpDown;
  return (
    <button
      type="button"
      className="mkt-sort"
      data-active={active ?? undefined}
      aria-label={t('Sort by {column}', { column: label })}
      onClick={() => onSortChange(nextSort(sort, sortKey))}
    >
      {label}
      <Icon size={12} aria-hidden="true" />
    </button>
  );
}

function Header({
  columns,
  variant,
  sort,
  onSortChange,
}: {
  columns: readonly MarketColumn[];
  variant: 'table' | 'panel';
  sort: Sort | null;
  onSortChange?: (sort: Sort | null) => void;
}) {
  const { t } = marketsCopy.useCopy();
  const volumeLabel = t('24h volume');
  const changeLabel = t('24h change');
  const sortAria = (key: SortKey): 'ascending' | 'descending' | 'none' =>
    sort?.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
  const sortable = (key: SortKey, label: string) =>
    onSortChange ? <SortButton sortKey={key} label={label} sort={sort} onSortChange={onSortChange} /> : <span>{label}</span>;

  if (variant === 'panel')
    return (
      <div role="row" data-testid="mkt-header" className="mkt-header mkt-header--panel">
        <div role="columnheader" aria-sort={sortAria('name')} className="mkt-panel__head-left">
          {sortable('name', t('Name'))}
          <span aria-hidden="true">/</span>
          {sortable('volume', volumeLabel)}
        </div>
        <div role="columnheader" aria-sort={sortAria('price')} className="mkt-panel__head-right">
          {sortable('price', t('Last price'))}
          <span aria-hidden="true">/</span>
          {sortable('change', changeLabel)}
        </div>
      </div>
    );

  return (
    <div role="row" data-testid="mkt-header" className="mkt-header">
      {columns.map((column) => {
        const key = SORT_KEY[column];
        const label = t(columnLabelKey(column));
        return (
          <div
            key={column}
            role="columnheader"
            data-col={column}
            aria-sort={key ? sortAria(key) : undefined}
            data-testid={NUMERIC.includes(column) ? 'mkt-head--num' : undefined}
            className={`mkt-head ${NUMERIC.includes(column) ? 'mkt-head--num' : ''}`}
          >
            {column === 'action' ? <span className="if-sr">{label}</span> : key ? sortable(key, label) : <span>{label}</span>}
          </div>
        );
      })}
    </div>
  );
}

function SkeletonRow({ columns, variant, index }: { columns: readonly MarketColumn[]; variant: 'table' | 'panel'; index: number }) {
  if (variant === 'panel')
    return (
      <div role="row" data-testid="mkt-row" className="mkt-row mkt-row--panel" aria-hidden="true">
        <div role="cell" className="mkt-panel__star" />
        <div role="cell" className="mkt-panel__name">
          <Skeleton width={72} height={16} />
          <Skeleton width={104} height={12} className="mt-1" />
        </div>
        <div role="cell" className="mkt-panel__figures">
          <Skeleton width={72} height={16} />
          <Skeleton width={48} height={12} className="mt-1" />
        </div>
      </div>
    );
  const cell: Record<MarketColumn, ReactNode> = {
    name: (
      <div className="mkt-cell mkt-cell--name" data-col="name">
        <span className="mkt-star-gap" />
        <Skeleton width={32} height={32} circle />
        <span className="mkt-name">
          <Skeleton width={72 + (index % 3) * 8} height={20} />
          <Skeleton width={56} height={14} className="mt-1" />
        </span>
      </div>
    ),
    price: (
      <div data-testid="mkt-cell--num" className="mkt-cell mkt-cell--num" data-col="price">
        <Skeleton width={96} height={20} />
      </div>
    ),
    change: (
      <div data-testid="mkt-cell--num" className="mkt-cell mkt-cell--num" data-col="change">
        <Skeleton width={64} height={20} />
      </div>
    ),
    spark: (
      <div className="mkt-cell" data-col="spark">
        <Skeleton width={120} height={32} />
      </div>
    ),
    range: (
      <div className="mkt-cell" data-col="range">
        <Skeleton width={160} height={32} />
      </div>
    ),
    volume: (
      <div data-testid="mkt-cell--num" className="mkt-cell mkt-cell--num" data-col="volume">
        <Skeleton width={72} height={20} />
      </div>
    ),
    action: (
      <div className="mkt-cell mkt-cell--action" data-col="action">
        <Skeleton width={64} height={32} circle />
      </div>
    ),
  };
  return (
    <div role="row" data-testid="mkt-row" className="mkt-row" aria-hidden="true">
      {columns.map((column) => (
        <div key={column} role="cell" style={{ display: 'contents' }}>
          {cell[column]}
        </div>
      ))}
    </div>
  );
}

/** Report the on-screen symbols when the set changes. */
function useReportVisible(symbols: readonly string[], report: ((symbols: readonly string[]) => void) | undefined) {
  const key = symbols.join(',');
  const last = useRef<string | null>(null);
  useEffect(() => {
    if (!report || last.current === key) return;
    last.current = key;
    report(symbols);
    // `symbols` is derived from `key`.
  }, [key, report]);
}

/** Move focus between rows with the arrow keys; Home and End jump to the ends. */
function moveFocus(event: KeyboardEvent<HTMLElement>, root: HTMLElement | null, count: number, reveal?: (index: number) => void) {
  const key = event.key;
  if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'Home' && key !== 'End') return;
  const target = event.target as HTMLElement;
  if (!target.matches('[data-row-link]') || !root) return;
  const row = target.closest<HTMLElement>('[data-row-index]');
  const current = Number(row?.dataset.rowIndex ?? -1);
  if (current < 0) return;
  const next = key === 'ArrowDown' ? current + 1 : key === 'ArrowUp' ? current - 1 : key === 'Home' ? 0 : count - 1;
  if (next < 0 || next >= count) return;
  event.preventDefault();
  const focus = () => root.querySelector<HTMLElement>(`[data-row-index="${next}"] [data-row-link]`)?.focus();
  if (root.querySelector(`[data-row-index="${next}"]`)) focus();
  else if (reveal) {
    reveal(next);
    requestAnimationFrame(() => requestAnimationFrame(focus));
  }
}

function VirtualBody({
  entries,
  renderRow,
  onVisible,
}: {
  entries: readonly Entry[];
  renderRow: (entry: Entry, index: number, style?: CSSProperties) => ReactNode;
  onVisible?: (symbols: readonly string[]) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [margin, setMargin] = useState(0);
  useLayoutEffect(() => {
    const measure = () => {
      const top = ref.current ? ref.current.getBoundingClientRect().top + window.scrollY : 0;
      setMargin((previous) => (Math.abs(previous - top) < 1 ? previous : top));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  });
  const virtualizer = useWindowVirtualizer({ count: entries.length, estimateSize: () => ROW_HEIGHT, overscan: 8, scrollMargin: margin });
  const items = virtualizer.getVirtualItems();
  useReportVisible(
    useMemo(() => items.map((item) => entries[item.index]!.market.symbol), [items, entries]),
    onVisible,
  );
  const reveal = useCallback((index: number) => virtualizer.scrollToIndex(index), [virtualizer]);
  return (
    <div
      ref={ref}
      role="rowgroup"
      className="mkt-body mkt-body--virtual"
      style={{ height: virtualizer.getTotalSize() }}
      onKeyDown={(event) => moveFocus(event, ref.current, entries.length, reveal)}
    >
      {items.map((item) =>
        renderRow(entries[item.index]!, item.index, {
          position: 'absolute',
          top: 0,
          left: 0,
          width: '100%',
          height: ROW_HEIGHT,
          transform: `translateY(${item.start - virtualizer.options.scrollMargin}px)`,
        }),
      )}
    </div>
  );
}

function PlainBody({
  entries,
  renderRow,
  onVisible,
}: {
  entries: readonly Entry[];
  renderRow: (entry: Entry, index: number, style?: CSSProperties) => ReactNode;
  onVisible?: (symbols: readonly string[]) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useReportVisible(
    useMemo(() => entries.map((entry) => entry.market.symbol), [entries]),
    onVisible,
  );
  return (
    <div ref={ref} role="rowgroup" className="mkt-body" onKeyDown={(event) => moveFocus(event, ref.current, entries.length)}>
      {entries.map((entry, index) => renderRow(entry, index))}
    </div>
  );
}

/**
 * The markets table (UI-SPEC 5.6, OKX-style): a 40 px sortable header over 60 px rows. The caller owns the data and
 * the filtering; this component draws rows, windows them past 50, and moves focus with the arrow keys.
 * Used by `/trade`, Home Pro (`columns` subset) and the desk's markets panel (`variant="panel"`).
 */
export function MarketsTable({
  entries,
  sparklines,
  mode,
  columns = ALL_COLUMNS,
  variant = 'table',
  sort = null,
  onSortChange,
  favorite,
  hrefFor,
  selectedSymbol,
  loading = false,
  skeletonRows = 8,
  onVisibleSymbolsChange,
  label,
  empty,
}: MarketsTableProps) {
  const { t } = marketsCopy.useCopy();
  const signedIn = Boolean(useSession().session);
  const shown = useMemo(() => ALL_COLUMNS.filter((column) => columns.includes(column)), [columns]);
  const style = useMemo(() => {
    const join = (list: readonly MarketColumn[], override: Partial<Record<MarketColumn, string>> = {}) =>
      list.map((column) => override[column] ?? TRACK[column]).join(' ');
    return {
      '--mkt-cols': join(shown),
      '--mkt-cols-narrow': join(shown.filter((column) => !NARROW_DROP.includes(column))),
      '--mkt-cols-tablet': join(
        shown.filter((column) => TABLET_KEEP.includes(column)),
        TRACK_SMALL,
      ),
      '--mkt-cols-phone': join(
        shown.filter((column) => PHONE_KEEP.includes(column)),
        TRACK_PHONE,
      ),
    } as CSSProperties;
  }, [shown]);
  const renderRow = useCallback(
    (entry: Entry, index: number, rowStyle?: CSSProperties) => (
      <MarketRow
        key={entry.market.symbol}
        market={entry.market}
        ticker={entry.ticker}
        points={sparklines?.[entry.market.symbol]}
        columns={shown}
        mode={mode}
        href={hrefFor ? hrefFor(entry.market, mode) : marketTarget(entry.market, mode, isHiddenPath, signedIn)}
        favorite={favorite?.(entry.market)}
        variant={variant}
        selected={selectedSymbol === entry.market.symbol}
        index={index}
        ariaRowIndex={index + 2}
        style={rowStyle}
      />
    ),
    [sparklines, shown, mode, hrefFor, favorite, variant, selectedSymbol, signedIn],
  );

  return (
    <div
      role="table"
      aria-label={label}
      aria-busy={loading || undefined}
      aria-rowcount={loading ? skeletonRows + 1 : entries.length + 1}
      className={`mkt-table ${variant === 'panel' ? 'mkt-table--panel' : ''}`}
      style={style}
    >
      <Header columns={shown} variant={variant} sort={sort} onSortChange={onSortChange} />
      {loading ? (
        <div role="rowgroup" className="mkt-body" aria-label={t('Loading')}>
          {Array.from({ length: skeletonRows }, (_, index) => (
            <SkeletonRow key={index} columns={shown} variant={variant} index={index} />
          ))}
        </div>
      ) : entries.length === 0 ? (
        empty ? (
          <div data-testid="mkt-empty" className="mkt-empty">
            {empty}
          </div>
        ) : null
      ) : entries.length > VIRTUALIZE_AFTER ? (
        <VirtualBody entries={entries} renderRow={renderRow} onVisible={onVisibleSymbolsChange} />
      ) : (
        <PlainBody entries={entries} renderRow={renderRow} onVisible={onVisibleSymbolsChange} />
      )}
    </div>
  );
}
