/**
 * Owner: lane B2 (templates). A table that becomes stacked rows under the compact width (no sideways scroll on a
 * phone, no labels broken mid-word: room-inventory flaws 4 and 6). Each cell carries its column's label for the
 * stacked form. Selection, when given, is a real link or button per row, so it works by keyboard.
 */
import * as React from 'react';
import { ariaSortOf, nextSort, sortRows, type SortState, type SortType } from '../../components/table-logic.js';

export { nextSort, sortRows, type SortState, type SortType };

export interface Column<Row> {
  key: string;
  label: string;
  cell: (row: Row) => React.ReactNode;
  /** Figures align to the end. */
  align?: 'start' | 'end';
  /** Shown only in Pro (column chooser default). */
  pro?: boolean;
  /** References, addresses: left-to-right even in a right-to-left page. */
  ltr?: boolean;
  /** Its header sorts the table (the room sorts the rows with `sortRows` and passes `sort`); `decimal` for figures. */
  sortType?: SortType;
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
  /**
   * Makes the rows pickable: the table becomes a `grid`, each row one Tab stop with `aria-selected`; a click on the
   * row (not on a control inside it), Enter or Space picks it, and the arrow keys, Home and End move between rows.
   */
  onSelect?: (key: string) => void;
  /** The sort in force; a column with `sortType` gets a header button that asks `onSort` for the next one. */
  sort?: SortState | null;
  onSort?: (next: SortState) => void;
  /** Shown in the body when there are no rows (an honest empty line, never a blank table). */
  empty?: React.ReactNode;
}

export function Table<Row>({
  caption,
  columns,
  rows,
  rowKey,
  mode = 'simple',
  rowHref,
  selected,
  onSelect,
  sort,
  onSort,
  empty,
}: TableProps<Row>) {
  const cols = columns.filter((c) => mode === 'pro' || !c.pro);
  const sorts = sort !== undefined && onSort !== undefined;
  const body = React.useRef<HTMLTableSectionElement>(null);
  const keys = rows.map(rowKey);
  const stop = Math.max(0, selected === undefined ? 0 : keys.indexOf(selected));
  const focusRow = (index: number) => body.current?.querySelectorAll<HTMLElement>('tr[data-row]')[index]?.focus();
  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    if (!onSelect || event.target !== event.currentTarget) return;
    const step = gridKey(event.key, index, keys.length);
    if (step === null) return;
    event.preventDefault();
    const key = keys[index];
    if (step !== 'pick') focusRow(step);
    else if (key !== undefined) onSelect(key);
  };
  return (
    <table className="lt-table" data-mode={mode} role={onSelect ? 'grid' : undefined}>
      <caption className="lt-sr">{caption}</caption>
      <thead>
        <tr>
          {cols.map((c) => (
            <th
              key={c.key}
              scope="col"
              data-align={c.align ?? 'start'}
              aria-sort={sorts && c.sortType ? ariaSortOf(sort ?? null, c.key) : undefined}
            >
              {sorts && c.sortType ? (
                <button type="button" className="lt-sort" onClick={() => onSort(nextSort(sort ?? null, c.key, c.sortType))}>
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
      <tbody ref={body}>
        {rows.length === 0 && empty !== undefined ? (
          <tr data-empty="">
            <td colSpan={cols.length}>{empty}</td>
          </tr>
        ) : null}
        {rows.map((row, index) => {
          const key = rowKey(row);
          return (
            <tr
              key={key}
              data-row=""
              data-selected={selected === key || undefined}
              aria-selected={onSelect ? selected === key : undefined}
              tabIndex={onSelect ? (index === stop ? 0 : -1) : undefined}
              onClick={
                onSelect
                  ? (event) => {
                      if (event.target instanceof Element && event.target.closest('a, button, input, select, textarea')) return;
                      onSelect(key);
                    }
                  : undefined
              }
              onKeyDown={onSelect ? (event) => onKeyDown(event, index) : undefined}
            >
              {cols.map((c, i) => {
                const content = c.cell(row);
                return (
                  <td key={c.key} data-label={c.label} data-align={c.align ?? 'start'}>
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
        })}
      </tbody>
    </table>
  );
}

/** What a key does on a pickable row at `index`: pick it, move to another row's index, or nothing (null). */
export function gridKey(key: string, index: number, count: number): 'pick' | number | null {
  if (key === 'Enter' || key === ' ') return 'pick';
  if (key === 'ArrowDown') return Math.min(count - 1, index + 1);
  if (key === 'ArrowUp') return Math.max(0, index - 1);
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  return null;
}
