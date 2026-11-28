/**
 * GridTable: the kit's Table (`b2-table.tsx`) for a list whose rows open something (a market's desk, a record): the
 * same look (`lt-table`, stacked under the compact width), named as a `grid`, with a whole-row activation besides the
 * row's own links and buttons. Wider than its region (Pro's extra columns), it scrolls inside its own box
 * (`lt-table-scroll`) and never widens the room. Placeholder rows hold the rows' final place while the list loads.
 */
import * as React from 'react';
import { ariaSortOf, nextSort, type SortState } from '../../components/table-logic.js';
import { Skeleton } from './b2-basics.js';
import type { Column, DataMarks } from './b2-table.js';

export interface GridColumn<Row> extends Column<Row> {
  /** The header says its name to assistive tech only (an action column needs no visible heading). */
  quietLabel?: boolean;
  /**
   * Where the cell goes when the grid is a phone's one-line rows (any column setting it makes it so, under 600px of the
   * room's width): `name` the start, `top` and `bottom` stacked at the end, `hide` left for a wider screen.
   */
  phone?: 'name' | 'top' | 'bottom' | 'hide';
  /** On a device that hovers, the cell shows on the row pointed at or moved to (a row's action). */
  reveal?: boolean;
}

const cellPlace = <Row,>(c: GridColumn<Row>) => ({ 'data-phone': c.phone, 'data-reveal': c.reveal || undefined });

export interface GridTableProps<Row> {
  /** The grid's accessible name. */
  caption: string;
  columns: readonly GridColumn<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  mode?: 'simple' | 'pro';
  /** The sort in force; a column with `sortType` gets a header button that asks `onSort` for the next one. */
  sort?: SortState | null;
  onSort?: (next: SortState) => void;
  /** A click on a row outside its own links and controls. */
  onRowActivate?: (row: Row) => void;
  /** Shown in the body when there are no rows. */
  empty?: React.ReactNode;
  rowMarks?: (row: Row) => DataMarks;
  headMarks?: DataMarks;
  /** The list is loading: this many placeholder rows are drawn in its place, and the grid says it is busy. */
  loadingRows?: number;
  /** The first column stays in view while a wide grid scrolls sideways (a market's name beside its figures). */
  pinFirst?: boolean;
}

/** A pinned cell sits on the panel's own colour, so the cells scrolling under it never show through. */
const PINNED: React.CSSProperties = { position: 'sticky', insetInlineStart: 0, zIndex: 1, background: 'var(--lit-solid-bg)' };

const OWN_CONTROL = 'a, button, input, select, textarea, label, summary, [role="button"], [role="link"]';

export function GridTable<Row>({
  caption,
  columns,
  rows,
  rowKey,
  mode = 'simple',
  sort,
  onSort,
  onRowActivate,
  empty,
  rowMarks,
  headMarks,
  loadingRows,
  pinFirst = false,
}: GridTableProps<Row>) {
  const pin = (index: number) => (pinFirst && index === 0 ? PINNED : undefined);
  const sorts = sort !== undefined && onSort !== undefined;
  const loading = loadingRows !== undefined;
  const activate = (row: Row) => (event: React.MouseEvent<HTMLTableRowElement>) => {
    if (!onRowActivate || (event.target instanceof Element && event.target.closest(OWN_CONTROL))) return;
    onRowActivate(row);
  };
  return (
    <div className="lt-table-scroll" tabIndex={0}>
      <table
        className="lt-table"
        role="grid"
        aria-label={caption}
        data-mode={mode}
        data-phone={columns.some((c) => c.phone) ? 'line' : undefined}
        aria-busy={loading || undefined}
      >
        <thead>
          <tr {...headMarks}>
            {columns.map((c, i) => (
              <th
                style={pin(i)}
                {...c.headMarks}
                {...cellPlace(c)}
                key={c.key}
                scope="col"
                data-align={c.align ?? 'start'}
                aria-sort={sorts && c.sortType ? ariaSortOf(sort ?? null, c.key) : undefined}
              >
                {c.quietLabel ? (
                  <span className="lt-sr">{c.label}</span>
                ) : sorts && c.sortType ? (
                  <button
                    type="button"
                    className="lt-sort"
                    aria-label={c.sortLabel}
                    onClick={() => onSort(nextSort(sort ?? null, c.key, c.sortType))}
                  >
                    {c.label}
                    <span className="lt-sort-mark" aria-hidden="true">
                      {ariaSortOf(sort ?? null, c.key) === 'none' ? null : (
                        <span className={`lt-arrow lt-arrow-${ariaSortOf(sort ?? null, c.key) === 'ascending' ? 'up' : 'down'}`} />
                      )}
                    </span>
                  </button>
                ) : (
                  c.label
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading
            ? Array.from({ length: loadingRows }, (_, index) => (
                <tr key={`ghost-${index}`} data-row="" data-ghost="">
                  {columns.map((c, i) => (
                    <td key={c.key} {...cellPlace(c)} style={pin(i)} data-label={c.label} data-align={c.align ?? 'start'}>
                      <Skeleton shape="text" count={1} />
                    </td>
                  ))}
                </tr>
              ))
            : null}
          {!loading && rows.length === 0 && empty !== undefined ? (
            <tr data-empty="">
              <td colSpan={columns.length}>{empty}</td>
            </tr>
          ) : null}
          {loading
            ? null
            : rows.map((row) => (
                <tr {...rowMarks?.(row)} key={rowKey(row)} data-row="" onClick={onRowActivate ? activate(row) : undefined}>
                  {columns.map((c, i) => (
                    <td
                      {...c.cellMarks?.(row)}
                      {...cellPlace(c)}
                      key={c.key}
                      style={pin(i)}
                      data-label={c.label}
                      data-align={c.align ?? 'start'}
                    >
                      {c.cell(row)}
                    </td>
                  ))}
                </tr>
              ))}
        </tbody>
      </table>
    </div>
  );
}
