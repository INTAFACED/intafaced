// volt-room: /pay/merchant
// volt-room: portal:dashboard
import { useMemo, useState, type ReactNode } from 'react';
import { Meter, SectionTabs } from '@intafaced/ui/lit/templates';
import { LayoutDashboard } from './DashboardHome';
import { useResource, type Resource } from '../../../../shared/resource';
import { useMerchantAccess } from '../access/MerchantAccess';
import { AsOf, Chip, Empty, Failure, Gate, Grid, LinkButton, Loading, MoneyLines, MoneyText, Section } from '../volt/parts';
import { OverviewRoom, useOverviewGate, type OverviewFrame } from '../volt/OverviewRoom';
import { portalCopy } from './copy';
import { utcDay } from '../model';
import { hasActivity, mixShares, seriesWindow } from './model';
import type { PortalApi } from '../api';
import type { MemberRole, MerchantRecord, MetricPreset, Series, Snapshot } from '../schemas';

export type DashboardData = {
  today: Resource<Snapshot>;
  rolling_7d: Resource<Snapshot>;
  rolling_30d: Resource<Snapshot>;
  series: Resource<Series>;
};

/**
 * `/pay/merchant` on the overview template: the balance, KPI tiles, daily chart, status mix and balances, every number
 * with its "as of". The business comes from the resolved access; its record is read first, as the old page did, so a
 * record that cannot be read is said before any figure.
 */
export function Dashboard({ portal }: { portal: PortalApi }) {
  const { frame, account } = useOverviewGate();
  const { merchant, reloadMerchant } = useMerchantAccess();
  if (!account) return <OverviewRoom frame={frame} hero={null} />;
  if (merchant.status === 'loading') return <OverviewRoom frame={frame} hero={<Loading rows={5} />} />;
  if (merchant.status === 'failed')
    return <OverviewRoom frame={frame} hero={<Failure result={merchant.failure} retry={reloadMerchant} />} />;
  return <DashboardReads portal={portal} merchantId={account.merchantId} merchant={account.record} role={account.role} frame={frame} />;
}

function DashboardReads({
  portal,
  merchantId,
  merchant,
  role,
  frame,
}: {
  portal: PortalApi;
  merchantId: string;
  merchant: MerchantRecord | null;
  role: MemberRole | null;
  frame: OverviewFrame;
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
      frame={frame}
    />
  );
}
export { LayoutDashboardView as DashboardView } from './DashboardHome';

/** A figure that opens the list holding it, or stands alone; it names its period (`Kpi` in `../components`). */
function Kpi({ label, period, value, note, href }: { label: string; period?: string; value: ReactNode; note?: ReactNode; href?: string }) {
  const body = (
    <>
      <span>
        {label}
        {period && <em> {period}</em>}
      </span>{' '}
      <strong>{value}</strong>
      {note && (
        <>
          {' '}
          <small className="lt-hint">{note}</small>
        </>
      )}
    </>
  );
  return (
    <li>
      {href ? (
        <a className="lt-row-link" href={href}>
          {body}
        </a>
      ) : (
        body
      )}
    </li>
  );
}

function KpiGrid({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ul className="lt-kv" role="group" aria-label={label}>
      {children}
    </ul>
  );
}

export function DashboardInsights({
  data,
  retry,
  issued,
}: {
  data: DashboardData;
  retry: () => void;
  issued?: (when: MetricPreset) => ReactNode;
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
  if (wholeAccountQuiet)
    return (
      <Empty
        title={t('dashEmptyTitle')}
        action={
          <LinkButton href="/pay/links" tone="primary">
            {t('dashEmptyAction')}
          </LinkButton>
        }
      >
        {t('dashEmptyBody')}
      </Empty>
    );
  return (
    <>
      <Section
        title={t('volumeTitle')}
        description={t('volumeBody')}
        action={
          <SectionTabs
            items={(['today', 'rolling_7d', 'rolling_30d'] as const).map((value) => ({ value, label: labels[value] }))}
            value={period}
            onChange={setPeriod}
            label={t('periodLabel')}
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
                  note={t('kpiRefundedNote')}
                  href="/pay/payments"
                />
                {issued && (
                  <Kpi
                    label={t('refundsIssuedLabel')}
                    period={labels[period]}
                    value={issued(period)}
                    note={t('refundsIssuedNote')}
                    href="/pay/refunds"
                  />
                )}
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
      </Section>
      <Section title={t('mixTitle')} description={t('mixBody')}>
        <Gate resource={data.rolling_30d} retry={retry} rows={3}>
          {(snap) => <StatusMix snap={snap} />}
        </Gate>
      </Section>
      <Section title={t('balancesTitle')} description={t('balancesBody')}>
        <Gate resource={data.today} retry={retry} rows={3}>
          {(snap) => <Balances snap={snap} />}
        </Gate>
      </Section>
    </>
  );
}

function Glance({ data, labels }: { data: DashboardData; labels: Record<MetricPreset, string> }) {
  const { t } = portalCopy.useCopy();
  const presets: MetricPreset[] = ['today', 'rolling_7d', 'rolling_30d'];
  if (presets.some((p) => data[p].status !== 'ready')) return null;
  return (
    <div role="group" aria-label={t('glanceTitle')}>
      <h3>{t('glanceTitle')}</h3>
      <ul className="lt-kv">
        {presets.map((p) => {
          const r = data[p];
          return r.status === 'ready' ? (
            <Kpi key={p} label={t('kpiVolume')} period={labels[p]} value={<MoneyLines items={r.data.captured} />} />
          ) : null;
        })}
      </ul>
    </div>
  );
}

function StatusMix({ snap }: { snap: Snapshot }) {
  const { t } = portalCopy.useCopy();
  const rows = mixShares(snap.statusMix);
  if (rows.length === 0) return <p className="lt-hint">{t('mixEmpty')}</p>;
  return (
    <>
      <AsOf freshness={snap.freshness} />
      <ul className="lt-rows" aria-label={t('mixTitle')}>
        {rows.map((row) => (
          <li key={row.status}>
            <p className="lt-actions">
              <Chip kind="payment" value={row.status} />
              <span>
                {row.count} · {row.pct}%
              </span>
            </p>
            <Meter label={row.status} value={row.pct} text={`${row.pct}%`} />
          </li>
        ))}
      </ul>
    </>
  );
}

function Balances({ snap }: { snap: Snapshot }) {
  const { t } = portalCopy.useCopy();
  if (snap.balances.length === 0) return <p className="lt-hint">{t('balancesEmpty')}</p>;
  return (
    <>
      <AsOf freshness={snap.freshness} />
      <Grid label={t('balancesTitle')} headers={[t('colAsset'), t('colAvailable'), t('colPending')]}>
        {snap.balances.map((b) => (
          <tr key={b.assetCode}>
            <th scope="row">{b.assetCode}</th>
            <td>
              <MoneyText value={b.available} asset={b.assetCode} />
            </td>
            <td>
              <MoneyText value={b.clearing} asset={b.assetCode} />
            </td>
          </tr>
        ))}
      </Grid>
      <p className="lt-hint">{t('balancesNote')}</p>
    </>
  );
}
