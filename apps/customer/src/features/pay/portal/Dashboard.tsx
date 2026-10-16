import { useMemo, useState } from 'react';
import { LayoutDashboard } from './home-layout/Dashboard';
import { portalAmount } from './presentation';
import { useResource, type Resource } from '../../../shared/resource';
import { Button, DataTable, EmptyState, ChoiceGroup as Tabs } from '@intafaced/ui';
import { PaySection } from '../components';
import { AsOf, Chip, ComingSoon, Gate, Kpi, KpiGrid, Money, MoneyLines } from './components';
import { portalCopy } from './copy';
import { bars, hasActivity, mixShares, seriesAssets, seriesWindow, utcDay } from './model';
import type { PortalApi } from './api';
import type { MemberRole, MerchantRecord, MetricPreset, Series, Snapshot } from './schemas';

export type DashboardData = {
  today: Resource<Snapshot>;
  rolling_7d: Resource<Snapshot>;
  rolling_30d: Resource<Snapshot>;
  series: Resource<Series>;
};

/** `/pay/merchant`: status strip, KPI tiles, daily chart, status mix and balances, every number with its "as of". */
export function Dashboard({
  portal,
  merchantId,
  merchant,
  role,
}: {
  portal: PortalApi;
  merchantId: string;
  merchant: MerchantRecord | null;
  role: MemberRole | null;
}) {
  const now = useMemo(() => new Date(), []);
  const window = useMemo(() => seriesWindow(now), [now]);
  const key = `portal:dash:${merchantId}`;
  const today = useResource((s) => portal.snapshot(merchantId, 'today', s), `${key}:today`);
  const d7 = useResource((s) => portal.snapshot(merchantId, 'rolling_7d', s), `${key}:7d`);
  const d30 = useResource((s) => portal.snapshot(merchantId, 'rolling_30d', s), `${key}:30d`);
  const series = useResource((s) => portal.series(merchantId, window.from, window.to, s), `${key}:series`);
  const retry = () => {
    today.reload();
    d7.reload();
    d30.reload();
    series.reload();
  };
  return (
    <LayoutDashboard
      portal={portal}
      merchantId={merchantId}
      merchant={merchant}
      role={role}
      data={{ today: today.resource, rolling_7d: d7.resource, rolling_30d: d30.resource, series: series.resource }}
      retry={retry}
      todayDay={utcDay(now)}
    />
  );
}
export { LayoutDashboardView as DashboardView } from './home-layout/Dashboard';

export function DashboardInsights({
  merchant,
  role,
  data,
  retry,
  todayDay,
}: {
  merchant: MerchantRecord | null;
  role: MemberRole | null;
  data: DashboardData;
  retry: () => void;
  todayDay: string;
}) {
  const { t } = portalCopy.useCopy();
  const [period, setPeriod] = useState<MetricPreset>('today');
  const labels: Record<MetricPreset, string> = { today: t('periodToday'), rolling_7d: t('period7d'), rolling_30d: t('period30d') };
  const current = data[period];
  // A brand-new merchant has nothing in any window; one explanation beats a wall of empty tiles.
  const wholeAccountQuiet =
    data.today.status === 'ready' &&
    data.rolling_30d.status === 'ready' &&
    !hasActivity(data.today.data) &&
    !hasActivity(data.rolling_30d.data);
  return (
    <div className="stack pp-dashboard">
      <PaySection title={t('accountStatus')} description={t('accountStatusBody')}>
        <div className="pp-status-strip">
          {merchant ? (
            <>
              <div>
                <span className="pp-strip-label">{t('stripAccount')}</span>
                <Chip kind="merchant" value={merchant.status} />
              </div>
              <div>
                <span className="pp-strip-label">{t('stripVerification')}</span>
                <Chip kind="kyb" value={merchant.kybStatus} />
              </div>
              <div>
                <span className="pp-strip-label">{t('stripMode')}</span>
                <span>{t(merchant.mode === 'gateway' ? 'modeGateway' : merchant.mode === 'psp' ? 'modePsp' : 'modePayfac')}</span>
              </div>
            </>
          ) : (
            <div>
              <span className="pp-strip-label">{t('stripAccount')}</span>
              <span>{t('teamAccount')}</span>
            </div>
          )}
          {role && (
            <div>
              <span className="pp-strip-label">{t('stripRole')}</span>
              <span>{t(`role_${role}` as 'role_owner')}</span>
            </div>
          )}
          <div>
            <span className="pp-strip-label">{t('stripTier')}</span>
            <span className="muted">{t('tierArrivesSoon')}</span>
          </div>
          {merchant && (
            <div>
              <span className="pp-strip-label">{t('stripFee')}</span>
              <span>{merchant.feeBps === null ? t('feeNotPublished') : t('feeBps', { bps: merchant.feeBps })}</span>
            </div>
          )}
        </div>
        {merchant && (merchant.kybStatus !== 'approved' || merchant.status !== 'active') && (
          <p className="pp-callout" role="note">
            {t('finishSetupPrompt')}{' '}
            <a className="text-link" href="/pay/onboarding">
              {t('continueSetup')}
            </a>
          </p>
        )}
      </PaySection>

      <ComingSoon title={t('controlSoonTitle')}>{t('controlSoonBody')}</ComingSoon>

      {wholeAccountQuiet ? (
        <EmptyState
          title={t('dashEmptyTitle')}
          action={
            <Button variant="primary" nativeButton={false} role="link" render={<a href="/pay/links" />}>
              {t('dashEmptyAction')}
            </Button>
          }
        >
          {t('dashEmptyBody')}
        </EmptyState>
      ) : (
        <>
          <PaySection
            title={t('volumeTitle')}
            description={t('volumeBody')}
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
            <Gate resource={current} retry={retry} rows={4}>
              {(snap) => (
                <>
                  <AsOf freshness={snap.freshness} />
                  <KpiGrid label={t('kpiGroup', { period: labels[period] })}>
                    <Kpi
                      label={t('kpiVolume')}
                      period={labels[period]}
                      value={<MoneyLines items={snap.captured} />}
                      note={t('kpiVolumeNote')}
                      href="/pay/payments"
                    />
                    <Kpi
                      label={t('kpiRefunded')}
                      period={labels[period]}
                      value={<MoneyLines items={snap.refunded} />}
                      href="/pay/payments"
                    />
                    <Kpi label={t('kpiNet')} period={labels[period]} value={<MoneyLines items={snap.net} />} note={t('kpiNetNote')} />
                    <Kpi
                      label={t('kpiFees')}
                      period={labels[period]}
                      value={<MoneyLines items={snap.feeRevenue} />}
                      note={t('kpiFeesNote')}
                      href="/pay/settlements"
                    />
                    <Kpi label={t('kpiCount')} period={labels[period]} value={snap.paymentCount} href="/pay/payments" />
                    <Kpi label={t('kpiAverage')} period={labels[period]} value={<MoneyLines items={snap.averagePayment} />} />
                    <Kpi label={t('kpiLargest')} period={labels[period]} value={<MoneyLines items={snap.largestPayment} />} />
                    <Kpi
                      label={t('kpiLinks')}
                      period={labels[period]}
                      value={snap.linkUsage.paymentsViaLinks}
                      note={t('kpiLinksNote', { links: snap.linkUsage.linksUsed })}
                      href="/pay/links"
                    />
                  </KpiGrid>
                </>
              )}
            </Gate>
            <Glance data={data} labels={labels} />
          </PaySection>

          <DailyChart series={data.series} retry={retry} todayDay={todayDay} />

          <div className="pp-two">
            <PaySection title={t('mixTitle')} description={t('mixBody')}>
              <Gate resource={data.rolling_30d} retry={retry} rows={3}>
                {(snap) => <StatusMix snap={snap} />}
              </Gate>
            </PaySection>
            <PaySection title={t('balancesTitle')} description={t('balancesBody')}>
              <Gate resource={data.today} retry={retry} rows={3}>
                {(snap) => <Balances snap={snap} />}
              </Gate>
            </PaySection>
          </div>
        </>
      )}
    </div>
  );
}

function Glance({ data, labels }: { data: DashboardData; labels: Record<MetricPreset, string> }) {
  const { t } = portalCopy.useCopy();
  const presets: MetricPreset[] = ['today', 'rolling_7d', 'rolling_30d'];
  if (presets.some((p) => data[p].status !== 'ready')) return null;
  return (
    <div className="pp-glance" role="group" aria-label={t('glanceTitle')}>
      <h3>{t('glanceTitle')}</h3>
      <div className="pp-kpis pp-kpis--tight">
        {presets.map((p) => {
          const r = data[p];
          return r.status === 'ready' ? (
            <Kpi key={p} label={t('kpiVolume')} period={labels[p]} value={<MoneyLines items={r.data.captured} />} />
          ) : null;
        })}
      </div>
    </div>
  );
}

function DailyChart({ series, retry, todayDay }: { series: Resource<Series>; retry: () => void; todayDay: string }) {
  const { t } = portalCopy.useCopy();
  const [days, setDays] = useState<'7' | '30'>('30');
  const [assetPick, setAssetPick] = useState('');
  const [asTable, setAsTable] = useState(false);
  return (
    <PaySection
      title={t('chartTitle')}
      description={t('chartBody')}
      action={
        <Tabs
          items={['7', '30']}
          value={days}
          onChange={(v) => setDays(v as '7' | '30')}
          label={t('chartRange')}
          labels={{ '7': t('period7d'), '30': t('period30d') }}
        />
      }
    >
      <Gate resource={series} retry={retry} rows={4}>
        {(data) => {
          const assets = seriesAssets(data);
          if (assets.length === 0)
            return (
              <>
                <AsOf freshness={data.freshness} />
                <EmptyState title={t('chartEmptyTitle')}>{t('chartEmptyBody')}</EmptyState>
              </>
            );
          const asset = assets.includes(assetPick) ? assetPick : assets[0]!;
          const rows = bars(data, asset, Number(days), todayDay);
          return (
            <>
              <AsOf freshness={data.freshness} />
              {assets.length > 1 && <Tabs items={assets} value={asset} onChange={setAssetPick} label={t('chartAsset')} />}
              <div className="pp-chart" role="img" aria-label={t('chartAria', { asset, days })}>
                {rows.map((bar) => (
                  <div key={bar.day} className="pp-bar-slot" title={`${bar.day}: ${portalAmount(bar.volume, asset)} ${asset}`}>
                    <span
                      className={`pp-bar${bar.today ? ' pp-bar--today' : ''}`}
                      style={{ height: `${Math.max(bar.pct, bar.pct > 0 ? 2 : 0)}%` }}
                    />
                  </div>
                ))}
              </div>
              <div className="pp-chart-axis" aria-hidden="true">
                <span>{rows[0]?.day}</span>
                <span>{rows[rows.length - 1]?.day}</span>
              </div>
              <Button variant="ghost" aria-expanded={asTable} onClick={() => setAsTable(!asTable)}>
                {asTable ? t('chartHideTable') : t('chartShowTable')}
              </Button>
              {asTable && (
                <DataTable label={t('chartTableLabel', { asset })} headers={[t('colDay'), t('colVolume', { asset })]}>
                  {[...rows].reverse().map((bar) => (
                    <tr key={bar.day}>
                      <td>{bar.day}</td>
                      <td className="numeric">{portalAmount(bar.volume, asset)}</td>
                    </tr>
                  ))}
                </DataTable>
              )}
            </>
          );
        }}
      </Gate>
    </PaySection>
  );
}

function StatusMix({ snap }: { snap: Snapshot }) {
  const { t } = portalCopy.useCopy();
  const rows = mixShares(snap.statusMix);
  if (rows.length === 0) return <p className="muted">{t('mixEmpty')}</p>;
  return (
    <>
      <AsOf freshness={snap.freshness} />
      <ul className="pp-mix" aria-label={t('mixTitle')}>
        {rows.map((row) => (
          <li key={row.status}>
            <div className="pp-mix-head">
              <Chip kind="payment" value={row.status} />
              <span className="numeric">
                {row.count} · {row.pct}%
              </span>
            </div>
            <span className="pp-mix-bar" aria-hidden="true">
              <span style={{ width: `${row.pct}%` }} />
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

function Balances({ snap }: { snap: Snapshot }) {
  const { t } = portalCopy.useCopy();
  if (snap.balances.length === 0) return <p className="muted">{t('balancesEmpty')}</p>;
  return (
    <>
      <AsOf freshness={snap.freshness} />
      <DataTable label={t('balancesTitle')} headers={[t('colAsset'), t('colAvailable'), t('colPending')]}>
        {snap.balances.map((b) => (
          <tr key={b.assetCode}>
            <th scope="row">{b.assetCode}</th>
            <td className="numeric">
              <Money value={b.available} asset={b.assetCode} />
            </td>
            <td className="numeric">
              <Money value={b.clearing} asset={b.assetCode} />
            </td>
          </tr>
        ))}
      </DataTable>
      <p className="muted pp-note">{t('balancesNote')}</p>
    </>
  );
}
