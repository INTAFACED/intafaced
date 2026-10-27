import { useEffect, useState } from 'react';
import { Button, DataTable, StatusTag } from '@intafaced/ui';
import type { ApiResult } from '../../../shared/api';
import { useResource } from '../../../shared/resource';
import { displayAmount } from '../../../shared/money';
import { payCopy, PayCopy } from '../copy';
import { PayFailure, PaySection, PayState, PayTime } from '../components';
import { Field } from '../ui-kit';
import type { PersonalPayApi } from '../pay-api';
import type { OrderExport, OrderPage, OrderTab } from '../schemas';
import { downloadText } from '../portal/csv';
import { OrderFilterTabs } from './P2PDepth';
import { UnreadBadge, useUnreadCounts } from './Unread';
import type { UnreadCount } from './p2p-chat-model';
import { p2pDepth } from './p2p-depth-copy';
import { orderHistoryCopy } from './order-history-copy';
import type { OrderFilter } from './p2p-model';

const PAGE = 50;
const TAB: Record<Exclude<OrderFilter, 'all'>, OrderTab> = {
  active: 'in_progress',
  disputed: 'in_dispute',
  completed: 'completed',
  cancelled: 'cancelled',
};
type Row = OrderPage['trades'][number];

/** The order list read from the service: its own tab counts, keyset pages newest first, and the readable status it derives. */
export function OrderHistory({ pay, userId }: { pay: PersonalPayApi; userId: string | null }) {
  const [filter, setFilter] = useState<OrderFilter>('all');
  const tab = filter === 'all' ? undefined : TAB[filter];
  const first = useResource((signal) => pay.orderPage({ limit: PAGE, tab }, signal), `pay:order-page:${userId}:${filter}`);
  return (
    <div className="stack">
      <PaySection
        title={payCopy.t('yourOrders')}
        description={payCopy.t('terminalStatusAndLedgerSettlementTimeStay')}
        action={
          <Button variant="secondary" onClick={first.reload}>
            <PayCopy k="refreshOrders" />
          </Button>
        }
      >
        {/* A reload or another tab shows loading first, so each answer mounts its own pages afresh. */}
        <PayState resource={first.resource} retry={first.reload}>
          {(page) => <OrderPages pay={pay} userId={userId} first={page} filter={filter} tab={tab} onFilter={setFilter} />}
        </PayState>
      </PaySection>
      <ExportOrders pay={pay} />
    </div>
  );
}

function OrderPages({
  pay,
  userId,
  first,
  filter,
  tab,
  onFilter,
}: {
  pay: PersonalPayApi;
  userId: string | null;
  first: OrderPage;
  filter: OrderFilter;
  tab: OrderTab | undefined;
  onFilter: (filter: OrderFilter) => void;
}) {
  const { t } = orderHistoryCopy.useCopy();
  const [pages, setPages] = useState<Row[][]>([first.trades]);
  const [cursor, setCursor] = useState(first.nextCursor);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<Extract<ApiResult<unknown>, { ok: false }> | null>(null);
  const [unread, setUnread] = useState<Record<string, UnreadCount>>({});
  const rows = pages.flat();
  const c = first.counts;
  const counts: Record<OrderFilter, number> = {
    all: c.in_progress + c.in_dispute + c.completed + c.cancelled,
    active: c.in_progress,
    disputed: c.in_dispute,
    completed: c.completed,
    cancelled: c.cancelled,
  };
  const older = async () => {
    if (!cursor) return;
    setLoading(true);
    setFailure(null);
    const result = await pay.orderPage({ limit: PAGE, cursor, tab });
    setLoading(false);
    if (!result.ok) return setFailure(result);
    const seen = new Set(rows.map((row) => row.id));
    setPages((current) => [...current, result.data.trades.filter((row) => !seen.has(row.id))]);
    setCursor(result.data.nextCursor);
  };
  if (counts.all === 0) return <p className="muted">{payCopy.t('noP2pOrdersReturned')}</p>;
  return (
    <>
      <OrderFilterTabs value={filter} counts={counts} onChange={onFilter} note={t('countsNote')} />
      {/* Unread counts per page, so loading an older page reads only the orders it added. */}
      {pages.map((page, index) => (
        <PageUnread key={index} pay={pay} rows={page} onCounts={setUnread} />
      ))}
      {rows.length === 0 ? <p className="muted">{p2pDepth.t('ordersNone')}</p> : <OrderRows userId={userId} rows={rows} unread={unread} />}
      <p className="muted" role="status">
        {t('shownOfTotal', { shown: String(rows.length), total: String(counts[filter]) })}
      </p>
      {failure ? <PayFailure result={failure} retry={older} /> : null}
      {cursor ? (
        <Button variant="secondary" onClick={older} disabled={loading}>
          {loading ? t('loadingOlder') : t('loadOlder')}
        </Button>
      ) : rows.length > 0 ? (
        <p className="muted">{t('reachedOldest')}</p>
      ) : null}
    </>
  );
}

function PageUnread({
  pay,
  rows,
  onCounts,
}: {
  pay: PersonalPayApi;
  rows: Row[];
  onCounts: (merge: (current: Record<string, UnreadCount>) => Record<string, UnreadCount>) => void;
}) {
  const counts = useUnreadCounts(pay, rows);
  useEffect(() => onCounts((current) => ({ ...current, ...counts })), [counts, onCounts]);
  return null;
}

const TONE = { in_progress: 'working', in_dispute: 'pending', completed: 'filled', cancelled: 'failed' } as const satisfies Record<
  OrderTab,
  string
>;

function OrderRows({ userId, rows, unread }: { userId: string | null; rows: Row[]; unread: Record<string, UnreadCount> }) {
  const { t } = orderHistoryCopy.useCopy();
  return (
    <DataTable
      headers={[payCopy.t('order'), payCopy.t('you'), payCopy.t('assetQuantity'), payCopy.t('externalPayment'), t('statusColumn'), '']}
      label={payCopy.t('yourP2pOrders')}
    >
      {rows.map((trade) => (
        <tr key={trade.id} data-order={trade.id}>
          <td>
            {trade.id.slice(0, 8)}
            <small className="pay-cell-note">
              <PayTime value={trade.createdAt} />
            </small>
          </td>
          <td>{trade.buyerId === userId ? payCopy.t('buy') : payCopy.t('sell')}</td>
          <td className="numeric">
            {displayAmount(trade.amount)} {trade.asset}
          </td>
          <td className="numeric">
            {displayAmount(trade.fiatAmount)} {trade.fiatCurrency}
          </td>
          <td>
            <StatusTag status={TONE[trade.tab]} label={t(trade.displayStatus)} />
            <small className="pay-cell-note">
              {trade.settledAt ? payCopy.t('ledgerSettled') : payCopy.t('ledgerSettlementNotConfirmed')}
            </small>
          </td>
          <td>
            <a className="text-link" href={`/chat?tradeId=${encodeURIComponent(trade.id)}`}>
              <PayCopy k="open2" />
            </a>{' '}
            <UnreadBadge count={unread[trade.id]} />
          </td>
        </tr>
      ))}
    </DataTable>
  );
}

const DAY_MS = 86_400_000;
const isoDay = (time: number) => new Date(time).toISOString().slice(0, 10);

/** The words for a typed export or receipt refusal, with the cap or reset time the service named; null for any other. */
export function historyRefusal(
  result: Extract<ApiResult<unknown>, { ok: false }>,
  t: ReturnType<typeof orderHistoryCopy.useCopy>['t'],
  time: (iso: string) => string,
): string | null {
  const text = `${result.code ?? ''} ${result.message}`;
  const days = /export_range_too_large: at most (\d+) days/.exec(text);
  if (days) return t('exportRangeTooLarge', { days: days[1]! });
  const rows = /export_too_many_rows: (\d+) rows, at most (\d+)/.exec(text);
  if (rows) return t('exportTooManyRows', { rows: rows[1]!, max: rows[2]! });
  if (text.includes('p2p.export_range_invalid')) return t('exportRangeInvalid');
  const reset = /receipt_quota_reached: .*resets at (\S+)/.exec(text);
  if (reset) return t('receiptQuotaDaily', { time: time(reset[1]!) });
  if (text.includes('p2p.receipt_quota_reached')) return t('receiptQuotaTrade');
  if (text.includes('p2p.receipt_not_available')) return t('receiptOnlyCompleted');
  const unset = /p2p\.config_unset: (\w+)/.exec(text);
  if (unset) return t('notSetUp', { setting: unset[1]! });
  return null;
}

/** Export a date range as the service's CSV. The service caps the range and the rows; its file is saved as it came. */
function ExportOrders({ pay }: { pay: PersonalPayApi }) {
  const { t } = orderHistoryCopy.useCopy();
  const [from, setFrom] = useState(() => isoDay(Date.now() - 29 * DAY_MS));
  const [to, setTo] = useState(() => isoDay(Date.now()));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ file: string; data: OrderExport } | Extract<ApiResult<unknown>, { ok: false }> | null>(null);
  const run = async () => {
    setBusy(true);
    setResult(null);
    // Whole UTC days: the range starts at the first day's midnight and takes in all of the last day.
    const range = { from: `${from}T00:00:00.000Z`, to: `${to}T23:59:59.999Z` };
    const answer = await pay.exportOrders(range);
    setBusy(false);
    if (!answer.ok) return setResult(answer);
    const file = `p2p-orders-${from}-to-${to}.csv`;
    downloadText(file, answer.data.csv);
    setResult({ file, data: answer.data });
  };
  return (
    <PaySection title={t('exportTitle')} description={t('exportBody')}>
      <form
        className="actions"
        onSubmit={(event) => {
          event.preventDefault();
          void run();
        }}
      >
        <Field label={t('exportFrom')} type="date" value={from} required onChange={(event) => setFrom(event.target.value)} />
        <Field label={t('exportTo')} type="date" value={to} required onChange={(event) => setTo(event.target.value)} />
        <Button type="submit" disabled={busy}>
          {busy ? t('exporting') : t('exportAction')}
        </Button>
      </form>
      {result === null ? null : 'file' in result ? (
        <div role="status" data-testid="order-export">
          <p>{t('exportReady', { file: result.file, rows: String(result.data.rows) })}</p>
          {result.data.totals.length === 0 ? (
            <p className="muted">{t('exportNone')}</p>
          ) : (
            <>
              <h3>{t('exportTotals')}</h3>
              <ul>
                {result.data.totals.map((total) => (
                  <li key={`${total.asset}:${total.fiatCurrency}`}>
                    {t('exportTotalLine', {
                      amount: displayAmount(total.amount),
                      asset: total.asset,
                      fiatAmount: displayAmount(total.fiatAmount),
                      fiat: total.fiatCurrency,
                    })}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      ) : (
        <ExportRefusal result={result} retry={run} />
      )}
    </PaySection>
  );
}

function ExportRefusal({ result, retry }: { result: Extract<ApiResult<unknown>, { ok: false }>; retry: () => void }) {
  const { t } = orderHistoryCopy.useCopy();
  const words = historyRefusal(result, t, (iso) => iso);
  if (!words) return <PayFailure result={result} retry={retry} />;
  return (
    <p data-testid="failure" className="failure" role="alert">
      {words}
    </p>
  );
}
