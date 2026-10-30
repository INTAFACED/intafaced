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
import { DateTime, useDayText } from '../ui/DateTime';
import { utcDay } from '../model';
import { RefundsIssuedValue } from '../payments/RefundsIssued';
import { LinkButton, MoneyFailure, TestBanner, payoutName, useTestMode } from './common';
import { mc } from './copy';
import { amountFor, hasHiddenDigits, roundedDecimal } from './model';
import { ReserveCard } from './Reserve';
import { statementCard, statementColumns } from './Statement';
import { pictureCount, usePayoutPicture, type PayoutPicture } from './payout-picture';
import { defaultStatementRange, payoutRowState } from './model';
import type { Approval } from '../schemas';
import { uiCopy } from '../ui/copy';

const WEEK = 7 * 86_400_000;

/** `/pay/money`: what you can pay out now, what is still on its way, and what happened lately. */
export function MerchantMoney({ portal, merchantId }: { portal: PortalApi; merchantId: string }) {
  const { t } = mc.useCopy();
  const dayText = useDayText();
  const utcToday = dayText(utcDay(new Date(useNow(300_000))));
  const [picked, setAsset] = useUrlParam('asset', '');
  const test = useTestMode();
  const snapshot = useResource((s) => portal.snapshot(merchantId, 'today', s), `money:snapshot:${merchantId}`);
  const reserve = useResource((s) => portal.reserve(merchantId, s), `money:reserve:${merchantId}`);
  const halts = useResource((s) => portal.haltStatus(merchantId, s), `money:halts:${merchantId}`);
  // The same read Settlements and Payouts use, so "ready" and "waiting" are the same figures on every page.
  const picture = usePayoutPicture(portal, merchantId);
  const reload = () => {
    snapshot.reload();
    reserve.reload();
    halts.reload();
    picture.reload();
  };
  return (
    <div className="stack mn-page">
      <HaltBanner resource={halts.resource} scopes={['settlement', 'payout']} />
      <TestBanner />
      {/* Outside the balance read, so Top up is reachable before the first payment and while balances cannot be read. */}
      <div className="pp-actions">
        <LinkButton href="/pay/money/top-up">{t('actTopUp')}</LinkButton>
      </div>
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
          const pic = picture.resource.status === 'ready' ? picture.resource.data : null;
          const countOf = (state: 'ready' | 'awaiting_approval') => {
            if (!pic) return '—';
            const c = pictureCount(pic, state);
            return c.newest ? t('mnCountNewest', { n: c.n }) : String(c.n);
          };
          const approvalMap = pic?.approvals ?? null;
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
                    {t('balClearing')} <MoneyText value={balance.clearing} asset={asset} test={test} />
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
                    label: t('balClearing'),
                    period: t('mnPeriodNow'),
                    href: `/pay/money/activity?${q}`,
                    value: <MoneyText value={balance.clearing} asset={asset} test={test} />,
                  },
                  {
                    label: t('balCaptured'),
                    period: t('mnPeriodToday', { day: utcToday }),
                    href: `/pay/payments?date=today&${q}`,
                    value: capturedToday ? <MoneyText value={capturedToday} asset={asset} test={test} /> : '—',
                  },
                  {
                    label: t('balRefunded'),
                    period: t('mnPeriodToday', { day: utcToday }),
                    href: `/pay/refunds?date=today&${q}`,
                    value: refundedToday ? <MoneyText value={refundedToday} asset={asset} test={test} /> : '—',
                    note: t('balRefundedNote'),
                  },
                  {
                    label: t('balRefundsIssued'),
                    period: t('mnPeriodToday', { day: utcToday }),
                    href: '/pay/refunds?date=today',
                    value: <RefundsIssuedValue portal={portal} merchantId={merchantId} when="today" />,
                    note: t('balRefundsIssuedNote'),
                  },
                  {
                    label: t('balReady'),
                    period: t('mnPeriodNow'),
                    href: '/pay/payouts?status=ready',
                    value: countOf('ready'),
                  },
                  {
                    label: t('balWaiting'),
                    period: t('mnPeriodNow'),
                    href: '/pay/approvals?status=pending',
                    value: countOf('awaiting_approval'),
                    tone: pic && pic.tally.awaiting_approval > 0 ? 'attention' : undefined,
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
                    { header: t('balClearing'), cell: (b) => <MoneyText value={b.clearing} asset={b.assetCode} test={test} /> },
                  ]}
                  card={(b) => ({
                    title: b.assetCode,
                    amount: <MoneyText value={b.available} asset={b.assetCode} test={test} />,
                    status: (
                      <span className="muted">
                        {t('balClearing')} <MoneyText value={b.clearing} asset={b.assetCode} test={test} />
                      </span>
                    ),
                  })}
                />
              </PaySection>
              <OnTheWay resource={picture.resource} approvals={approvalMap} retry={picture.reload} test={test} />
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
      {/* The reserve reads apart from the balances, so it shows before a first payment and while balances cannot be read. */}
      <ReserveCard resource={reserve.resource} retry={reserve.reload} test={test} />
    </div>
  );
}

function OnTheWay({
  resource,
  approvals,
  retry,
  test,
}: {
  resource: Resource<PayoutPicture>;
  approvals: ReadonlyMap<string, Approval> | null;
  retry: () => void;
  test: boolean;
}) {
  const { t } = mc.useCopy();
  const locale = uiCopy.useCopy().requestedLocale;
  const r = resource;
  const items = r.status === 'ready' ? r.data.items.filter((p) => p.status === 'posted' || p.status === 'pending') : [];
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
      ) : items.length === 0 ? (
        <p className="muted">{t('balOnTheWayNone')}</p>
      ) : (
        <EntityList
          label={t('balOnTheWayTitle')}
          rows={[...items].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))}
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
