import type { ReactNode } from 'react';
import { DataTable } from '@intafaced/ui';
import { uiCopy } from './copy';

export type EntityColumn<T> = { header: ReactNode; cell: (row: T) => ReactNode };
/** What a row looks like below 720 px: name and time on the left, amount and status on the right. */
export type EntityCard = { title: ReactNode; time?: ReactNode; amount?: ReactNode; status?: ReactNode };

/**
 * The one list. A table from 720 px; below that, two-line cards. Every row opens its detail: the whole row is a
 * link, and an explicit "Open" link serves the keyboard. A summary list with no detail pages passes no `href`.
 */
export function EntityList<T>({
  label,
  rows,
  rowKey,
  columns,
  card,
  href,
}: {
  label: string;
  rows: readonly T[];
  rowKey: (row: T) => string;
  columns: readonly EntityColumn<T>[];
  card: (row: T) => EntityCard;
  href?: (row: T) => string;
}) {
  const { t } = uiCopy.useCopy();
  return (
    <div className="pe-list">
      <div data-testid="pe-table" className="pe-table">
        <DataTable label={label} headers={[...columns.map((c) => c.header), ...(href ? [<span className="pp-sr">{t('open')}</span>] : [])]}>
          {rows.map((row) => (
            <tr key={rowKey(row)} className={href ? 'pe-row' : undefined}>
              {columns.map((column, i) => (
                <td key={i}>{column.cell(row)}</td>
              ))}
              {href && (
                <td>
                  <a className="text-link pe-open" href={href(row)}>
                    {t('open')}
                  </a>
                </td>
              )}
            </tr>
          ))}
        </DataTable>
      </div>
      <ul className="pe-cards" aria-label={label}>
        {rows.map((row) => {
          const c = card(row);
          const body = (
            <>
              <span className="pe-card-main">
                <strong>{c.title}</strong>
                {c.time && <small className="muted">{c.time}</small>}
              </span>
              <span className="pe-card-side">
                {c.amount && <span className="pe-card-amount">{c.amount}</span>}
                {c.status}
              </span>
            </>
          );
          return (
            <li key={rowKey(row)} className="pe-card">
              {href ? (
                <a className="pe-card-link" href={href(row)}>
                  {body}
                </a>
              ) : (
                <div className="pe-card-link">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
