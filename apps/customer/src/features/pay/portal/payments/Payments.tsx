import type { ReactNode } from 'react';
import { Button } from '@intafaced/ui';
import type { PaymentViewColumn } from '@intafaced/contracts/pay-payment-views';
import { EmptyState } from '../../ui-kit';
import { useResource, type Resource } from '../../../../shared/resource';
import { PaySection } from '../../components';
import { Facts, Gate, HaltBanner, Money, MoneyLines, NotConfigured, PortalFailure, PortalLoading } from '../components';
import type { ListState } from '../hooks';
import { isUuid, nameHold, paymentLinks, paymentRefunds, shortId } from '../model';
import { paymentLabel } from '../presentation';
import { portalRefusal } from '../refusal';
import type { PortalApi } from '../api';
import type { DisputeDetail, HaltStatus, Payment, PaymentEvent, Snapshot } from '../schemas';
import { paymentStatuses } from '../schemas';
import { CopyReference } from '../ui/CopyReference';
import { DateTime } from '../ui/DateTime';
import { DetailHeader } from '../ui/DetailHeader';
import { EntityList } from '../ui/EntityList';
import { dateRange, FilterRow, useListFilters, type DatePreset, type ListFilters } from '../ui/FilterRow';
import { Freshness } from '../ui/Freshness';
import { KpiStrip } from '../ui/Kpi';
import { plainCode } from '../ui/plain-code';
import { actionWords } from '../settings/activity/model';
import { RelatedLinks } from '../ui/RelatedLinks';
import { StatusChip } from '../ui/StatusChip';
import { Timeline } from '../ui/Timeline';
import { useServerList } from '../ui/useServerList';
import { assetsOf } from '../model';
import { formatAmount, parseAmount } from '../../../../shared/money';
import { ExportResults } from './ExportResults';
import { PayerEmailCell, PaymentViewsBar, usePaymentColumns } from './PaymentViews';
import { MoneyAction } from '../access/MoneyAction';
import { RefundsIssuedValue } from './RefundsIssued';
import { railName } from './HomePanels';
import { portalCopy as c } from './copy';
import { disputeReason } from './dispute-model';
import { canRefund, feeSummary, PRESET, totalsPeriod } from './payment-model';
import { countOf, paymentSteps, refundable, successRate } from './model';
import type { ActivityItem, PaymentRefundRow } from './schemas';

/**
 * Why a payment shows no fee. The fee comes off when the payment settles and is then shown on the settlement, so a
 * payment that is captured but not settled says only when it is taken, and never points at a settlement that does not
 * exist. A payment that never completed has no fee at all.
 */
export function feeNoneText(
  t: (key: 'pay_feeAtSettlement' | 'pay_feeFailed' | 'pay_feeOnSettlement' | 'pay_feeWhenSettles') => string,
  status: string,
): string {
  if (status === 'failed') return t('pay_feeFailed');
  if (status === 'captured') return t('pay_feeWhenSettles');
  return status === 'created' || status === 'authorized' ? t('pay_feeAtSettlement') : t('pay_feeOnSettlement');
}

export const paymentHref = (id: string) => `/pay/payments/${encodeURIComponent(id)}`;

/** `/pay/payments`: the server filters and pages the list; the totals above it say which period they cover. */
export function Payments({ portal, merchantId }: { portal: PortalApi; merchantId: string }) {
  const filters = useListFilters();
  const range = dateRange(filters.date as DatePreset, Date.now(), { from: filters.from, to: filters.to });
  const query = {
    status: filters.status,
    search: filters.search.trim(),
    assetId: filters.asset,
    from: range.from ?? '',
    to: range.to ?? '',
  };
  const list = useServerList(
    (f, cursor, signal) => portal.paymentPage(merchantId, f, cursor, signal),
    query,
    (p: Payment) => p.id,
  );
  const { period } = totalsPeriod(filters.date);
  const snapshot = useResource((s) => portal.snapshot(merchantId, PRESET[period], s), `portal:payments-kpi:${merchantId}:${period}`);
  const halts = useResource((s) => portal.haltStatus(merchantId, s), `portal:halts:${merchantId}`);
  return (
    <PaymentsView
      portal={portal}
      merchantId={merchantId}
      filters={filters}
      range={range}
      list={list.state}
      snapshot={snapshot.resource}
      halts={halts.resource}
      loadMore={list.loadMore}
      retry={() => {
        list.reload();
        snapshot.reload();
        halts.reload();
      }}
    />
  );
}

export function PaymentsView({
  portal,
  merchantId,
  filters,
  range,
  list,
  snapshot,
  halts,
  loadMore,
  retry,
}: {
  portal: PortalApi;
  merchantId?: string;
  filters: ListFilters;
  range: { from?: string; to?: string };
  list: ListState<Payment>;
  snapshot: Resource<Snapshot>;
  halts: Resource<HaltStatus>;
  loadMore: () => void;
  retry: () => void;
}) {
  const { t } = c.useCopy();
  const { period, matchesList } = totalsPeriod(filters.date);
  const filtered = Boolean(filters.status || filters.search || filters.date || filters.asset);
  const assets = snapshot.status === 'ready' ? assetsOf(snapshot.data) : [];
  const [columns, setColumns] = usePaymentColumns();
  const columnDefs: Record<PaymentViewColumn, { header: string; cell: (p: Payment) => ReactNode }> = {
    payment: {
      header: t('colPayment'),
      cell: (p) => (
        <>
          <strong>{paymentLabel(p)}</strong>
          {p.customerRef && p.description && <small className="pay-cell-note">{p.description}</small>}
        </>
      ),
    },
    amount: { header: t('colAmount'), cell: (p) => <Money value={p.amount} asset={p.assetId} /> },
    status: { header: t('colStatus'), cell: (p) => <StatusChip entity="payment" value={p.status} /> },
    method: { header: t('pay_colMethod'), cell: (p) => plainCode(p.method.replace(/^TEST-/, '').replace(/-/g, '_')) },
    created: { header: t('colCreated'), cell: (p) => <DateTime value={p.createdAt} /> },
    customerEmail: { header: t('pay_colEmail'), cell: (p) => <PayerEmailCell portal={portal} payment={p} /> },
    railRef: { header: t('railReference'), cell: (p) => p.railRef ?? <span className="muted">{t('notGiven')}</span> },
  };
  return (
    <div className="stack">
      {snapshot.status === 'ready' ? (
        <Freshness asOf={snapshot.data.freshness.asOf} lagSeconds={snapshot.data.freshness.lagSeconds ?? 0} />
      ) : null}
      <HaltBanner resource={halts} scopes={['intake']} />
      <Totals
        snapshot={snapshot}
        period={period}
        matchesList={matchesList}
        retry={retry}
        portal={portal}
        {...(merchantId ? { merchantId } : {})}
      />
      {merchantId && <PaymentViewsBar portal={portal} filters={filters} columns={columns} setColumns={setColumns} />}
      <FilterRow
        label={t('pay_listTitle')}
        filters={filters}
        statuses={paymentStatuses.map((s) => [s, t(`chipPayment_${s}` as 'chipPayment_created')] as const)}
        assets={assets}
        searchHint={t('pay_searchHint')}
        {...(list.status === 'ready' ? { shown: list.items.length, hasMore: list.hasMore } : {})}
      />
      {list.status === 'loading' && <PortalLoading />}
      {list.status === 'failed' && <PortalFailure result={list.failure} retry={retry} />}
      {list.status === 'ready' &&
        (list.items.length === 0 ? (
          <EmptyState
            title={t(filtered ? 'pay_emptyFilteredTitle' : 'pay_emptyTitle')}
            action={
              filtered ? undefined : (
                <Button variant="primary" nativeButton={false} role="link" render={<a href="/pay/links/new" />}>
                  {t('createLink')}
                </Button>
              )
            }
          >
            {t(filtered ? 'pay_emptyFilteredBody' : 'pay_emptyBody')}
          </EmptyState>
        ) : (
          <>
            <EntityList
              label={t('pay_listTitle')}
              rows={list.items}
              rowKey={(p) => p.id}
              href={(p) => paymentHref(p.id)}
              columns={columns.map((col) => columnDefs[col])}
              card={(p) => ({
                title: paymentLabel(p),
                time: <DateTime value={p.createdAt} />,
                amount: <Money value={p.amount} asset={p.assetId} />,
                status: <StatusChip entity="payment" value={p.status} />,
              })}
            />
            <div className="pp-actions">
              {list.hasMore && (
                <Button variant="secondary" onClick={loadMore} disabled={list.more === 'loading'}>
                  {list.more === 'loading' ? t('pay_loadingMore') : t('pay_loadMore')}
                </Button>
              )}
              <ExportResults
                portal={portal}
                kind="payments"
                filters={{
                  ...(range.from ? { from: range.from } : {}),
                  ...(range.to ? { to: range.to } : {}),
                  ...(filters.status ? { status: filters.status } : {}),
                  ...(filters.asset ? { assetId: filters.asset } : {}),
                }}
                searchLeftOut={Boolean(filters.search.trim())}
                summary={[
                  [t('colStatus'), filters.status ? t(`chipPayment_${filters.status}` as 'chipPayment_created') : t('pay_any')],
                  [
                    t('pay_date'),
                    range.from || range.to ? `${range.from?.slice(0, 10) ?? '…'} → ${range.to?.slice(0, 10) ?? '…'}` : t('pay_any'),
                  ],
                  [t('pay_asset'), filters.asset || t('pay_any')],
                ]}
              />
            </div>
          </>
        ))}
    </div>
  );
}

function Totals({
  snapshot,
  period,
  matchesList,
  retry,
  portal,
  merchantId,
}: {
  snapshot: Resource<Snapshot>;
  period: 'today' | '7d' | '30d';
  matchesList: boolean;
  retry: () => void;
  portal: PortalApi;
  merchantId?: string;
}) {
  const { t } = c.useCopy();
  if (snapshot.status === 'loading') return <PortalLoading rows={2} />;
  if (snapshot.status === 'failed') return <PortalFailure result={snapshot.failure} retry={retry} />;
  const snap = snapshot.data;
  const label = t(`pay_period_${period}`);
  const rate = successRate(snap.statusMix);
  const { from, to } = dateRange(period, Date.now());
  const refundsHref = `/pay/refunds?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) }).toString()}`;
  const list = (extra: Record<string, string>) => `/pay/payments?${new URLSearchParams({ ...extra, date: period }).toString()}`;
  return (
    <div className="stack">
      <KpiStrip
        label={t('pay_totalsLabel', { period: label })}
        tiles={[
          { label: t('kpiCount'), period: label, href: list({}), value: snap.paymentCount },
          {
            label: t('kpiVolume'),
            period: label,
            // Paid in counts every payment that was captured, including those since settled or refunded, so it opens the whole period.
            href: list({}),
            value: <MoneyLines items={snap.captured} />,
            note: t('kpiVolumeNote'),
          },
          {
            label: t('kpiRefunded'),
            period: label,
            href: refundsHref,
            value: <MoneyLines items={snap.refunded} />,
            note: t('kpiRefundedNote'),
          },
          ...(merchantId
            ? [
                {
                  label: t('refundsIssuedLabel'),
                  period: label,
                  href: refundsHref,
                  value: <RefundsIssuedValue portal={portal} merchantId={merchantId} when={period} />,
                  note: t('refundsIssuedNote'),
                },
              ]
            : []),
          {
            label: t('kpiSuccess'),
            period: label,
            href: list({}),
            value: rate.pct === null ? '—' : `${rate.pct}%`,
            note: rate.pct === null ? t('kpiSuccessNone') : t('kpiSuccessNote', { failed: rate.failed, total: rate.total }),
          },
          {
            label: t('kpiFailed'),
            period: label,
            href: list({ status: 'failed' }),
            value: countOf(snap.statusMix, 'failed'),
            tone: countOf(snap.statusMix, 'failed') > 0 ? 'attention' : undefined,
          },
          { label: t('kpiDisputed'), period: label, href: list({ status: 'disputed' }), value: countOf(snap.statusMix, 'disputed') },
        ]}
      />
      {!matchesList && <p className="muted pp-note">{t('pay_totalsWider', { period: label })}</p>}
    </div>
  );
}

// ---- detail ---------------------------------------------------------------------------------------------

export function PaymentDetailPage({ portal, paymentId, merchantId }: { portal: PortalApi; paymentId: string; merchantId: string }) {
  const valid = isUuid(paymentId);
  const payment = useResource(
    (s) => (valid ? portal.payment(paymentId, s) : Promise.resolve(portalRefusal('rPaymentNotFound'))),
    `portal:payment:${paymentId}`,
  );
  const history = useResource(
    (s) => (valid ? portal.paymentHistory(paymentId, s) : Promise.resolve(portalRefusal('rPaymentNotFound'))),
    `portal:payment-history:${paymentId}`,
  );
  const refunds = useResource(
    (s) => (valid ? portal.paymentRefundRows(paymentId, merchantId, s) : Promise.resolve(portalRefusal('rPaymentNotFound'))),
    `portal:payment-refunds:${paymentId}`,
  );
  const activity = useResource(
    (s) => (valid ? portal.paymentActivity(paymentId, s) : Promise.resolve(portalRefusal('rPaymentNotFound'))),
    `portal:payment-activity:${paymentId}`,
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
      refunds={refunds.resource.status === 'ready' ? refunds.resource.data.items : refunds.resource}
      activity={
        activity.resource.status === 'ready' ? activity.resource.data.items.filter((a) => a.objectId === paymentId) : activity.resource
      }
      dispute={disputeId ? dispute.resource : null}
      retry={() => {
        payment.reload();
        history.reload();
        refunds.reload();
        activity.reload();
        dispute.reload();
      }}
    />
  );
}

type Loaded<T> = T | Resource<never>;
const isResource = <T,>(value: Loaded<T[]>): value is Resource<never> => !Array.isArray(value);

export function PaymentDetailView({
  payment,
  history,
  refunds,
  activity,
  dispute,
  retry,
}: {
  payment: Resource<Payment>;
  history: Resource<PaymentEvent[]>;
  /** The refunds list for this payment, or why it could not be read (then the refunds come from the payment's own history). */
  refunds: Loaded<PaymentRefundRow[]>;
  activity: Loaded<ActivityItem[]>;
  /** `null` means this payment has no dispute. */
  dispute: Resource<DisputeDetail | null> | null;
  retry: () => void;
}) {
  const { t } = c.useCopy();
  return (
    <div className="stack">
      <Gate resource={payment} retry={retry} rows={5}>
        {(p) => {
          const events = history.status === 'ready' ? history.data : [];
          const links = paymentLinks(events);
          const held = nameHold(p.status, events);
          const waiting = p.status === 'created' ? (p.confirmations ?? null) : null;
          const customerRef = p.customerRef?.trim() || links.customerRef;
          const fee = feeSummary(p);
          const derived = paymentRefunds(events);
          const related = [
            ...(links.settlementId
              ? [{ href: `/pay/settlements/${encodeURIComponent(links.settlementId)}`, label: t('linkSettlement') }]
              : []),
            ...(links.disputeId ? [{ href: `/pay/disputes/${encodeURIComponent(links.disputeId)}`, label: t('linkDispute') }] : []),
            ...(customerRef ? [{ href: `/pay/customers/${encodeURIComponent(customerRef)}`, label: t('linkCustomer') }] : []),
          ];
          return (
            <>
              <DetailHeader
                back={{ href: '/pay/payments', label: t('backToPayments') }}
                title={<Money value={p.amount} asset={p.assetId} />}
                status={<StatusChip entity="payment" value={p.status} />}
                subtitle={[paymentLabel(p), plainCode(p.method.replace(/^TEST-/, '').replace(/-/g, '_'))].join(' · ')}
                action={
                  canRefund(p) ? (
                    <MoneyAction kind="refund">
                      <Button
                        variant="primary"
                        nativeButton={false}
                        role="link"
                        render={<a href={`/pay/refunds/new?payment=${encodeURIComponent(p.id)}`} />}
                      >
                        {t('pay_refund')}
                      </Button>
                    </MoneyAction>
                  ) : undefined
                }
              />
              <PaySection title={t('pay_summary')}>
                <Facts
                  items={[
                    [t('pay_amount'), <Money value={p.amount} asset={p.assetId} />],
                    [t('colCaptured'), <Money value={p.capturedAmount} asset={p.assetId} />],
                    [t('colRefunded'), <Money value={p.refundedAmount} asset={p.assetId} />],
                    [t('stillRefundable'), <Money value={refundable(p)} asset={p.assetId} />],
                    ...(fee.kind === 'none'
                      ? ([[t('pay_fee'), <NotConfigured>{feeNoneText(t, p.status)}</NotConfigured>]] as const)
                      : ([
                          [t('pay_fee'), <Money value={fee.fee} asset={fee.assetId} />],
                          ...(fee.net ? ([[t('pay_net'), <Money value={fee.net} asset={fee.assetId} />]] as const) : []),
                          ...(fee.net && fee.assetId === p.assetId && parseAmount(p.refundedAmount) > 0n
                            ? ([
                                [
                                  t('pay_netAfterRefunds'),
                                  <>
                                    <Money value={formatAmount(parseAmount(fee.net) - parseAmount(p.refundedAmount))} asset={fee.assetId} />
                                    {parseAmount(fee.net) - parseAmount(p.refundedAmount) < 0n && (
                                      <small className="pay-cell-note">{t('pay_netNegativeWhy')}</small>
                                    )}
                                  </>,
                                ],
                              ] as const)
                            : []),
                          ...(fee.kind === 'rule'
                            ? ([
                                [
                                  t('pay_feeRule'),
                                  t(`pay_layer_${fee.layer}`, { percent: fee.percent }) +
                                    (fee.flatFee ? t('pay_flatFee', { flat: fee.flatFee, asset: fee.assetId }) : ''),
                                ],
                              ] as const)
                            : []),
                        ] as const)),
                  ]}
                />
                {p.failure && (
                  <p className="pp-callout" role="note">
                    {t('pay_whyFailed')} {p.failure.message}
                  </p>
                )}
                {waiting && (
                  <p className="pp-callout" role="note" data-testid="payment-confirmations">
                    {t('pay_waitingConfirmations', { seen: waiting.seen, required: waiting.required })} <DateTime value={waiting.asOf} />
                  </p>
                )}
                {held && (
                  <p className="pp-callout" role="note" data-testid="payment-name-hold">
                    {t('pay_heldTitle')} {t(`pay_held_${held}`)}
                  </p>
                )}
              </PaySection>
              <PaySection title={t('keyFacts')}>
                <Facts
                  items={[
                    [t('colCreated'), <DateTime value={p.createdAt} />],
                    [
                      t('payerReference'),
                      customerRef ? (
                        <a className="text-link" href={`/pay/customers/${encodeURIComponent(customerRef)}`}>
                          {customerRef}
                        </a>
                      ) : (
                        t('notGiven')
                      ),
                    ],
                    [t('colRail'), railName(p.railAdapter)],
                    ...(p.description ? ([[t('pay_description'), p.description]] as const) : []),
                  ]}
                />
              </PaySection>
              <PaySection title={t('timelineTitle')}>
                {history.status === 'loading' ? (
                  <PortalLoading rows={3} />
                ) : history.status === 'failed' ? (
                  <PortalFailure result={history.failure} retry={retry} />
                ) : (
                  <PaymentTimeline events={history.data} currency={p.assetId} />
                )}
              </PaySection>
              <div className="pp-two">
                <PaySection title={t('refundsTitle')}>
                  <RefundsList refunds={refunds} derived={derived} assetId={p.assetId} />
                </PaySection>
                <PaySection title={t('disputeCardTitle')}>
                  <DisputeCard dispute={dispute} status={p.status} retry={retry} />
                </PaySection>
              </div>
              <PaySection title={t('pay_activity')}>
                <ActivityList activity={activity} />
              </PaySection>
              <RelatedLinks links={related} />
              <PaySection title={t('idsTitle')}>
                <Facts
                  items={[
                    [t('idPayment'), <CopyReference value={p.id} what={t('idPayment')} />],
                    ...(p.railRef ? ([[t('railReference'), <CopyReference value={p.railRef} what={t('railReference')} />]] as const) : []),
                    ...(links.ledgerTxId
                      ? ([[t('idLedger'), <CopyReference value={links.ledgerTxId} what={t('idLedger')} />]] as const)
                      : []),
                  ]}
                />
              </PaySection>
            </>
          );
        }}
      </Gate>
    </div>
  );
}

function RefundsList({
  refunds,
  derived,
  assetId,
}: {
  refunds: Loaded<PaymentRefundRow[]>;
  derived: ReturnType<typeof paymentRefunds>;
  assetId: string;
}) {
  const { t } = c.useCopy();
  // The refunds list is the source. If it is not switched on for this account, the payment's own history is the fallback.
  const rows = isResource(refunds)
    ? derived.map((r) => ({
        key: r.refundId,
        href: null as string | null,
        amount: r.amount,
        status: t(`refundState_${r.state}` as 'refundState_completed'),
        at: r.at,
      }))
    : refunds.map((r) => ({
        key: r.id,
        href: `/pay/refunds/${encodeURIComponent(r.id)}`,
        amount: r.amount,
        status: t(`pay_refund_${r.status}`),
        at: r.createdAt,
      }));
  if (rows.length === 0) return <p className="muted">{t('refundsEmptyBody')}</p>;
  return (
    <ul className="pp-links">
      {rows.map((r) => (
        <li key={r.key}>
          {r.amount ? <Money value={r.amount} asset={assetId} /> : '—'} · {r.status} · <DateTime value={r.at} />
          {r.href && (
            <>
              {' '}
              <a className="text-link" href={r.href}>
                {shortId(r.key)}
              </a>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

function ActivityList({ activity }: { activity: Loaded<ActivityItem[]> }) {
  const { t } = c.useCopy();
  if (isResource(activity)) {
    if (activity.status === 'loading') return <PortalLoading rows={2} />;
    if (activity.status === 'failed') return <PortalFailure result={activity.failure} />;
    return null;
  }
  if (activity.length === 0) return <p className="muted">{t('pay_activityEmpty')}</p>;
  return (
    <Timeline
      label={t('pay_activity')}
      items={activity.map((a) => ({
        at: a.occurredAt,
        title: actionWords(a.objectType, a.action),
        ...(a.detail.amount ? { detail: `${a.detail.amount}${a.detail.asset ? ` ${a.detail.asset}` : ''}` } : {}),
      }))}
    />
  );
}

function PaymentTimeline({ events, currency }: { events: PaymentEvent[]; currency: string }) {
  const { t } = c.useCopy();
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
  const { t } = c.useCopy();
  if (dispute === null) return <p className="muted">{status === 'disputed' ? t('disputeCardMissing') : t('disputeCardNone')}</p>;
  if (dispute.status === 'loading') return <PortalLoading rows={2} />;
  if (dispute.status === 'failed') return <PortalFailure result={dispute.failure} retry={retry} />;
  const d = dispute.data;
  if (!d) return <p className="muted">{t('disputeCardNone')}</p>;
  return (
    <>
      <Facts
        items={[
          [t('colStatus'), <StatusChip entity="dispute" value={d.status} />],
          [t('colAmount'), <Money value={d.amount} asset={d.assetId} />],
          [t('colReason'), d.reasonCode ? disputeReason(d.reasonCode) : t('notGiven')],
          [t('colDue'), d.responseDueAt ? <DateTime value={d.responseDueAt} /> : <NotConfigured>{t('noDeadline')}</NotConfigured>],
        ]}
      />
      <a className="text-link" href={`/pay/disputes/${encodeURIComponent(d.disputeId)}`}>
        {t('openDisputeLink')}
      </a>
    </>
  );
}
