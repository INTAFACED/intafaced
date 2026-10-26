import { useMemo, useState } from 'react';
import type { z } from 'zod';
import { useResource, type Resource } from '../../../../shared/resource';
import { Button, DataTable } from '@intafaced/ui';
import { Field } from '../../ui-kit';
import { PaySection } from '../../components';
import {
  BackLink,
  Chip,
  Facts,
  Gate,
  Kpi,
  KpiGrid,
  ListShell,
  Money,
  MoneyLines,
  MoreFooter,
  PortalFailure,
  PortalLoading,
} from '../components';
import { KpiStrip } from '../ui/Kpi';
import { buildCsv, downloadText } from '../csv';
import { portalCopy } from './copy';
import { useCursorList, useUrlParam, type ListState } from '../hooks';
import { DAY_MS, addDays, utcDay } from '../model';
import { seriesTotals } from './model';
import { DateTime, UTC } from '../ui/DateTime';
import type { CustomerSeries } from './schemas';
import type { PortalApi } from '../api';
import type { Customer, CustomerDetail, customerSummarySchema } from '../schemas';

type Summary = z.infer<typeof customerSummarySchema>;
/** "1 subscription, 2 mandates": the count and its noun agree. */
function recurringNote(t: (key: any, vars?: any) => string, subs: number, mandates: number): string {
  return t('recurringNote', {
    subs: subs === 1 ? t('subscriptionsOne') : t('subscriptionsMany', { n: subs }),
    mandates: mandates === 1 ? t('mandatesOne') : t('mandatesMany', { n: mandates }),
  });
}
export const customerHref = (ref: string) => `/pay/customers/${encodeURIComponent(ref)}`;

/** `/pay/customers`: the references your payments carried. Nothing else about a person is stored. */
export function Customers({ portal }: { portal: PortalApi }) {
  const [search, setSearch] = useUrlParam('q', '');
  const activeSince = useMemo(() => new Date(Date.now() - 30 * DAY_MS).toISOString(), []);
  const summary = useResource((s) => portal.customerSummary(activeSince, s), 'portal:customer-summary');
  const list = useCursorList(
    (cursor, s) => portal.customers(cursor, search, s),
    `portal:customers:${search}`,
    (c) => c.customerRef,
  );
  return (
    <CustomersView
      summary={summary.resource}
      list={list.state}
      search={search}
      setSearch={setSearch}
      loadMore={list.loadMore}
      retry={() => {
        summary.reload();
        list.reload();
      }}
    />
  );
}

export function CustomersView({
  summary,
  list,
  search,
  setSearch,
  loadMore,
  retry,
}: {
  summary: Resource<Summary>;
  list: ListState<Customer>;
  search: string;
  setSearch: (value: string) => void;
  loadMore: () => void;
  retry: () => void;
}) {
  const { t } = portalCopy.useCopy();
  const [draft, setDraft] = useState(search);
  if (list.status === 'failed' && summary.status === 'failed') return <PortalFailure result={list.failure} retry={retry} />;
  return (
    <div className="stack">
      <Gate resource={summary} retry={retry} rows={2}>
        {(s) => (
          <KpiStrip
            label={t('customerKpis')}
            tiles={[
              { label: t('kpiCustomers'), period: t('periodAllTime'), href: '/pay/customers', value: s.customerCount },
              {
                label: t('kpiActive30'),
                period: t('periodLast30'),
                href: '/pay/payments?date=30d',
                value: s.activeSinceCount,
                note: t('kpiActive30Note'),
              },
              {
                label: t('kpiRepeat'),
                period: t('periodAllTime'),
                href: '/pay/customers',
                value: s.customerCount === 0 ? '—' : `${Math.round((s.repeatCustomerCount * 100) / s.customerCount)}%`,
                note: t('kpiRepeatNote', { count: s.repeatCustomerCount }),
              },
              {
                label: t('kpiNew'),
                period: t('periodAllTime'),
                href: '/pay/customers',
                value: Math.max(0, s.customerCount - s.repeatCustomerCount),
                note: t('kpiNewNote'),
              },
            ]}
          />
        )}
      </Gate>
      <PaySection title={t('customersTitle')} description={t('customersBody')}>
        <form
          data-testid="pay-filters"
          className="pay-filters"
          role="search"
          aria-label={t('customersSearchLabel')}
          onSubmit={(event) => {
            event.preventDefault();
            setSearch(draft.trim());
          }}
        >
          <Field
            label={t('searchRef')}
            type="search"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            maxLength={200}
            hint={t('searchRefHint')}
          />
          <Button type="submit" variant="secondary">
            {t('search')}
          </Button>
          {search && (
            <Button
              variant="ghost"
              onClick={() => {
                setDraft('');
                setSearch('');
              }}
            >
              {t('clearSearch')}
            </Button>
          )}
        </form>
        <ListShell
          state={list}
          retry={retry}
          empty={{
            title: search ? t('customersNoMatchTitle') : t('customersEmptyTitle'),
            body: search ? t('customersNoMatchBody', { q: search }) : t('customersEmptyBody'),
          }}
        >
          {(rows) => (
            <>
              <DataTable
                label={t('customersTitle')}
                headers={[t('colReference'), t('colPayments'), t('colCaptured'), t('colRefunded'), t('colFirstSeen'), t('colLastSeen')]}
              >
                {rows.map((c) => (
                  <tr key={c.customerRef}>
                    <th scope="row">
                      <a data-testid="pp-mono" className="text-link pp-mono" href={customerHref(c.customerRef)}>
                        {c.customerRef}
                      </a>
                      {(c.subscriptionCount > 0 || c.mandateCount > 0) && (
                        <small className="pay-cell-note">{recurringNote(t, c.subscriptionCount, c.mandateCount)}</small>
                      )}
                    </th>
                    <td className="numeric">
                      <a className="text-link" href={`/pay/payments?q=${encodeURIComponent(c.customerRef)}`}>
                        {c.paymentCount}
                      </a>
                    </td>
                    <td>
                      <MoneyLines items={c.totals.map((x) => ({ assetCode: x.assetId, amount: x.capturedAmount }))} />
                    </td>
                    <td>
                      <MoneyLines items={c.totals.map((x) => ({ assetCode: x.assetId, amount: x.refundedAmount }))} />
                    </td>
                    <td>
                      <DateTime value={c.firstSeenAt} />
                    </td>
                    <td>
                      <DateTime value={c.lastSeenAt} />
                    </td>
                  </tr>
                ))}
              </DataTable>
              {list.status === 'ready' && <MoreFooter state={list} onMore={loadMore} />}
              <Button
                variant="secondary"
                onClick={() =>
                  downloadText(
                    'customers.csv',
                    buildCsv(
                      ['reference', 'payments', 'captured', 'refunded', 'first_seen', 'last_seen'],
                      rows.map((c) => [
                        c.customerRef,
                        c.paymentCount,
                        c.totals.map((x) => `${x.capturedAmount} ${x.assetId}`).join('; '),
                        c.totals.map((x) => `${x.refundedAmount} ${x.assetId}`).join('; '),
                        c.firstSeenAt,
                        c.lastSeenAt,
                      ]),
                      { generatedAt: new Date().toISOString(), asOf: new Date().toISOString() },
                    ),
                  )
                }
              >
                {t('exportPage')}
              </Button>
            </>
          )}
        </ListShell>
        <p className="muted pp-note">{t('privacyNote')}</p>
      </PaySection>
    </div>
  );
}

export function CustomerDetailPage({ portal, customerRef }: { portal: PortalApi; customerRef: string }) {
  const customer = useResource((s) => portal.customer(customerRef, s), `portal:customer:${customerRef}`);
  const window = useMemo(() => {
    const today = utcDay(new Date());
    return { from: `${addDays(today, -29)}T00:00:00.000Z`, to: `${addDays(today, 1)}T00:00:00.000Z`, today };
  }, []);
  const series = useResource((s) => portal.customerSeries(customerRef, window.from, window.to, s), `portal:customer-series:${customerRef}`);
  return <CustomerDetailView customer={customer.resource} series={series.resource} today={window.today} reload={customer.reload} />;
}

export function CustomerDetailView({
  customer,
  series,
  today,
  reload,
}: {
  customer: Resource<CustomerDetail>;
  series?: Resource<CustomerSeries>;
  today?: string;
  reload: () => void;
}) {
  const { t } = portalCopy.useCopy();
  return (
    <div className="stack">
      <BackLink href="/pay/customers">{t('backToCustomers')}</BackLink>
      <Gate resource={customer} retry={reload} rows={4}>
        {(c) => (
          <>
            <PaySection title={t('lifetimeTitle')} description={t('lifetimeBody')}>
              <KpiGrid label={t('lifetimeTitle')}>
                <Kpi
                  label={t('kpiCaptured')}
                  period={t('periodLifetime')}
                  value={<MoneyLines items={c.totals.map((x) => ({ assetCode: x.assetId, amount: x.capturedAmount }))} />}
                />
                <Kpi
                  label={t('kpiRefunded')}
                  period={t('periodLifetime')}
                  value={<MoneyLines items={c.totals.map((x) => ({ assetCode: x.assetId, amount: x.refundedAmount }))} />}
                />
                <Kpi label={t('kpiCount')} period={t('periodLifetime')} value={c.paymentCount} />
                <Kpi
                  label={t('kpiRecurring')}
                  value={c.subscriptionCount + c.mandateCount}
                  note={recurringNote(t, c.subscriptionCount, c.mandateCount)}
                />
                <Kpi label={t('colFirstSeen')} value={<DateTime value={c.firstSeenAt} />} />
                <Kpi label={t('colLastSeen')} value={<DateTime value={c.lastSeenAt} />} />
              </KpiGrid>
              <Facts
                items={[
                  [
                    t('colReference'),
                    <span data-testid="pp-mono" className="pp-mono pp-copy">
                      {c.customerRef}
                    </span>,
                  ],
                ]}
              />
              {series && today && <DailySeries series={series} today={today} retry={reload} />}
              <a className="text-link" href={`/pay/payments?q=${encodeURIComponent(c.customerRef)}`}>
                {t('customerAllPayments')}
              </a>
            </PaySection>
            <PaySection
              title={t('recentPayments')}
              description={
                c.recentPayments.length === 1 ? t('recentPaymentsBodyOne') : t('recentPaymentsBody', { count: c.recentPayments.length })
              }
            >
              {c.recentPayments.length === 0 ? (
                <p className="muted">{t('noRecentPayments')}</p>
              ) : (
                <DataTable label={t('recentPayments')} headers={[t('colPayment'), t('colAmount'), t('colStatus'), t('colOpened')]}>
                  {c.recentPayments.map((p) => (
                    <tr key={p.paymentId}>
                      <th scope="row">
                        <a className="text-link" href={`/pay/payments/${encodeURIComponent(p.paymentId)}`}>
                          {t('openPayment')}
                        </a>
                      </th>
                      <td>
                        <Money value={p.amount} asset={p.assetId} />
                      </td>
                      <td>
                        <Chip kind="payment" value={p.status} />
                      </td>
                      <td>
                        <DateTime value={p.createdAt} />
                      </td>
                    </tr>
                  ))}
                </DataTable>
              )}
            </PaySection>
          </>
        )}
      </Gate>
    </div>
  );
}

/** A day, with no time: the daily table counts whole UTC days, so "12:00 AM" would be a made-up hour. */
function DayOnly({ period }: { period: string }) {
  return <DateTime value={`${period}T00:00:00.000Z`} timeZone={UTC} dayOnly />;
}
function DailySeries({ series, today, retry }: { series: Resource<CustomerSeries>; today: string; retry: () => void }) {
  const { t } = portalCopy.useCopy();
  if (series.status === 'loading') return <PortalLoading rows={2} />;
  if (series.status === 'failed') return <PortalFailure result={series.failure} retry={retry} />;
  const items = series.data.items;
  const windows: Array<[string, string]> = [
    [t('periodToday'), today],
    [t('period7d'), addDays(today, -6)],
    [t('period30d'), addDays(today, -29)],
  ];
  const peak = items.reduce((m, i) => (parseFloat(i.volume) > m ? parseFloat(i.volume) : m), 0);
  return (
    <section aria-label={t('customerSeriesTitle')} className="stack">
      <h3 className="pp-sub">{t('customerSeriesTitle')}</h3>
      <KpiStrip
        label={t('customerSeriesTitle')}
        tiles={windows.map(([label, since]) => {
          const totals = seriesTotals(items, since);
          return {
            label: t('kpiCaptured'),
            period: label,
            href: `/pay/payments?q=${encodeURIComponent(series.data.customerRef)}&status=captured`,
            value: totals.length ? <MoneyLines items={totals.map((x) => ({ assetCode: x.assetCode, amount: x.volume }))} /> : '—',
            note: (() => {
              const count = totals.reduce((n, x) => n + x.count, 0);
              return count === 1 ? t('seriesCountOne') : t('seriesCount', { count });
            })(),
          };
        })}
      />
      {items.length === 0 ? (
        <p className="muted">{t('seriesEmpty')}</p>
      ) : (
        <DataTable label={t('customerSeriesTitle')} headers={[t('colDay'), t('colPayments'), t('colAmount'), t('seriesBar')]}>
          {items.map((i) => (
            <tr key={`${i.period}:${i.assetCode}`}>
              <th scope="row">
                <DayOnly period={i.period} />
              </th>
              <td className="numeric">{i.count}</td>
              <td>
                <Money value={i.volume} asset={i.assetCode} />
              </td>
              <td aria-hidden="true">
                <span
                  style={{
                    display: 'inline-block',
                    height: 8,
                    borderRadius: 4,
                    background: 'currentColor',
                    opacity: 0.35,
                    width: `${peak ? Math.max(4, (parseFloat(i.volume) / peak) * 100) : 0}%`,
                  }}
                />
              </td>
            </tr>
          ))}
        </DataTable>
      )}
    </section>
  );
}
