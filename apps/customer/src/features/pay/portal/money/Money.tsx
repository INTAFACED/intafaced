import { HeroNumber, SegmentedControl } from '@intafaced/ui';
import { EmptyState } from '../../ui-kit';
import { useResource, type Resource } from '../../../../shared/resource';
import { PaySection } from '../../components';
import { Gate, HaltBanner, PortalFailure, PortalLoading } from '../components';
import type { PortalApi } from '../api';
import { useNow, useUrlParam } from '../hooks';
import { EntityList } from '../ui/EntityList';
import { Freshness } from '../ui/Freshness';
import { KpiStrip } from '../ui/Kpi';
import { moneyPlaces } from '../ui/format';
import { MoneyText } from '../ui/MoneyText';
import { StatusChip } from '../ui/StatusChip';
import { DateTime } from '../ui/DateTime';
import { LinkButton, MoneyFailure, TestBanner, payoutName, useTestMode } from './common';
import { mc } from './copy';
import { amountFor, bpsPercent, hasHiddenDigits, roundedDecimal } from './model';
import { statementCard, statementColumns } from './Statement';
import { approvalsBySettlement, defaultStatementRange, payoutRowState } from './model';
import type { PayoutItem } from './schemas';
import type { Approval } from '../schemas';
import { uiCopy } from '../ui/copy';

const WEEK = 7 * 86_400_000;

/** `/pay/money`: what you can pay out now, what is still on its way, and what happened lately. */
export function MerchantMoney({ portal, merchantId }: { portal: PortalApi; merchantId: string }) {
  const { t } = mc.useCopy();
  const [picked, setAsset] = useUrlParam('asset', '');
  const test = useTestMode();
  const snapshot = useResource((s) => portal.snapshot(merchantId, 'today', s), `money:snapshot:${merchantId}`);
  const control = useResource((s) => portal.control(merchantId, s), `money:control:${merchantId}`);
  const halts = useResource((s) => portal.haltStatus(merchantId, s), `money:halts:${merchantId}`);
  const onTheWay = useResource(async (s) => {
    const [posted, pending] = await Promise.all([
      portal.payoutPage({ status: 'posted' }, undefined, s, 10),
      portal.payoutPage({ status: 'pending' }, undefined, s, 10),
    ]);
    if (!posted.ok) return posted;
    if (!pending.ok) return pending;
    const a = 'items' in posted.data ? posted.data : { items: posted.data, nextCursor: null };
    const b = 'items' in pending.data ? pending.data : { items: pending.data, nextCursor: null };
    return {
      ok: true as const,
      data: { items: [...a.items, ...b.items], more: a.nextCursor !== null || b.nextCursor !== null },
    };
  }, `money:on-the-way:${merchantId}`);
  const waiting = useResource((s) => portal.approvalPage(merchantId, { status: 'pending' }, undefined, s), `money:waiting:${merchantId}`);
  const reload = () => {
    snapshot.reload();
    control.reload();
    halts.reload();
    onTheWay.reload();
    waiting.reload();
  };
  return (
    <div className="stack mn-page">
      <HaltBanner resource={halts.resource} scopes={['settlement', 'payout']} />
      <TestBanner />
      <Gate resource={snapshot.resource} retry={reload} rows={4}>
        {(data) => {
          const assets = data.balances.map((b) => b.assetCode);
          if (assets.length === 0)
            return (
              <EmptyState title={t('balEmptyTitle')} action={<LinkButton href="/pay/links/new">{t('balEmptyAction')}</LinkButton>}>
                {t('balEmptyBody')}
              </EmptyState>
            );
          const asset = assets.includes(picked) ? picked : assets[0]!;
          const places = moneyPlaces(asset);
          const balance = data.balances.find((b) => b.assetCode === asset)!;
          const q = `asset=${encodeURIComponent(asset)}`;
          const posted = onTheWay.resource.status === 'ready' ? onTheWay.resource.data.items.filter((p) => p.status === 'posted') : null;
          const pendingApprovals = waiting.resource.status === 'ready' ? waiting.resource.data : null;
          const waitingCount = pendingApprovals ? ('items' in pendingApprovals ? pendingApprovals.items : pendingApprovals).length : null;
          const approvalMap = pendingApprovals
            ? approvalsBySettlement('items' in pendingApprovals ? pendingApprovals.items : pendingApprovals)
            : null;
          const waitingMore = pendingApprovals && 'items' in pendingApprovals ? pendingApprovals.nextCursor !== null : false;
          const reserveBps = control.resource.status === 'ready' ? (control.resource.data.reserve?.rollingReserveBps ?? null) : null;
          const reserveDays = control.resource.status === 'ready' ? (control.resource.data.reserve?.holdDays ?? null) : null;
          const capturedToday = amountFor(data.captured, asset);
          const refundedToday = amountFor(data.refunded, asset);
          return (
            <>
              <Freshness asOf={data.freshness.asOf} lagSeconds={data.freshness.lagSeconds ?? 0} />
              <div className="mn-balance">
                {assets.length > 1 && (
                  <SegmentedControl
                    aria-label={t('balAssetLabel')}
                    size={32}
                    value={asset}
                    onValueChange={setAsset}
                    items={assets.map((a) => ({ value: a, label: a }))}
                  />
                )}
                <div className="mn-hero">
                  <span className="mn-hero-label">{t('balAvailable')}</span>
                  <HeroNumber value={roundedDecimal(balance.available, places)} decimals={places} unit={asset} />
                  {hasHiddenDigits(balance.available, places) && (
                    <span className="muted">
                      {t('balExact')} <MoneyText value={balance.available} asset={asset} test={test} />
                    </span>
                  )}
                  <span className="muted">
                    {t('balPending')} <MoneyText value={balance.clearing} asset={asset} test={test} />
                    {reserveBps !== null && (
                      <>
                        {' · '}
                        {t('balReserve', { pct: bpsPercent(reserveBps) })}
                        {reserveDays !== null ? ` ${t('balReserveDays', { days: reserveDays })}` : ''}
                      </>
                    )}
                  </span>
                </div>
              </div>
              <KpiStrip
                label={t('balTiles')}
                tiles={[
                  {
                    label: t('balAvailable'),
                    period: t('mnPeriodNow'),
                    href: `/pay/money/activity?${q}`,
                    value: <MoneyText value={balance.available} asset={asset} test={test} />,
                  },
                  {
                    label: t('balPending'),
                    period: t('mnPeriodNow'),
                    href: `/pay/money/activity?${q}`,
                    value: <MoneyText value={balance.clearing} asset={asset} test={test} />,
                  },
                  {
                    label: t('balCaptured'),
                    period: t('mnPeriodToday'),
                    href: `/pay/payments?date=today&${q}`,
                    value: capturedToday ? <MoneyText value={capturedToday} asset={asset} test={test} /> : '—',
                  },
                  {
                    label: t('balRefunded'),
                    period: t('mnPeriodToday'),
                    href: `/pay/refunds?date=today&${q}`,
                    value: refundedToday ? <MoneyText value={refundedToday} asset={asset} test={test} /> : '—',
                  },
                  {
                    label: t('balReady'),
                    period: t('mnPeriodNow'),
                    href: '/pay/payouts?status=posted',
                    value: posted
                      ? onTheWay.resource.status === 'ready' && onTheWay.resource.data.more
                        ? t('mnCountNewest', { n: posted.length })
                        : String(posted.length)
                      : '—',
                  },
                  {
                    label: t('balWaiting'),
                    period: t('mnPeriodNow'),
                    href: '/pay/approvals?status=pending',
                    value: waitingCount === null ? '—' : waitingMore ? t('mnCountNewest', { n: waitingCount }) : String(waitingCount),
                    tone: waitingCount ? 'attention' : undefined,
                  },
                ]}
              />
              <PaySection title={t('balAllTitle')}>
                <EntityList
                  label={t('balAllTitle')}
                  rows={data.balances}
                  rowKey={(b) => b.assetCode}
                  columns={[
                    { header: t('colAsset'), cell: (b) => b.assetCode },
                    { header: t('balAvailable'), cell: (b) => <MoneyText value={b.available} asset={b.assetCode} test={test} /> },
                    { header: t('balPending'), cell: (b) => <MoneyText value={b.clearing} asset={b.assetCode} test={test} /> },
                  ]}
                  card={(b) => ({
                    title: b.assetCode,
                    amount: <MoneyText value={b.available} asset={b.assetCode} test={test} />,
                    status: (
                      <span className="muted">
                        {t('balPending')} <MoneyText value={b.clearing} asset={b.assetCode} test={test} />
                      </span>
                    ),
                  })}
                />
              </PaySection>
              <OnTheWay result={onTheWay} approvals={approvalMap} retry={onTheWay.reload} test={test} />
              <RecentMovements portal={portal} merchantId={merchantId} asset={asset} test={test} />
              <p className="muted pp-note">
                <a className="text-link" href="/pay/conversion">
                  {t('balConversionLink')}
                </a>
              </p>
            </>
          );
        }}
      </Gate>
    </div>
  );
}

function OnTheWay({
  result,
  approvals,
  retry,
  test,
}: {
  result: { resource: Resource<{ items: PayoutItem[]; more: boolean }> };
  approvals: ReadonlyMap<string, Approval> | null;
  retry: () => void;
  test: boolean;
}) {
  const { t } = mc.useCopy();
  const locale = uiCopy.useCopy().requestedLocale;
  const r = result.resource;
  return (
    <PaySection
      title={t('balOnTheWayTitle')}
      description={t('balOnTheWayBody')}
      action={
        <a className="text-link" href="/pay/payouts">
          {t('balAllPayouts')}
        </a>
      }
    >
      {r.status === 'loading' ? (
        <PortalLoading rows={2} />
      ) : r.status === 'failed' ? (
        <PortalFailure result={r.failure} retry={retry} />
      ) : r.data.items.length === 0 ? (
        <p className="muted">{t('balOnTheWayNone')}</p>
      ) : (
        <EntityList
          label={t('balOnTheWayTitle')}
          rows={[...r.data.items].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))}
          rowKey={(p) => p.id}
          href={(p) => `/pay/payouts/${encodeURIComponent(p.id)}`}
          columns={[
            { header: t('colPayout'), cell: (p) => payoutName(t, locale, p, approvals?.get(p.id)) },
            { header: t('colAmount'), cell: (p) => <MoneyText value={p.net} asset={p.assetId} test={test} /> },
            { header: t('colStatus'), cell: (p) => <StatusChip entity="payout" value={payoutRowState(p, approvals)} /> },
          ]}
          card={(p) => ({
            title: payoutName(t, locale, p, approvals?.get(p.id)),
            time: <DateTime value={p.createdAt} />,
            amount: <MoneyText value={p.net} asset={p.assetId} test={test} />,
            status: <StatusChip entity="payout" value={payoutRowState(p, approvals)} />,
          })}
        />
      )}
    </PaySection>
  );
}

function RecentMovements({ portal, merchantId, asset, test }: { portal: PortalApi; merchantId: string; asset: string; test: boolean }) {
  const { t } = mc.useCopy();
  const now = useNow(300_000);
  const end = defaultStatementRange(now).to;
  const from = new Date(Date.parse(end) - WEEK - 86_400_000).toISOString();
  const list = useResource(
    (s) => portal.statementPage(merchantId, { assetId: asset, from, to: end }, undefined, s, 6),
    `money:movements:${merchantId}:${asset}:${from}`,
  );
  const r = list.resource;
  return (
    <PaySection
      title={t('balMovementsTitle')}
      action={
        <a className="text-link" href={`/pay/money/activity?asset=${encodeURIComponent(asset)}`}>
          {t('balStatementLink')}
        </a>
      }
    >
      {r.status === 'loading' ? (
        <PortalLoading rows={3} />
      ) : r.status === 'failed' ? (
        <MoneyFailure result={r.failure} retry={list.reload} />
      ) : r.data.items.length === 0 ? (
        <p className="muted">{t('balMovementsNone')}</p>
      ) : (
        <EntityList
          label={t('balMovementsTitle')}
          rows={r.data.items}
          rowKey={(l) => l.id}
          columns={statementColumns(t, test, false)}
          card={statementCard(t, test)}
        />
      )}
    </PaySection>
  );
}
