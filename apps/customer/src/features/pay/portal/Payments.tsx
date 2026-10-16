import { useState } from 'react';
import { useResource, type Resource } from '../../../shared/resource';
import { Button, DataTable, EmptyState, Field, ChoiceGroup as Tabs } from '@intafaced/ui';
import { PayTime, PaySection } from '../components';
import {
  AsOf,
  BackLink,
  Chip,
  ComingSoon,
  Facts,
  Gate,
  HaltBanner,
  Kpi,
  KpiGrid,
  Money,
  MoneyLines,
  NotConfigured,
  PortalFailure,
  PortalLoading,
  ReadAt,
  SelectField,
  Timeline,
} from './components';
import { portalCopy } from './copy';
import { buildCsv, downloadText } from './csv';
import { useReadAt, useUrlParam } from './hooks';
import {
  assetsIn,
  countOf,
  filterPayments,
  isUuid,
  nextLimit,
  paymentLinks,
  paymentRefunds,
  paymentSteps,
  readLimit,
  readSort,
  refundable,
  shortId,
  sortKeys,
  sortRows,
  successRate,
  MAX_LIMIT,
  type PaymentFilters,
  type SortKey,
} from './model';
import { portalRefusal } from './refusal';
import type { PortalApi } from './api';
import {
  paymentStatuses,
  type DisputeDetail,
  type HaltStatus,
  type MetricPreset,
  type Payment,
  type PaymentEvent,
  type Snapshot,
} from './schemas';

export const paymentHref = (id: string) => `/pay/payments/${encodeURIComponent(id)}`;

/** `/pay/payments`: every payment on this account, with the totals for the period above it. */
export function Payments({ portal, merchantId }: { portal: PortalApi; merchantId: string }) {
  const [period, setPeriod] = useState<MetricPreset>('rolling_30d');
  const [status, setStatus] = useUrlParam('status', '');
  const [q, setQ] = useUrlParam('q', '');
  const [asset, setAsset] = useUrlParam('asset', '');
  const [from, setFrom] = useUrlParam('from', '');
  const [to, setTo] = useUrlParam('to', '');
  const [sortRaw, setSort] = useUrlParam('sort', 'newest');
  const [limitRaw, setLimitRaw] = useUrlParam('limit', '25');
  const limit = readLimit(limitRaw);
  const snapshot = useResource((s) => portal.snapshot(merchantId, period, s), `portal:payments-kpi:${merchantId}:${period}`);
  const halts = useResource((s) => portal.haltStatus(merchantId, s), `portal:halts:${merchantId}`);
  const list = useResource((s) => portal.payments(merchantId, status, limit, s), `portal:payments:${merchantId}:${status}:${limit}`);
  const loadedAt = useReadAt(list.resource.status === 'ready', list.resource);
  const set = { q: setQ, asset: setAsset, from: setFrom, to: setTo } as const;
  return (
    <PaymentsView
      snapshot={snapshot.resource}
      period={period}
      setPeriod={setPeriod}
      halts={halts.resource}
      list={list.resource}
      loadedAt={loadedAt}
      status={status}
      setStatus={setStatus}
      filters={{ q, asset, from, to }}
      setFilter={(key, value) => set[key](value)}
      sort={readSort(sortRaw)}
      setSort={setSort}
      limit={limit}
      setLimit={(n) => setLimitRaw(String(n))}
      retry={() => {
        snapshot.reload();
        list.reload();
        halts.reload();
      }}
    />
  );
}

export function PaymentsView({
  snapshot,
  period,
  setPeriod,
  halts,
  list,
  loadedAt,
  status,
  setStatus,
  filters,
  setFilter,
  sort,
  setSort,
  limit,
  setLimit,
  retry,
}: {
  snapshot: Resource<Snapshot>;
  period: MetricPreset;
  setPeriod: (value: MetricPreset) => void;
  halts: Resource<HaltStatus>;
  list: Resource<Payment[]>;
  loadedAt: string | null;
  status: string;
  setStatus: (value: string) => void;
  filters: PaymentFilters;
  setFilter: (key: keyof PaymentFilters, value: string) => void;
  sort: SortKey;
  setSort: (value: string) => void;
  limit: number;
  setLimit: (value: number) => void;
  retry: () => void;
}) {
  const { t } = portalCopy.useCopy();
  const labels: Record<MetricPreset, string> = { today: t('periodToday'), rolling_7d: t('period7d'), rolling_30d: t('period30d') };
  const narrowed = Boolean(filters.q || filters.asset || filters.from || filters.to);
  const clear = () => {
    setStatus('');
    for (const key of ['q', 'asset', 'from', 'to'] as const) setFilter(key, '');
  };
  return (
    <div className="stack">
      <HaltBanner resource={halts} scopes={['intake']} />
      <PaySection
        title={t('paymentsKpiTitle')}
        description={t('paymentsKpiBody')}
        action={
          <Tabs
            items={['today', 'rolling_7d', 'rolling_30d']}
            value={period}
            onChange={(v) => setPeriod(v as MetricPreset)}
            label={t('periodLabel')}
            labels={labels}
          />
        }
      >
        <Gate resource={snapshot} retry={retry} rows={2}>
          {(snap) => {
            const rate = successRate(snap.statusMix);
            return (
              <>
                <AsOf freshness={snap.freshness} />
                <KpiGrid label={t('kpiGroup', { period: labels[period] })}>
                  <Kpi label={t('kpiCount')} period={labels[period]} value={snap.paymentCount} href="/pay/payments" />
                  <Kpi
                    label={t('kpiVolume')}
                    period={labels[period]}
                    value={<MoneyLines items={snap.captured} />}
                    note={t('kpiVolumeNote')}
                  />
                  <Kpi label={t('kpiRefunded')} period={labels[period]} value={<MoneyLines items={snap.refunded} />} />
                  <Kpi
                    label={t('kpiSuccess')}
                    period={labels[period]}
                    value={rate.pct === null ? '—' : `${rate.pct}%`}
                    note={rate.pct === null ? t('kpiSuccessNone') : t('kpiSuccessNote', { failed: rate.failed, total: rate.total })}
                  />
                  <Kpi
                    label={t('kpiFailed')}
                    period={labels[period]}
                    value={countOf(snap.statusMix, 'failed')}
                    tone={countOf(snap.statusMix, 'failed') > 0 ? 'attention' : undefined}
                    href="/pay/payments?status=failed"
                  />
                  <Kpi
                    label={t('kpiDisputed')}
                    period={labels[period]}
                    value={countOf(snap.statusMix, 'disputed')}
                    href="/pay/payments?status=disputed"
                  />
                </KpiGrid>
              </>
            );
          }}
        </Gate>
      </PaySection>

      <PaySection title={t('paymentsTitle')} description={t('paymentsBody')}>
        <PaymentList
          list={list}
          loadedAt={loadedAt}
          status={status}
          setStatus={setStatus}
          filters={filters}
          setFilter={setFilter}
          sort={sort}
          setSort={setSort}
          limit={limit}
          setLimit={setLimit}
          narrowed={narrowed}
          clear={clear}
          retry={retry}
        />
      </PaySection>
    </div>
  );
}

function PaymentList({
  list,
  loadedAt,
  status,
  setStatus,
  filters,
  setFilter,
  sort,
  setSort,
  limit,
  setLimit,
  narrowed,
  clear,
  retry,
}: {
  list: Resource<Payment[]>;
  loadedAt: string | null;
  status: string;
  setStatus: (value: string) => void;
  filters: PaymentFilters;
  setFilter: (key: keyof PaymentFilters, value: string) => void;
  sort: SortKey;
  setSort: (value: string) => void;
  limit: number;
  setLimit: (value: number) => void;
  narrowed: boolean;
  clear: () => void;
  retry: () => void;
}) {
  const { t } = portalCopy.useCopy();
  const loaded = list.status === 'ready' ? list.data : [];
  const rows = sortRows(
    filterPayments(loaded, filters),
    sort,
    (r) => r.createdAt,
    (r) => r.amount,
  );
  const exportCsv = () =>
    downloadText(
      'payments.csv',
      buildCsv(
        ['payment_id', 'created_at', 'status', 'amount', 'captured', 'refunded', 'asset', 'method', 'rail', 'rail_reference'],
        rows.map((r) => [
          r.id,
          r.createdAt,
          r.status,
          r.amount,
          r.capturedAmount,
          r.refundedAmount,
          r.assetId,
          r.method,
          r.railAdapter,
          r.railRef ?? '',
        ]),
        { generatedAt: new Date().toISOString(), asOf: loadedAt ?? '' },
      ),
    );
  return (
    <>
      <div className="pp-filter-row" role="search" aria-label={t('paymentsFilters')}>
        <SelectField
          label={t('filterStatus')}
          value={status}
          onChange={setStatus}
          options={[['', t('filterAll')], ...paymentStatuses.map((s) => [s, t(`chipPayment_${s}` as 'chipPayment_created')] as const)]}
        />
        <SelectField
          label={t('filterAsset')}
          value={filters.asset}
          onChange={(v) => setFilter('asset', v)}
          options={[['', t('filterAll')], ...assetsIn(loaded).map((a) => [a, a] as const)]}
        />
        <Field label={t('filterFrom')} type="date" value={filters.from} onChange={(e) => setFilter('from', e.target.value)} />
        <Field label={t('filterTo')} type="date" value={filters.to} onChange={(e) => setFilter('to', e.target.value)} />
        <Field
          label={t('searchPayments')}
          type="search"
          value={filters.q}
          onChange={(e) => setFilter('q', e.target.value)}
          maxLength={200}
          hint={t('searchPaymentsHint')}
        />
        <SelectField
          label={t('sortBy')}
          value={sort}
          onChange={setSort}
          options={sortKeys.map((k) => [k, t(`sort_${k}` as 'sort_newest')] as const)}
        />
        <Button variant="secondary" onClick={exportCsv} disabled={rows.length === 0}>
          {t('downloadCsv')}
        </Button>
      </div>
      <ReadAt at={loadedAt} />
      {list.status === 'loading' ? (
        <PortalLoading />
      ) : list.status === 'failed' ? (
        <PortalFailure result={list.failure} retry={retry} />
      ) : loaded.length === 0 ? (
        <EmptyState
          title={status ? t('paymentsNoStatusTitle') : t('paymentsEmptyTitle')}
          action={
            status ? (
              <Button variant="secondary" onClick={clear}>
                {t('clearFilters')}
              </Button>
            ) : (
              <Button variant="primary" nativeButton={false} role="link" render={<a href="/pay/links" />}>
                {t('actCreateLink')}
              </Button>
            )
          }
        >
          {status ? t('paymentsNoStatusBody') : t('paymentsEmptyBody')}
        </EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState
          title={t('paymentsNoMatchTitle')}
          action={
            <Button variant="secondary" onClick={clear}>
              {t('clearFilters')}
            </Button>
          }
        >
          {t('paymentsNoMatchBody', { count: loaded.length })}
        </EmptyState>
      ) : (
        <>
          <DataTable
            label={t('paymentsTitle')}
            headers={[t('colPayment'), t('colCreated'), t('colAmount'), t('colCaptured'), t('colRefunded'), t('colStatus'), t('colRail')]}
          >
            {rows.map((p) => (
              <tr key={p.id}>
                <th scope="row">
                  <a className="text-link pp-mono" href={paymentHref(p.id)} aria-label={t('openPaymentAria', { id: p.id })}>
                    {shortId(p.id)}
                  </a>
                </th>
                <td>
                  <PayTime value={p.createdAt} />
                </td>
                <td>
                  <Money value={p.amount} asset={p.assetId} />
                </td>
                <td>
                  <Money value={p.capturedAmount} asset={p.assetId} />
                </td>
                <td>
                  <Money value={p.refundedAmount} asset={p.assetId} />
                </td>
                <td>
                  <Chip kind="payment" value={p.status} />
                </td>
                <td>
                  {p.railAdapter}
                  <small className="pay-cell-note">{p.method}</small>
                </td>
              </tr>
            ))}
          </DataTable>
          <div className="pp-more">
            <p className="muted" role="status">
              {narrowed
                ? t('paymentsNarrowed', { shown: rows.length, loaded: loaded.length })
                : loaded.length >= limit && limit < MAX_LIMIT
                  ? t('rowsSoFar', { count: loaded.length })
                  : t('rowsAll', { count: loaded.length })}
            </p>
            {loaded.length >= limit && limit < MAX_LIMIT && (
              <Button variant="secondary" onClick={() => setLimit(nextLimit(limit))}>
                {t('loadMore')}
              </Button>
            )}
            {loaded.length >= MAX_LIMIT && (
              <a className="text-link" href="/pay/exports">
                {t('olderInExports', { max: MAX_LIMIT })}
              </a>
            )}
          </div>
        </>
      )}
    </>
  );
}

// ---- detail ---------------------------------------------------------------------------------------------

export function PaymentDetailPage({ portal, paymentId }: { portal: PortalApi; paymentId: string }) {
  const valid = isUuid(paymentId);
  const payment = useResource(
    (s) => (valid ? portal.payment(paymentId, s) : Promise.resolve(portalRefusal('rPaymentNotFound'))),
    `portal:payment:${paymentId}`,
  );
  const history = useResource(
    (s) => (valid ? portal.paymentHistory(paymentId, s) : Promise.resolve(portalRefusal('rPaymentNotFound'))),
    `portal:payment-history:${paymentId}`,
  );
  const disputeId = history.resource.status === 'ready' ? paymentLinks(history.resource.data).disputeId : null;
  const dispute = useResource<DisputeDetail | null>(
    (s) => (disputeId ? portal.dispute(disputeId, s) : Promise.resolve({ ok: true as const, data: null })),
    `portal:payment-dispute:${paymentId}:${disputeId ?? 'none'}`,
  );
  return (
    <PaymentDetailView
      payment={payment.resource}
      history={history.resource}
      dispute={disputeId ? dispute.resource : null}
      retry={() => {
        payment.reload();
        history.reload();
        dispute.reload();
      }}
    />
  );
}

export function PaymentDetailView({
  payment,
  history,
  dispute,
  retry,
}: {
  payment: Resource<Payment>;
  history: Resource<PaymentEvent[]>;
  /** `null` means this payment has no dispute. */
  dispute: Resource<DisputeDetail | null> | null;
  retry: () => void;
}) {
  const { t } = portalCopy.useCopy();
  return (
    <div className="stack">
      <BackLink href="/pay/payments">{t('backToPayments')}</BackLink>
      <Gate resource={payment} retry={retry} rows={5}>
        {(p) => {
          const events = history.status === 'ready' ? history.data : [];
          const links = paymentLinks(events);
          const refunds = paymentRefunds(events);
          return (
            <>
              <PaySection title={t('keyFacts')} description={t('paymentFactsBody')}>
                <Facts
                  items={[
                    [t('colPayment'), <span className="pp-mono pp-copy">{p.id}</span>],
                    [t('colStatus'), <Chip kind="payment" value={p.status} />],
                    [t('colCreated'), <PayTime value={p.createdAt} />],
                    [t('colRail'), `${p.railAdapter} · ${p.method}`],
                    [t('railReference'), p.railRef ? <span className="pp-mono pp-copy">{p.railRef}</span> : t('notConfirmedYet')],
                    [
                      t('payerReference'),
                      links.customerRef ? (
                        <a className="text-link pp-mono" href={`/pay/customers/${encodeURIComponent(links.customerRef)}`}>
                          {links.customerRef}
                        </a>
                      ) : (
                        t('notGiven')
                      ),
                    ],
                  ]}
                />
              </PaySection>

              <PaySection title={t('amountsTitle')} description={t('amountsBody')}>
                <Facts
                  items={[
                    [t('amountRequested'), <Money value={p.amount} asset={p.assetId} />],
                    [t('colCaptured'), <Money value={p.capturedAmount} asset={p.assetId} />],
                    [t('colRefunded'), <Money value={p.refundedAmount} asset={p.assetId} />],
                    [t('stillRefundable'), <Money value={refundable(p)} asset={p.assetId} />],
                  ]}
                />
                <ComingSoon title={t('feeSoonTitle')}>
                  {t('feeSoonBody')}{' '}
                  <a className="text-link" href="/pay/pricing">
                    {t('seePricing')}
                  </a>
                </ComingSoon>
              </PaySection>

              <PaySection title={t('timelineTitle')} description={t('paymentTimelineBody')}>
                {history.status === 'loading' ? (
                  <PortalLoading rows={3} />
                ) : history.status === 'failed' ? (
                  <PortalFailure result={history.failure} retry={retry} />
                ) : (
                  <PaymentTimeline events={history.data} currency={p.assetId} />
                )}
              </PaySection>

              <div className="pp-two">
                <PaySection title={t('refundsTitle')} description={t('refundsBody')}>
                  {history.status !== 'ready' ? (
                    <p className="muted">{t('refundsAfterHistory')}</p>
                  ) : refunds.length === 0 ? (
                    <EmptyState title={t('refundsEmptyTitle')}>{t('refundsEmptyBody')}</EmptyState>
                  ) : (
                    <DataTable label={t('refundsTitle')} headers={[t('colRefund'), t('colAmount'), t('colStatus'), t('colWhen')]}>
                      {refunds.map((r) => (
                        <tr key={r.refundId}>
                          <th scope="row" className="pp-mono">
                            {shortId(r.refundId)}
                          </th>
                          <td>{r.amount ? <Money value={r.amount} asset={p.assetId} /> : '—'}</td>
                          <td>{t(`refundState_${r.state}` as 'refundState_completed')}</td>
                          <td>
                            <PayTime value={r.at} />
                          </td>
                        </tr>
                      ))}
                    </DataTable>
                  )}
                  <a className="text-link" href={`/pay/payments?view=tools&payment=${encodeURIComponent(p.id)}`}>
                    {t('refundOrCapture')}
                  </a>
                </PaySection>
                <PaySection title={t('disputeCardTitle')} description={t('disputeCardBody')}>
                  <DisputeCard dispute={dispute} status={p.status} retry={retry} />
                </PaySection>
              </div>

              <PaySection title={t('relatedTitle')} description={t('relatedBody')}>
                <ul className="pp-links">
                  {links.settlementId && (
                    <li>
                      <a className="text-link" href={`/pay/settlements/${encodeURIComponent(links.settlementId)}`}>
                        {t('linkSettlement')}
                      </a>
                    </li>
                  )}
                  {links.customerRef && (
                    <li>
                      <a className="text-link" href={`/pay/customers/${encodeURIComponent(links.customerRef)}`}>
                        {t('linkCustomer')}
                      </a>
                    </li>
                  )}
                  {links.disputeId && (
                    <li>
                      <a className="text-link" href={`/pay/disputes/${encodeURIComponent(links.disputeId)}`}>
                        {t('linkDispute')}
                      </a>
                    </li>
                  )}
                  <li>
                    <a className="text-link" href="/pay/pricing">
                      {t('linkPricing')}
                    </a>
                  </li>
                </ul>
              </PaySection>

              <PaySection title={t('idsTitle')} description={t('idsBody')}>
                <Facts
                  items={[
                    [t('idPayment'), <span className="pp-mono pp-copy">{p.id}</span>],
                    ...(p.railRef ? ([[t('railReference'), <span className="pp-mono pp-copy">{p.railRef}</span>]] as const) : []),
                    ...(links.ledgerTxId ? ([[t('idLedger'), <span className="pp-mono pp-copy">{links.ledgerTxId}</span>]] as const) : []),
                    ...(links.settlementId
                      ? ([[t('colSettlement'), <span className="pp-mono pp-copy">{links.settlementId}</span>]] as const)
                      : []),
                    ...refunds.map(
                      (r) =>
                        [
                          `${t('idRefund')} ${shortId(r.refundId)}`,
                          <span key={r.refundId} className="pp-mono pp-copy">
                            {r.refundId}
                          </span>,
                        ] as const,
                    ),
                  ]}
                />
              </PaySection>

              <ComingSoon title={t('ledgerSoonTitle')}>{t('ledgerSoonBody')}</ComingSoon>
            </>
          );
        }}
      </Gate>
    </div>
  );
}

function PaymentTimeline({ events, currency }: { events: PaymentEvent[]; currency: string }) {
  const { t } = portalCopy.useCopy();
  const steps = paymentSteps(events);
  if (steps.length === 0) return <p className="muted">{t('timelineEmpty')}</p>;
  return (
    <Timeline
      label={t('timelineTitle')}
      items={steps.map((s) => ({
        at: s.at,
        title: t(`step_${s.kind}` as 'step_created'),
        ...(s.amount ? { detail: `${s.amount} ${currency}` } : {}),
      }))}
    />
  );
}

function DisputeCard({ dispute, status, retry }: { dispute: Resource<DisputeDetail | null> | null; status: string; retry: () => void }) {
  const { t } = portalCopy.useCopy();
  if (dispute === null) return <p className="muted">{status === 'disputed' ? t('disputeCardMissing') : t('disputeCardNone')}</p>;
  if (dispute.status === 'loading') return <PortalLoading rows={2} />;
  if (dispute.status === 'failed') return <PortalFailure result={dispute.failure} retry={retry} />;
  const d = dispute.data;
  if (!d) return <p className="muted">{t('disputeCardNone')}</p>;
  return (
    <>
      <Facts
        items={[
          [t('colStatus'), <Chip kind="dispute" value={d.status} />],
          [t('colAmount'), <Money value={d.amount} asset={d.assetId} />],
          [t('colReason'), d.reasonCode ?? t('notGiven')],
          [t('colDue'), d.responseDueAt ? <PayTime value={d.responseDueAt} /> : <NotConfigured>{t('noDeadline')}</NotConfigured>],
        ]}
      />
      <a className="text-link" href={`/pay/disputes/${encodeURIComponent(d.disputeId)}`}>
        {t('openDisputeLink')}
      </a>
    </>
  );
}
