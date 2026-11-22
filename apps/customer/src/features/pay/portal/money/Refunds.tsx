import { PaymentCell } from '../payments/PaymentCell';
import { RefundsIssuedValue } from '../payments/RefundsIssued';
import { Button } from '@intafaced/ui';
import { useResource } from '../../../../shared/resource';
import { PaySection } from '../../components';
import { Facts, Gate } from '../components';
import type { PortalApi } from '../api';
import { buildCsv, downloadText } from '../csv';
import { useReadAt, useUrlParam } from '../hooks';
import { isUuid } from '../model';
import { AuditPanel } from '../ui/AuditPanel';
import { CopyReference } from '../ui/CopyReference';
import { DateTime } from '../ui/DateTime';
import { DetailHeader } from '../ui/DetailHeader';
import { FilterRow, useListFilters } from '../ui/FilterRow';
import { Freshness } from '../ui/Freshness';
import { KpiStrip } from '../ui/Kpi';
import { MoneyList, MoneyText } from '../ui/MoneyText';
import { RelatedLinks } from '../ui/RelatedLinks';
import { ToneChip, type StatusTone } from '../ui/StatusChip';
import { Timeline } from '../ui/Timeline';
import { uiCopy } from '../ui/copy';
import { useServerList } from '../ui/useServerList';
import { ExportButton, LinkButton, ListBody, localRefusal, shortDay, TestBanner, useListQuery, useTestMode } from './common';
import { mc } from './copy';
import { MoneyAction } from '../access/MoneyAction';
import { refundRate } from './model';
import { type PayRefundItem as RefundItem, payRefundStatusSchema } from '@intafaced/contracts/pay-portal-reads';

type Words = ReturnType<typeof mc.useCopy>['t'];

export const refundHref = (id: string) => `/pay/refunds/${encodeURIComponent(id)}`;
const TONE: Record<RefundItem['status'], StatusTone> = { posted: 'action', settled: 'done', reversed: 'failed' };
export function RefundChip({ status }: { status: RefundItem['status'] }) {
  const { t } = mc.useCopy();
  return <ToneChip tone={TONE[status]} label={t(`rfStatus_${status}` as 'rfStatus_posted')} tip={t(`rfTip_${status}` as 'rfTip_posted')} />;
}
const sourceWords = (t: Words, source: RefundItem['source']) =>
  source === 'clearing' ? t('rfSource_clearing') : source === 'settled' ? t('rfSource_settled') : t('rfSource_unknown');
const potWords = (t: Words, pot: NonNullable<RefundItem['ledgerEffect']>['pot']) =>
  pot === 'clearing'
    ? t('rfPot_clearing')
    : pot === 'merchantProceeds'
      ? t('rfPot_merchantProceeds')
      : pot === 'userAvailable'
        ? t('rfPot_userAvailable')
        : t('rfPot_unknown');

/** `/pay/refunds`: every refund on the account. A refund starts from a payment, never from typing an id. */
export function Refunds({ portal, merchantId }: { portal: PortalApi; merchantId: string }) {
  const { t } = mc.useCopy();
  const locale = uiCopy.useCopy().requestedLocale;
  const test = useTestMode();
  const filters = useListFilters();
  const query = useListQuery(filters);
  const [paymentFilter] = useUrlParam('payment', '');
  const snapshot = useResource((s) => portal.snapshot(merchantId, 'rolling_30d', s), `money:refund-snapshot:${merchantId}`);
  const newest = useResource(
    (s) => portal.refundPage(merchantId, { from: new Date(Date.now() - 30 * 86_400_000).toISOString() }, undefined, s),
    `money:refund-count:${merchantId}`,
  );
  const list = useServerList(
    (f, cursor, signal) =>
      portal.refundPage(
        merchantId,
        {
          status: f.status,
          assetId: f.assetId,
          from: f.from,
          to: f.to,
          search: f.search,
          ...(f.paymentId ? { paymentId: f.paymentId } : {}),
        },
        cursor,
        signal,
      ),
    {
      status: query.status ?? '',
      assetId: query.assetId ?? '',
      from: query.from ?? '',
      to: query.to ?? '',
      search: query.search ?? '',
      paymentId: isUuid(paymentFilter) ? paymentFilter : '',
    },
    (r: RefundItem) => r.id,
  );
  const readAt = useReadAt(list.state.status === 'ready', list.state);
  const rows = list.state.status === 'ready' ? list.state.items : [];
  const snap = snapshot.resource.status === 'ready' ? snapshot.resource.data : null;
  const assets = [...new Set([...rows.map((r) => r.assetId), ...(snap?.captured.map((c) => c.assetCode) ?? [])])].sort();
  const asset = filters.asset || (assets.length === 1 ? assets[0]! : '');
  const refunded = snap?.refunded.find((a) => a.assetCode === asset)?.amount ?? null;
  const captured = snap?.captured.find((a) => a.assetCode === asset)?.amount ?? null;
  const rate = refunded !== null && captured !== null ? refundRate(refunded, captured) : null;
  const n = newest.resource.status === 'ready' ? newest.resource.data : null;
  // Reversed refunds never reached the customer, so the count leaves them out and says how many there were.
  const done = n ? n.items.filter((r) => r.status !== 'reversed') : [];
  const reversed = n ? n.items.length - done.length : 0;
  return (
    <div className="stack">
      <TestBanner />
      <Freshness asOf={snap?.freshness.asOf ?? readAt} lagSeconds={snap?.freshness.lagSeconds ?? 0} />
      <KpiStrip
        label={t('rfTiles')}
        tiles={[
          {
            label: t('rfCount'),
            period: t('mnPeriod30'),
            href: '/pay/refunds?date=30d',
            value: n ? (n.nextCursor ? t('mnCountNewest', { n: done.length }) : String(done.length)) : '—',
            note: reversed > 0 ? t(n?.nextCursor ? 'rfCountReversedNoteMore' : 'rfCountReversedNote', { n: reversed }) : undefined,
          },
          {
            label: t('rfRefunded'),
            period: t('mnPeriod30'),
            href: '/pay/refunds?date=30d',
            value: snap ? <MoneyList items={snap.refunded} emptyLabel={t('noPaymentsInPeriod')} /> : '—',
            note: t('rfRefundedNote'),
          },
          {
            label: t('rfIssuedTile'),
            period: t('mnPeriod30'),
            href: '/pay/refunds?date=30d',
            value: <RefundsIssuedValue portal={portal} merchantId={merchantId} when="30d" />,
            note: t('rfIssuedTileNote'),
          },
          {
            label: t('rfCaptured'),
            period: t('mnPeriod30'),
            href: '/pay/payments?date=30d',
            value: snap ? <MoneyList items={snap.captured} emptyLabel={t('noPaymentsInPeriod')} /> : '—',
          },
          {
            label: t('rfRate'),
            period: t('mnPeriod30'),
            href: '/pay/refunds?date=30d',
            value: rate ?? '—',
            note: rate ? (asset ? asset : undefined) : asset ? t('rfRateNone') : t('rfRatePickAsset'),
          },
        ]}
      />
      <FilterRow
        filters={filters}
        label={t('rfFilters')}
        statuses={payRefundStatusSchema.options.map((s) => [s, t(`rfStatus_${s}` as 'rfStatus_posted')] as const)}
        assets={assets}
        shown={rows.length}
        hasMore={list.state.status === 'ready' && list.state.hasMore}
      />
      {isUuid(paymentFilter) && (
        <p className="muted pp-note">
          {t('rfForPayment')}{' '}
          <a className="text-link" href={`/pay/payments/${encodeURIComponent(paymentFilter)}`}>
            {t('rfOpenPayment')}
          </a>{' '}
          ·{' '}
          <a className="text-link" href="/pay/refunds">
            {t('rfShowAll')}
          </a>
        </p>
      )}
      {list.state.status === 'ready' && (
        <ExportButton
          portal={portal}
          kind="refunds"
          query={query}
          fallback={
            <Button
              variant="secondary"
              disabled={rows.length === 0}
              onClick={() =>
                downloadText(
                  'refunds-this-page.csv',
                  buildCsv(
                    ['refund_id', 'payment_id', 'created', 'amount', 'asset', 'status'],
                    rows.map((r) => [r.refundId, r.paymentId, r.createdAt, r.amount, r.assetId, r.status]),
                    { generatedAt: new Date().toISOString(), asOf: readAt ?? '' },
                  ),
                )
              }
            >
              {t('mnExportPage')}
            </Button>
          }
        />
      )}
      <ListBody
        state={list.state}
        retry={() => list.reload()}
        onMore={list.loadMore}
        filtered={{
          active: Boolean(filters.search || filters.status || filters.date || filters.asset),
          clear: () => {
            filters.setSearch('');
            filters.setStatus('');
            filters.setDate('');
            filters.setAsset('');
          },
        }}
        empty={{
          title: t('rfEmptyTitle'),
          body: t('rfEmptyBody'),
          action: (
            <MoneyAction kind="refund">
              <LinkButton href="/pay/refunds/new">{t('rfIssue')}</LinkButton>
            </MoneyAction>
          ),
        }}
        label={t('rfTable')}
        rowKey={(r) => r.id}
        href={(r) => refundHref(r.id)}
        columns={[
          { header: t('mnColRefund'), cell: (r) => t('refundName', { when: shortDay(r.createdAt, locale) }) },
          { header: t('colAmount'), cell: (r) => <MoneyText value={r.amount} asset={r.assetId} test={test} /> },
          { header: t('colStatus'), cell: (r) => <RefundChip status={r.status} /> },
          { header: t('rfPayment'), cell: (r) => <PaymentCell portal={portal} paymentId={r.paymentId} /> },
          { header: t('rfFrom'), cell: (r) => sourceWords(t, r.source ?? null) },
          { header: t('mnColCreated'), cell: (r) => <DateTime value={r.createdAt} /> },
        ]}
        card={(r) => ({
          title: t('refundName', { when: shortDay(r.createdAt, locale) }),
          time: <DateTime value={r.createdAt} />,
          amount: <MoneyText value={r.amount} asset={r.assetId} test={test} />,
          status: <RefundChip status={r.status} />,
        })}
      />
    </div>
  );
}

// ---- detail ---------------------------------------------------------------------------------------------

/** `/pay/refunds/:id`: what went back to the customer, from where, and what happened to it. */
export function RefundDetail({ portal, refundId }: { portal: PortalApi; refundId: string }) {
  const { t } = mc.useCopy();
  const locale = uiCopy.useCopy().requestedLocale;
  const test = useTestMode();
  const valid = isUuid(refundId);
  const refund = useResource(
    (s) => (valid ? portal.refundGet(refundId, s) : Promise.resolve(localRefusal(t('rRefundNotFound')))),
    `money:refund:${refundId}`,
  );
  const readAt = useReadAt(refund.resource.status === 'ready', refund.resource);
  const r = refund.resource;
  return (
    <div className="stack">
      <Gate resource={r} retry={refund.reload} rows={4}>
        {(x) => {
          const events = [
            { at: x.createdAt, title: t('rfEvPosted') },
            ...(x.status === 'settled' && x.settledAt ? [{ at: x.settledAt, title: t('rfEvSettled') }] : []),
            ...(x.status === 'reversed' ? [{ at: x.settledAt ?? x.createdAt, title: t('rfEvReversed') }] : []),
          ];
          return (
            <>
              <DetailHeader
                back={{ href: '/pay/refunds', label: t('backRefunds') }}
                title={<MoneyText value={x.amount} asset={x.assetId} />}
                status={<RefundChip status={x.status} />}
                subtitle={t('refundName', { when: shortDay(x.createdAt, locale) })}
                action={
                  <LinkButton variant="primary" href={`/pay/payments/${encodeURIComponent(x.paymentId)}`}>
                    {t('rfOpenPayment')}
                  </LinkButton>
                }
              />
              <TestBanner />
              <Freshness asOf={readAt} />
              <PaySection title={t('rfFactsTitle')}>
                <Facts
                  items={[
                    [t('colAmount'), <MoneyText value={x.amount} asset={x.assetId} test={test} />],
                    [t('rfFrom'), sourceWords(t, x.source ?? null)],
                    [
                      t('rfLedger'),
                      x.ledgerEffect?.recorded ? potWords(t, x.ledgerEffect.pot) : <span className="muted">{t('rfLedgerNone')}</span>,
                    ],
                    [t('rfReason'), x.reason ? x.reason : <span className="muted">{t('rfReasonNone')}</span>],
                    [t('mnColCreated'), <DateTime value={x.createdAt} />],
                    [t('rfReference'), <CopyReference value={x.refundId} what={t('rfReference')} />],
                  ]}
                />
              </PaySection>
              <PaySection title={t('rfTimelineTitle')}>
                <Timeline label={t('rfTimelineTitle')} items={events} />
              </PaySection>
              <RelatedLinks
                links={[
                  { href: `/pay/payments/${encodeURIComponent(x.paymentId)}`, label: t('rfOpenPayment') },
                  { href: `/pay/refunds?payment=${encodeURIComponent(x.paymentId)}`, label: t('rfOthersForPayment') },
                ]}
              />
              <AuditPanel who={x.actor ?? null} at={x.createdAt} />
            </>
          );
        }}
      </Gate>
    </div>
  );
}

// ---- new ------------------------------------------------------------------------------------------------

/** `/pay/refunds/new` is drawn on the flow template in `../flow/RefundNewRoom.tsx`. */
export { RefundNew } from '../flow/RefundNewRoom';
