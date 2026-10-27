'use client';

/**
 * Table: the one data table for every customer screen (dense for the pro desk, comfortable for money lists).
 *
 * Real <table> markup, so screen readers get rows, columns and sort state for free. What it adds:
 * - sortable headers (controlled: the screen owns `sort`; `sortRows` in table-logic.ts does client sorting
 *   and compares money as exact decimals, never floats),
 * - a sticky header, a pinned first column, numeric columns right-aligned with tabular figures,
 * - row hover, single or multiple selection, a keyboard model (arrows, Home, End, PageUp, PageDown,
 *   Enter opens, Space selects),
 * - honest loading, empty and error rows that keep the header and the column lanes where they are,
 * - virtualisation for long lists on the repo's @tanstack/react-virtual (fixed row heights from the
 *   --if-table-row-h tokens, so nothing jumps).
 *
 * Unknown values draw "—", never 0. Do not build local tables; use this one (docs/ui-kit.md).
 */
import * as React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowUpDown, ChevronDown, ChevronUp } from 'lucide-react';
import { Checkbox } from './checkbox.js';
import { cn, focusRing } from './cn.js';
import { DEFAULT_DENSITY, type Density } from './density.js';
import { UNKNOWN } from './numbers.js';
import { Skeleton } from './skeleton.js';
import { StateBlock } from './state-block.js';
import {
  allSelectedState,
  ariaSortOf,
  nextSort,
  ROW_PX,
  rowKeyAction,
  toggleAll,
  toggleSelection,
  type SortState,
  type SortType,
} from './table-logic.js';

export interface TableColumn<Row> {
  /** Stable id used for sorting and React keys. */
  id: string;
  header: React.ReactNode;
  /** Accessible name when `header` is an icon or empty. */
  headerLabel?: string;
  /** Plain-text value of the cell. Drawn when there is no `cell`, and used for sorting unless `sortValue` is set. `null` draws "—". */
  value?: (row: Row) => string | null;
  /** Custom cell content. Prefer the kit's Money, Amount, Pct and Badge parts inside it. */
  cell?: (row: Row, context: { index: number }) => React.ReactNode;
  /**
   * Figures: right-aligned, tabular figures. Sorts as decimal and starts largest first, so `value` (or `sortValue`)
   * must be a plain decimal string ("1234.5": no thousands separator, currency sign or %). Put formatting in `cell`.
   */
  numeric?: boolean;
  align?: 'start' | 'end' | 'center';
  sortable?: boolean;
  sortType?: SortType;
  sortValue?: (row: Row) => string | null;
  /** px number or any CSS width. Columns without one share the rest. */
  width?: number | string;
  /** Keep this column in view while the table scrolls sideways. Only the first column can be pinned. */
  pin?: 'start';
}

export interface TableLabels {
  loading: string;
  selectAll: string;
  selectRow: string;
}

const defaultLabels: TableLabels = { loading: 'Loading', selectAll: 'Select all rows', selectRow: 'Select row' };

export interface TableProps<Row> {
  /** Accessible name of the table (also its caption for screen readers). Required. */
  label: string;
  columns: readonly TableColumn<Row>[];
  rows: readonly Row[];
  getRowId: (row: Row) => string;
  density?: Density;
  /** `ready` shows rows (or the empty row), `loading` shows skeleton rows, `error` shows `errorState` in place of rows. */
  status?: 'ready' | 'loading' | 'error';
  /** Rows stay visible and the table is marked busy while new data arrives. */
  refreshing?: boolean;
  loadingRows?: number;
  /** Replaces the default empty row. Pass an EmptyState for refused or unavailable. */
  emptyState?: React.ReactNode;
  errorState?: React.ReactNode;
  onRetry?: () => void;
  sort?: SortState | null;
  onSortChange?: (sort: SortState) => void;
  selection?: 'none' | 'single' | 'multiple';
  selectedIds?: ReadonlySet<string>;
  onSelectionChange?: (ids: Set<string>) => void;
  /** Enter, or a click on the row, opens it. */
  onRowActivate?: (row: Row) => void;
  /** Header stays visible while the body scrolls. Default true. */
  stickyHeader?: boolean;
  /** Renders only the visible rows. Needs a height, so `maxHeight` defaults to 480. */
  virtualize?: boolean;
  /** px. The table body scrolls inside it. */
  maxHeight?: number;
  overscan?: number;
  /** px or any CSS width. The table never gets narrower than this, so on a narrow screen it scrolls sideways (the pinned first column stays) instead of squeezing every column. */
  minWidth?: number | string;
  labels?: Partial<TableLabels>;
  className?: string;
}

const rowHeightClass: Record<Density, string> = {
  dense: 'h-(--if-table-row-h-dense)',
  comfortable: 'h-(--if-table-row-h)',
};
const headHeightClass: Record<Density, string> = {
  dense: 'h-(--if-table-head-h-dense)',
  comfortable: 'h-(--if-table-head-h)',
};
const cellPadding: Record<Density, string> = { dense: 'px-2', comfortable: 'px-3' };
const cellText: Record<Density, string> = { dense: 'text-sm', comfortable: 'text-base' };

function alignOf<Row>(column: TableColumn<Row>): 'start' | 'end' | 'center' {
  return column.align ?? (column.numeric ? 'end' : 'start');
}

const alignClass = { start: 'text-left', end: 'text-right', center: 'text-center' } as const;

function widthStyle(width: number | string | undefined): React.CSSProperties | undefined {
  return width === undefined ? undefined : { width };
}

function sortTypeOf<Row>(column: TableColumn<Row>): SortType {
  return column.sortType ?? (column.numeric ? 'decimal' : 'text');
}

function SortGlyph({ state }: { state: 'ascending' | 'descending' | 'none' }) {
  const props = { size: 14, strokeWidth: 2, 'aria-hidden': true as const, className: 'shrink-0' };
  if (state === 'ascending') return <ChevronUp {...props} />;
  if (state === 'descending') return <ChevronDown {...props} />;
  return <ArrowUpDown {...props} className="shrink-0 text-fg-3" />;
}

interface BodyProps<Row> {
  columns: readonly TableColumn<Row>[];
  rows: readonly Row[];
  getRowId: (row: Row) => string;
  density: Density;
  selection: 'none' | 'single' | 'multiple';
  selectedIds: ReadonlySet<string>;
  interactive: boolean;
  focusIndex: number;
  labels: TableLabels;
  /** Total rows, for aria-rowcount and aria-rowindex when only a window is rendered. */
  windowed: boolean;
  onRowKeyDown: (event: React.KeyboardEvent<HTMLTableRowElement>, index: number, row: Row) => void;
  onRowClick: (event: React.MouseEvent<HTMLTableRowElement>, index: number, row: Row) => void;
  onToggleRow: (id: string) => void;
}

function RowView<Row>({ row, index, body }: { row: Row; index: number; body: BodyProps<Row> }) {
  const { columns, density, selection, interactive, windowed, labels } = body;
  const id = body.getRowId(row);
  const selected = body.selectedIds.has(id);
  return (
    <tr
      data-slot="table-row"
      data-row-index={index}
      data-selected={selected || undefined}
      aria-selected={selection === 'none' ? undefined : selected}
      aria-rowindex={windowed ? index + 2 : undefined}
      tabIndex={interactive ? (index === body.focusIndex ? 0 : -1) : undefined}
      onKeyDown={interactive ? (e) => body.onRowKeyDown(e, index, row) : undefined}
      onClick={interactive ? (e) => body.onRowClick(e, index, row) : undefined}
      className={cn(
        rowHeightClass[density],
        'group/row transition-colors duration-(--if-t-fast) ease-if hover:bg-hover aria-selected:bg-hover',
        interactive &&
          'cursor-default outline-none focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-solid focus-visible:outline-focus',
      )}
    >
      {selection === 'multiple' ? (
        <td className={cn('w-10', cellPadding[density])}>
          {/* Not a tab stop: the row is, and Space toggles it. One Tab stop per row keeps the grid keyboard model. */}
          <Checkbox aria-label={labels.selectRow} tabIndex={-1} checked={selected} onCheckedChange={() => body.onToggleRow(id)} />
        </td>
      ) : null}
      {columns.map((column, c) => {
        const align = alignOf(column);
        const content = column.cell ? column.cell(row, { index }) : (column.value?.(row) ?? null);
        return (
          <td
            key={column.id}
            data-align={align}
            className={cn(
              cellPadding[density],
              cellText[density],
              alignClass[align],
              'overflow-hidden text-ellipsis whitespace-nowrap text-fg',
              column.numeric && 'if-num tabular-nums',
              column.pin === 'start' && c === 0 && 'sticky left-0 z-5 bg-bg group-hover/row:bg-hover group-aria-selected/row:bg-hover',
              c === 0 && selected && 'shadow-[inset_2px_0_0_var(--if-lime)]',
            )}
          >
            {content === null ? <span className="text-fg-2">{UNKNOWN}</span> : content}
          </td>
        );
      })}
    </tr>
  );
}

/** Focus the row a keyboard move asked for, once it exists in the DOM. Clears the request when it succeeds. */
function focusPendingRow(scroll: HTMLDivElement | null, pending: React.RefObject<number | null>) {
  const target = pending.current;
  if (target === null) return;
  const el = scroll?.querySelector<HTMLElement>(`tr[data-row-index="${target}"]`);
  if (el) {
    pending.current = null;
    el.focus();
  }
}

function Spacer({ height, colSpan }: { height: number; colSpan: number }) {
  if (height <= 0) return null;
  return (
    <tr aria-hidden="true" data-slot="table-spacer" style={{ height }}>
      <td colSpan={colSpan} className="p-0" />
    </tr>
  );
}

function VirtualRows<Row>({
  body,
  scrollEl,
  height,
  overscan,
  colSpan,
  pendingFocus,
}: {
  body: BodyProps<Row>;
  /** The scroll container as state, not a ref: the virtualiser must re-subscribe once the element exists. */
  scrollEl: HTMLDivElement | null;
  height: number;
  overscan: number;
  colSpan: number;
  pendingFocus: React.RefObject<number | null>;
}) {
  const virtualizer = useVirtualizer({
    count: body.rows.length,
    getScrollElement: () => scrollEl,
    estimateSize: () => ROW_PX[body.density],
    overscan,
    // Gives the first (server or headless) render a real window instead of zero rows.
    initialRect: { width: 0, height },
  });
  const items = virtualizer.getVirtualItems();
  const total = virtualizer.getTotalSize();
  const top = items.length > 0 ? items[0]!.start : 0;
  const bottom = items.length > 0 ? total - items[items.length - 1]!.end : 0;

  // A keyboard jump to a row that is not rendered yet: scroll to it, then focus it once it exists.
  React.useEffect(() => {
    const target = pendingFocus.current;
    if (target === null) return;
    focusPendingRow(scrollEl, pendingFocus);
    if (pendingFocus.current !== null) virtualizer.scrollToIndex(target);
  });

  return (
    <>
      <Spacer height={top} colSpan={colSpan} />
      {items.map((item) => {
        const row = body.rows[item.index]!;
        return <RowView key={body.getRowId(row)} row={row} index={item.index} body={body} />;
      })}
      <Spacer height={bottom} colSpan={colSpan} />
    </>
  );
}

/** See the file header. Generic over the row type: `<Table<Order> ... />`. */
export function Table<Row>({
  label,
  columns,
  rows,
  getRowId,
  density = DEFAULT_DENSITY,
  status = 'ready',
  refreshing = false,
  loadingRows = 5,
  emptyState,
  errorState,
  onRetry,
  sort = null,
  onSortChange,
  selection = 'none',
  selectedIds,
  onSelectionChange,
  onRowActivate,
  stickyHeader = true,
  virtualize = false,
  maxHeight,
  overscan = 8,
  minWidth,
  labels: labelOverrides,
  className,
}: TableProps<Row>) {
  const labels = { ...defaultLabels, ...labelOverrides };
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const [scrollEl, setScrollEl] = React.useState<HTMLDivElement | null>(null);
  const attachScroll = React.useCallback((el: HTMLDivElement | null) => {
    scrollRef.current = el;
    setScrollEl(el);
  }, []);
  const pendingFocus = React.useRef<number | null>(null);
  const [focusIndex, setFocusIndex] = React.useState(0);
  const emptySet = React.useMemo(() => new Set<string>(), []);
  const selected = selectedIds ?? emptySet;
  const interactive = selection !== 'none' || onRowActivate !== undefined;
  const showRows = status === 'ready' && rows.length > 0;
  const windowed = virtualize && showRows;
  const scrollHeight = maxHeight ?? (virtualize ? 480 : undefined);
  const scrollable = scrollHeight !== undefined || minWidth !== undefined;
  const columnCount = columns.length + (selection === 'multiple' ? 1 : 0);
  const rowIds = React.useMemo(() => rows.map(getRowId), [rows, getRowId]);

  // After a keyboard move, put DOM focus on the target row as soon as it exists (it may need scrolling into view first).
  React.useLayoutEffect(() => {
    focusPendingRow(scrollRef.current, pendingFocus);
  });

  const focusRow = (index: number) => {
    pendingFocus.current = index;
    setFocusIndex(index);
  };

  const toggleRow = (id: string) => {
    if (selection === 'none') return;
    onSelectionChange?.(toggleSelection(selected, id, selection));
  };

  const body: BodyProps<Row> = {
    columns,
    rows,
    getRowId,
    density,
    selection,
    selectedIds: selected,
    interactive,
    focusIndex: Math.min(focusIndex, Math.max(0, rows.length - 1)),
    labels,
    windowed,
    onRowKeyDown: (event, index, row) => {
      if (event.target !== event.currentTarget) return;
      const action = rowKeyAction(event.key, index, rows.length);
      if (action === null) return;
      event.preventDefault();
      if (action === 'activate') {
        if (onRowActivate) onRowActivate(row);
        else toggleRow(getRowId(row));
      } else if (action === 'toggle') toggleRow(getRowId(row));
      else focusRow(action);
    },
    onRowClick: (event, index, row) => {
      const target = event.target as HTMLElement;
      if (target.closest('a, button, input, [role="checkbox"], [role="button"]')) return;
      setFocusIndex(index);
      if (selection === 'single') toggleRow(getRowId(row));
      onRowActivate?.(row);
    },
    onToggleRow: toggleRow,
  };

  const allState = allSelectedState(selected, rowIds);
  const busy = status === 'loading' || refreshing;

  return (
    <div data-slot="table" data-density={density} data-status={status} className={cn('relative w-full', className)}>
      <div
        ref={attachScroll}
        data-slot="table-scroll"
        role={scrollable ? 'region' : undefined}
        aria-label={scrollable ? label : undefined}
        tabIndex={scrollable && (!interactive || windowed) ? 0 : undefined}
        style={scrollHeight ? { maxHeight: scrollHeight } : undefined}
        className={cn('w-full overflow-x-auto', scrollHeight && 'overflow-y-auto', scrollable && (!interactive || windowed) && focusRing)}
      >
        <table
          role={selection !== 'none' || onRowActivate ? 'grid' : undefined}
          aria-multiselectable={selection === 'multiple' ? true : undefined}
          aria-busy={busy || undefined}
          aria-rowcount={windowed ? rows.length + 1 : undefined}
          style={minWidth === undefined ? undefined : { minWidth }}
          className="w-full table-fixed border-separate border-spacing-0 text-fg"
        >
          <caption className="sr-only">{label}</caption>
          <colgroup>
            {selection === 'multiple' ? <col style={{ width: 40 }} /> : null}
            {columns.map((column) => (
              <col key={column.id} style={widthStyle(column.width)} />
            ))}
          </colgroup>
          <thead>
            <tr aria-rowindex={windowed ? 1 : undefined} className={headHeightClass[density]}>
              {selection === 'multiple' ? (
                <th
                  scope="col"
                  className={cn('w-10 border-b border-line bg-bg font-normal', cellPadding[density], stickyHeader && 'sticky top-0 z-10')}
                >
                  <Checkbox
                    aria-label={labels.selectAll}
                    checked={allState === 'all'}
                    indeterminate={allState === 'some'}
                    disabled={!showRows}
                    onCheckedChange={() => onSelectionChange?.(toggleAll(selected, rowIds))}
                  />
                </th>
              ) : null}
              {columns.map((column, c) => {
                const align = alignOf(column);
                const sortState = ariaSortOf(sort, column.id);
                const sortable = column.sortable === true && onSortChange !== undefined;
                return (
                  <th
                    key={column.id}
                    scope="col"
                    data-align={align}
                    aria-sort={column.sortable ? sortState : undefined}
                    className={cn(
                      'border-b border-line bg-bg text-xs font-normal text-fg-2',
                      cellPadding[density],
                      alignClass[align],
                      'overflow-hidden text-ellipsis whitespace-nowrap',
                      stickyHeader && 'sticky top-0 z-10',
                      column.pin === 'start' && c === 0 && cn('left-0 z-20', !stickyHeader && 'sticky'),
                    )}
                  >
                    {sortable ? (
                      <button
                        type="button"
                        data-slot="table-sort"
                        aria-label={column.headerLabel}
                        onClick={() => onSortChange(nextSort(sort, column.id, sortTypeOf(column)))}
                        className={cn(
                          'inline-flex max-w-full items-center gap-1 rounded-xs text-xs font-normal transition-colors duration-(--if-t-fast) ease-if hover:text-fg',
                          align === 'end' && 'flex-row-reverse',
                          sortState !== 'none' && 'text-fg',
                          focusRing,
                        )}
                      >
                        <span className="overflow-hidden text-ellipsis">{column.header}</span>
                        <SortGlyph state={sortState} />
                      </button>
                    ) : column.headerLabel && !column.header ? (
                      <span className="sr-only">{column.headerLabel}</span>
                    ) : (
                      column.header
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody aria-busy={busy || undefined}>
            {status === 'loading' ? (
              <>
                <tr>
                  <td colSpan={columnCount} className="sr-only">
                    <span role="status">{labels.loading}</span>
                  </td>
                </tr>
                {Array.from({ length: loadingRows }, (_, r) => (
                  <tr key={r} data-slot="table-skeleton-row" className={rowHeightClass[density]}>
                    {selection === 'multiple' ? <td className="w-10" /> : null}
                    {columns.map((column) => (
                      <td key={column.id} className={cellPadding[density]}>
                        <Skeleton
                          height={12}
                          className={cn('rounded-xs', alignOf(column) === 'end' && 'ml-auto', column.numeric ? 'w-3/5' : 'w-4/5')}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </>
            ) : status === 'error' ? (
              <tr data-slot="table-error-row">
                <td colSpan={columnCount} className="p-0">
                  {errorState ?? <StateBlock kind="error" thing={label} onRetry={onRetry ?? (() => undefined)} />}
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr data-slot="table-empty-row">
                <td colSpan={columnCount} className="p-0">
                  {emptyState ?? <StateBlock kind="empty" title="Nothing to show" />}
                </td>
              </tr>
            ) : windowed ? (
              <VirtualRows
                body={body}
                scrollEl={scrollEl}
                height={scrollHeight ?? 480}
                overscan={overscan}
                colSpan={columnCount}
                pendingFocus={pendingFocus}
              />
            ) : (
              rows.map((row, index) => <RowView key={getRowId(row)} row={row} index={index} body={body} />)
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
