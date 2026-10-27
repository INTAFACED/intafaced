/**
 * Owner: lane B2 (templates). A table that becomes stacked rows under the compact width (no sideways scroll on a
 * phone, no labels broken mid-word: room-inventory flaws 4 and 6). Each cell carries its column's label for the
 * stacked form. Selection, when given, is a real link or button per row, so it works by keyboard.
 */
import * as React from 'react';

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
}

export function Table<Row>({ caption, columns, rows, rowKey, mode = 'simple', rowHref, selected }: TableProps<Row>) {
  const cols = columns.filter((c) => mode === 'pro' || !c.pro);
  return (
    <table className="lt-table" data-mode={mode}>
      <caption className="lt-sr">{caption}</caption>
      <thead>
        <tr>
          {cols.map((c) => (
            <th key={c.key} scope="col" data-align={c.align ?? 'start'}>
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const key = rowKey(row);
          return (
            <tr key={key} data-selected={selected === key || undefined}>
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
