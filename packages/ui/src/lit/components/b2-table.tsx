/**
 * Owner: lane B2 (templates). A table that becomes stacked rows under the compact width (no sideways scroll on a
 * phone, no labels broken mid-word: room-inventory flaws 4 and 6). Each cell carries its column's label for the
 * stacked form. Selection, when given, is a real link or button per row, so it works by keyboard. A long list sorts
 * by its headers and, with `virtual`, draws only the rows near the window's view.
 */
import * as React from 'react';
import { useWindowVirtualizer } from '@tanstack/react-virtual';
import { ariaSortOf, nextSort, sortRows, type SortState, type SortType } from '../../components/table-logic.js';

export { nextSort, sortRows, type SortState, type SortType };

/** A row's or a cell's own `data-*` marks (what the room's tests find it by). */
export type DataMarks = Readonly<Record<`data-${string}`, string | undefined>>;

export interface Column<Row> {
  key: string;
  label: string;
  cell: (row: Row) => React.ReactNode;
  /** The cell's own marks (`data-cell`, `data-testid`). */
  cellMarks?: (row: Row) => DataMarks;
  /** Figures align to the end. */
  align?: 'start' | 'end';
  /** Shown only in Pro (column chooser default). */
  pro?: boolean;
  /** References, addresses: left-to-right even in a right-to-left page. */
  ltr?: boolean;
  /** Its header sorts the table (the room sorts the rows with `sortRows` and passes `sort`); `decimal` for figures. */
  sortType?: SortType;
  /** The header button's name, when the label alone doesn't say it sorts (`Sort by Price`). */
  sortLabel?: string;
}

/**
 * A long list: past `after` rows (default 50) only the rows near the window's view are drawn (TanStack Virtual), and
 * spacer rows keep the rest's height, so the page scrolls as if every row were there. `estimate` is a row's height in
 * CSS pixels before it is measured. The arrow keys, Home and End move between rows' links (`.lt-row-link` or a cell's
 * own `[data-row-link]`), scrolling an undrawn row into view first.
 */
export interface VirtualRows {
  estimate: number;
  after?: number;
  overscan?: number;
}

export interface TableProps<Row> {
  caption: string;
  columns: readonly Column<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  mode?: 'simple' | 'pro';
  /** Opens the row's record; makes the first cell a link. */
  rowHref?: (row: Row) => string;
  selected?: string;
  /** The sort in force; a column with `sortType` gets a header button that asks `onSort` for the next one. */
  sort?: SortState | null;
  onSort?: (next: SortState) => void;
  /** Shown in the body when there are no rows (an honest empty line, never a blank table). */
  empty?: React.ReactNode;
  /** The row's own marks (`data-testid`, the record's id). */
  rowMarks?: (row: Row) => DataMarks;
  virtual?: VirtualRows;
}

const LINK = '[data-row-link], .lt-row-link';

/** Where an arrow, Home or End key moves from row `index` of `count`, or null when it doesn't move. */
export function rowStep(key: string, index: number, count: number): number | null {
  const next = key === 'ArrowDown' ? index + 1 : key === 'ArrowUp' ? index - 1 : key === 'Home' ? 0 : key === 'End' ? count - 1 : null;
  return next === null || next < 0 || next >= count || next === index ? null : next;
}

function moveFocus(event: React.KeyboardEvent<HTMLElement>, count: number, reveal?: (index: number) => void) {
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.matches(LINK)) return;
  // A row's place in the list (an index, never money).
  const current = Number.parseInt(target.closest<HTMLElement>('tr[data-index]')?.dataset.index ?? '', 10);
  const next = Number.isNaN(current) ? null : rowStep(event.key, current, count);
  if (next === null) return;
  event.preventDefault();
  const body = event.currentTarget;
  const focus = () => body.querySelector<HTMLElement>(`tr[data-index="${next}"] :is(${LINK})`)?.focus();
  if (body.querySelector(`tr[data-index="${next}"]`) || !reveal) focus();
  else {
    reveal(next);
    requestAnimationFrame(() => requestAnimationFrame(focus));
  }
}

type RenderRow<Row> = (row: Row, index: number, extra?: { ref: (node: HTMLTableRowElement | null) => void }) => React.ReactNode;

function Spacer({ size, span }: { size: number; span: number }) {
  if (size <= 0) return null;
  return (
    <tr aria-hidden="true" data-spacer="">
      <td colSpan={span} style={{ blockSize: size }} />
    </tr>
  );
}

function WindowBody<Row>({
  rows,
  span,
  virtual,
  renderRow,
}: {
  rows: readonly Row[];
  span: number;
  virtual: VirtualRows;
  renderRow: RenderRow<Row>;
}) {
  const body = React.useRef<HTMLTableSectionElement>(null);
  const [margin, setMargin] = React.useState(0);
  // The list's distance from the page's top, which the window virtualiser counts from; measured after each layout.
  React.useLayoutEffect(() => {
    const measure = () => {
      const top = body.current ? body.current.getBoundingClientRect().top + window.scrollY : 0;
      setMargin((previous) => (Math.abs(previous - top) < 1 ? previous : top));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  });
  const virtualizer = useWindowVirtualizer({
    count: rows.length,
    estimateSize: () => virtual.estimate,
    overscan: virtual.overscan ?? 8,
    scrollMargin: margin,
    // Before the window is measured (the first paint, a server render) assume a screen of about 16 rows, so the
    // first rows draw at once instead of an empty list.
    initialRect: { width: 0, height: typeof window === 'undefined' ? virtual.estimate * 16 : window.innerHeight },
  });
  const items = virtualizer.getVirtualItems();
  const first = items[0];
  const last = items.at(-1);
  const before = first ? first.start - margin : 0;
  const after = last ? virtualizer.getTotalSize() - (last.end - margin) : virtualizer.getTotalSize();
  return (
    <tbody ref={body} onKeyDown={(event) => moveFocus(event, rows.length, (index) => virtualizer.scrollToIndex(index))}>
      <Spacer size={before} span={span} />
      {items.map((item) => {
        const row = rows[item.index];
        return row === undefined ? null : renderRow(row, item.index, { ref: virtualizer.measureElement });
      })}
      <Spacer size={after} span={span} />
    </tbody>
  );
}

export function Table<Row>({
  caption,
  columns,
  rows,
  rowKey,
  mode = 'simple',
  rowHref,
  selected,
  sort,
  onSort,
  empty,
  rowMarks,
  virtual,
}: TableProps<Row>) {
  const cols = columns.filter((c) => mode === 'pro' || !c.pro);
  const sorts = sort !== undefined && onSort !== undefined;
  const windowed = virtual !== undefined && rows.length > (virtual.after ?? 50);
  const renderRow: RenderRow<Row> = (row, index, extra) => {
    const key = rowKey(row);
    return (
      <tr
        {...rowMarks?.(row)}
        key={key}
        ref={extra?.ref}
        data-row=""
        data-index={virtual ? index : undefined}
        aria-rowindex={windowed ? index + 2 : undefined}
        data-selected={selected === key || undefined}
      >
        {cols.map((c, i) => {
          const content = c.cell(row);
          return (
            <td {...c.cellMarks?.(row)} key={c.key} data-label={c.label} data-align={c.align ?? 'start'}>
              {/* The cell lays out from the page's direction (its label mirrors); only the value is isolated, and only a
                  left-to-right value takes the mono face. */}
              {i === 0 && rowHref ? (
                <a className="lt-row-link" href={rowHref(row)}>
                  <bdi dir={c.ltr ? 'ltr' : undefined} data-ltr={c.ltr ? '' : undefined} className={c.ltr ? 'lt-mono' : undefined}>
                    {content}
                  </bdi>
                </a>
              ) : (
                <bdi dir={c.ltr ? 'ltr' : undefined} data-ltr={c.ltr ? '' : undefined} className={c.ltr ? 'lt-mono' : undefined}>
                  {content}
                </bdi>
              )}
            </td>
          );
        })}
      </tr>
    );
  };
  const emptyRow =
    rows.length === 0 && empty !== undefined ? (
      <tr data-empty="">
        <td colSpan={cols.length}>{empty}</td>
      </tr>
    ) : null;
  return (
    <table className="lt-table" data-mode={mode} aria-rowcount={windowed ? rows.length + 1 : undefined}>
      <caption className="lt-sr">{caption}</caption>
      <thead>
        <tr aria-rowindex={windowed ? 1 : undefined}>
          {cols.map((c) => (
            <th
              key={c.key}
              scope="col"
              data-align={c.align ?? 'start'}
              aria-sort={sorts && c.sortType ? ariaSortOf(sort ?? null, c.key) : undefined}
            >
              {sorts && c.sortType ? (
                <button
                  type="button"
                  className="lt-sort"
                  aria-label={c.sortLabel}
                  onClick={() => onSort(nextSort(sort ?? null, c.key, c.sortType))}
                >
                  {c.label}
                  <span className="lt-sort-mark" aria-hidden="true">
                    {ariaSortOf(sort ?? null, c.key) === 'ascending' ? '▲' : ariaSortOf(sort ?? null, c.key) === 'descending' ? '▼' : ''}
                  </span>
                </button>
              ) : (
                c.label
              )}
            </th>
          ))}
        </tr>
      </thead>
      {windowed ? (
        <WindowBody rows={rows} span={cols.length} virtual={virtual} renderRow={renderRow} />
      ) : (
        <tbody onKeyDown={virtual ? (event) => moveFocus(event, rows.length) : undefined}>
          {emptyRow}
          {rows.map((row, index) => renderRow(row, index))}
        </tbody>
      )}
    </table>
  );
}
