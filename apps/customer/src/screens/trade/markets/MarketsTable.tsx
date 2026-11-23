import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { Table } from '@intafaced/ui/lit/templates';
import type { Decimal, MarketRow as MarketData } from '../../../data';
import { marketsCopy } from './copy';
import { marketColumns, type FavoriteControl, type MarketLine } from './MarketRow';
import { ALL_COLUMNS, nextSort, type Entry, type MarketColumn, type Mode, type Sort, type SortKey } from './select';

const SORT_KEY: Partial<Record<MarketColumn, SortKey>> = { name: 'name', price: 'price', change: 'change', volume: 'volume' };

/** Past this many rows the kit's table draws only the rows near the window's view; each row is about this tall. */
const VIRTUAL = { estimate: 60, after: 50 } as const;

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
  /** Which columns to draw, in order. Default: all seven. Home Pro asks for a subset. */
  columns?: readonly MarketColumn[];
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
  /** Called with the symbols of the rows drawn, so the owner fetches sparklines for those only. Fires when the set changes. */
  onVisibleSymbolsChange?: (symbols: readonly string[]) => void;
  /** Accessible name of the table. */
  label: string;
  /** Shown in place of the rows when `entries` is empty and not loading. */
  empty?: ReactNode;
}

/** Report the drawn symbols when the set changes. */
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

/**
 * The markets table (UI-SPEC 5.6), drawn on the kit's Table: a sortable header over one row per market; under the
 * compact width the kit stacks each row with its cells' labels. The caller owns the data and the filtering; the kit
 * windows the rows past 50 and moves focus between rows' links with the arrow keys. Used by Home Pro (`columns` subset).
 */
export function MarketsTable({
  entries,
  sparklines,
  mode,
  columns = ALL_COLUMNS,
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
  const shown = useMemo(() => ALL_COLUMNS.filter((column) => columns.includes(column)), [columns]);
  const cols = useMemo(
    () => marketColumns(shown, { mode, hrefFor, favorite, sparklines }, t, (column) => Boolean(onSortChange && SORT_KEY[column])),
    [shown, mode, hrefFor, favorite, sparklines, t, onSortChange],
  );
  const lines: MarketLine[] = useMemo(
    () => (loading ? Array.from({ length: skeletonRows }, (_, ghost) => ({ ghost })) : entries.map((entry) => ({ entry }))),
    [loading, skeletonRows, entries],
  );
  useReportVisible(
    useMemo(() => (loading ? [] : entries.map((entry) => entry.market.symbol)), [loading, entries]),
    onVisibleSymbolsChange,
  );
  return (
    <Table
      caption={label}
      columns={cols}
      rows={lines}
      rowKey={(line) => ('ghost' in line ? `ghost-${line.ghost}` : line.entry.market.symbol)}
      mode={mode}
      selected={selectedSymbol}
      sort={onSortChange && sort ? { columnId: sort.key, direction: sort.dir } : onSortChange ? null : undefined}
      onSort={onSortChange ? (next) => onSortChange(nextSort(sort, next.columnId as SortKey)) : undefined}
      empty={!loading && empty ? <div data-testid="mkt-empty">{empty}</div> : undefined}
      rowMarks={(line) => ({ 'data-testid': 'mkt-row', 'data-symbol': 'ghost' in line ? undefined : line.entry.market.symbol })}
      headMarks={{ 'data-testid': 'mkt-header' }}
      busy={loading}
      virtual={VIRTUAL}
    />
  );
}
