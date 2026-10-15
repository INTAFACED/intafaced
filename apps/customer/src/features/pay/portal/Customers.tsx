import { useMemo, useState } from 'react';
import type { z } from 'zod';
import { useResource, type Resource } from '../../../shared/resource';
import { Button, DataTable, Field } from '../../../shared/ui';
import { PayTime, PaySection } from '../components';
import { BackLink, Chip, Facts, Gate, Kpi, KpiGrid, ListShell, Money, MoneyLines, MoreFooter, PortalFailure } from './components';
import { portalCopy } from './copy';
import { useCursorList, useUrlParam, type ListState } from './hooks';
import { DAY_MS } from './model';
import type { PortalApi } from './api';
import type { Customer, CustomerDetail, customerSummarySchema } from './schemas';

type Summary = z.infer<typeof customerSummarySchema>;
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
          <KpiGrid label={t('customerKpis')}>
            <Kpi label={t('kpiCustomers')} value={s.customerCount} />
            <Kpi label={t('kpiActive30')} value={s.activeSinceCount} note={t('kpiActive30Note')} />
            <Kpi
              label={t('kpiRepeat')}
              value={s.customerCount === 0 ? '—' : `${Math.round((s.repeatCustomerCount * 100) / s.customerCount)}%`}
              note={t('kpiRepeatNote', { count: s.repeatCustomerCount })}
            />
          </KpiGrid>
        )}
      </Gate>
      <PaySection title={t('customersTitle')} description={t('customersBody')}>
        <form
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
                      <a className="text-link pp-mono" href={customerHref(c.customerRef)}>
                        {c.customerRef}
                      </a>
                      {(c.subscriptionCount > 0 || c.mandateCount > 0) && (
                        <small className="pay-cell-note">
                          {t('recurringNote', { subs: c.subscriptionCount, mandates: c.mandateCount })}
                        </small>
                      )}
                    </th>
                    <td className="numeric">{c.paymentCount}</td>
                    <td>
                      <MoneyLines items={c.totals.map((x) => ({ assetCode: x.assetId, amount: x.capturedAmount }))} />
                    </td>
                    <td>
                      <MoneyLines items={c.totals.map((x) => ({ assetCode: x.assetId, amount: x.refundedAmount }))} />
                    </td>
                    <td>
                      <PayTime value={c.firstSeenAt} />
                    </td>
                    <td>
                      <PayTime value={c.lastSeenAt} />
                    </td>
                  </tr>
                ))}
              </DataTable>
              {list.status === 'ready' && <MoreFooter state={list} onMore={loadMore} />}
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
  return <CustomerDetailView customer={customer.resource} reload={customer.reload} />;
}

export function CustomerDetailView({ customer, reload }: { customer: Resource<CustomerDetail>; reload: () => void }) {
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
                  note={t('recurringNote', { subs: c.subscriptionCount, mandates: c.mandateCount })}
                />
                <Kpi label={t('colFirstSeen')} value={<PayTime value={c.firstSeenAt} />} />
                <Kpi label={t('colLastSeen')} value={<PayTime value={c.lastSeenAt} />} />
              </KpiGrid>
              <Facts items={[[t('colReference'), <span className="pp-mono pp-copy">{c.customerRef}</span>]]} />
              <p className="muted pp-note">{t('customerSeriesSoon')}</p>
            </PaySection>
            <PaySection title={t('recentPayments')} description={t('recentPaymentsBody', { count: c.recentPayments.length })}>
              {c.recentPayments.length === 0 ? (
                <p className="muted">{t('noRecentPayments')}</p>
              ) : (
                <DataTable label={t('recentPayments')} headers={[t('colPayment'), t('colAmount'), t('colStatus'), t('colOpened')]}>
                  {c.recentPayments.map((p) => (
                    <tr key={p.paymentId}>
                      <th scope="row" className="pp-mono">
                        {p.paymentId.slice(0, 8)}…
                      </th>
                      <td>
                        <Money value={p.amount} asset={p.assetId} />
                      </td>
                      <td>
                        <Chip kind="payment" value={p.status} />
                      </td>
                      <td>
                        <PayTime value={p.createdAt} />
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
