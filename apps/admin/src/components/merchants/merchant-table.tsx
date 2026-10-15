'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { kybStatusChip, merchantStatusChip } from '@/lib/merchants/chips';
import { assetsIn, filterRows, rowsToCsv, sortRows, type MerchantRow, type SortDir, type SortKey } from '@/lib/merchants/table-model';
import { Amounts, shortId, StateBlock, StatusChip } from './ui';

const COLUMNS: readonly { key: SortKey; label: string; right?: boolean }[] = [
  { key: 'merchantId', label: 'Merchant' },
  { key: 'status', label: 'Status' },
  { key: 'kybStatus', label: 'KYB' },
  { key: 'volume', label: 'Lifetime volume', right: true },
  { key: 'revenue', label: 'Lifetime revenue', right: true },
  { key: 'openFlags', label: 'Flags', right: true },
];

/**
 * The merchant table for one loaded page. Search and sort act on the rows
 * already loaded (the service pages by id and filters on status and KYB), and
 * the page says so. CSV is exactly the rows shown, with generated-at and as-of.
 */
export function MerchantTable({
  rows,
  asOf,
  filterNote,
  emptyHint,
}: {
  rows: readonly MerchantRow[];
  asOf: string | null;
  filterNote: string;
  emptyHint: string;
}) {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: 'merchantId', dir: 'asc' });
  const assets = useMemo(() => assetsIn(rows), [rows]);
  const [asset, setAsset] = useState<string | null>(null);
  const sortAsset = asset ?? assets[0] ?? null;
  const visible = useMemo(() => sortRows(filterRows(rows, query), sort.key, sort.dir, sortAsset), [rows, query, sort, sortAsset]);

  const toggle = (key: SortKey) =>
    setSort((cur) => (cur.key === key ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }));

  function exportCsv() {
    const csv = rowsToCsv(visible, new Date().toISOString(), asOf, filterNote);
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `merchants-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="mp-tablewrap">
      <div className="mp-toolbar">
        <div className="mp-field mp-field--grow">
          <label htmlFor="mp-search">Search this page</label>
          <input
            id="mp-search"
            className="mp-input"
            type="search"
            value={query}
            placeholder="Merchant id, status or KYB"
            onChange={(e) => setQuery(e.target.value)}
            autoComplete="off"
          />
        </div>
        {assets.length > 1 ? (
          <div className="mp-field">
            <label htmlFor="mp-sort-asset">Sort money by</label>
            <select id="mp-sort-asset" className="mp-input" value={sortAsset ?? ''} onChange={(e) => setAsset(e.target.value)}>
              {assets.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <button type="button" className="mp-btn" onClick={exportCsv} disabled={visible.length === 0}>
          Export CSV ({visible.length})
        </button>
      </div>
      <p className="mp-muted mp-rowcount" role="status" aria-live="polite">
        Showing {visible.length} of {rows.length} merchants on this page. Search and sort work on these rows; status and KYB filters run on
        the whole list.
      </p>

      {visible.length === 0 ? (
        rows.length === 0 ? (
          <StateBlock kind="empty" title="No merchants match">
            {emptyHint}
          </StateBlock>
        ) : (
          <StateBlock kind="empty" title="Nothing on this page matches your search">
            Clear the search box, or go to the next page. The search only looks at the rows loaded here.
          </StateBlock>
        )
      ) : (
        <div className="mp-scroll" tabIndex={0} role="region" aria-label="Merchants table, scrolls sideways on small screens">
          <table className="mp-table mp-table--rows">
            <caption className="mp-visually-hidden">Merchants. Column headers are buttons that sort the rows on this page.</caption>
            <thead>
              <tr>
                {COLUMNS.map((c) => (
                  <th
                    key={c.key}
                    scope="col"
                    className={c.right ? 'mp-right' : undefined}
                    aria-sort={sort.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                  >
                    <button type="button" className="mp-sortbtn" onClick={() => toggle(c.key)}>
                      {c.label}
                      <span aria-hidden="true">{sort.key === c.key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}</span>
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((row) => (
                <tr
                  key={row.merchantId}
                  className="mp-clickrow"
                  onClick={(e) => {
                    if ((e.target as HTMLElement).closest('a,button')) return;
                    router.push(`/merchants/${row.merchantId}`);
                  }}
                >
                  <th scope="row">
                    <a className="mp-id" href={`/merchants/${row.merchantId}`} title={row.merchantId}>
                      {shortId(row.merchantId)}
                    </a>
                  </th>
                  <td>
                    <StatusChip spec={merchantStatusChip(row.status)} />
                  </td>
                  <td>
                    <StatusChip spec={kybStatusChip(row.kybStatus)} />
                  </td>
                  <td className="mp-right">
                    <Amounts rows={row.volume} empty="No payments" />
                  </td>
                  <td className="mp-right">
                    <Amounts rows={row.revenue} empty="No fees" />
                  </td>
                  <td className="mp-right mp-num">{row.openFlags === 0 ? <span className="mp-muted">0</span> : row.openFlags}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
