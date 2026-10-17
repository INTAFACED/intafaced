import { useState, type ReactNode } from 'react';
import { ArrowDownLeft, ArrowUpRight, Link2, Undo2 } from 'lucide-react';
import { Button, ChoiceGroup, DataTable, Accordion, AccordionItem, AccordionTrigger, AccordionPanel } from '@intafaced/ui';
import { EmptyState } from '../../ui-kit';
import { useResource, type Resource } from '../../../../shared/resource';
import type { PortalApi } from '../api';
import { DashboardInsights, type DashboardData } from './Dashboard';
import { AsOf, Chip, Gate, HaltBanner, Money, MoneyLines, ReadAt } from '../components';
import { useReadAt } from '../hooks';
import { bars } from '../model';
import { seriesAssets } from './model';
import type { MemberRole, MerchantRecord, MetricPreset, Payment, Series, Snapshot } from '../schemas';
import { layoutCopy as c, portalCopy } from './copy';
import { MoneyDisplay, paymentLabel, portalAmount } from '../presentation';
import { TierUsage } from './TierUsage';
import { dateRange } from '../ui/FilterRow';
import { DateTime, UTC } from '../ui/DateTime';

export function LayoutDashboard({
  portal,
  merchantId,
  merchant,
  role,
  data,
  retry,
  todayDay,
}: {
  portal: PortalApi;
  merchantId: string;
  merchant: MerchantRecord | null;
  role: MemberRole | null;
  data: DashboardData;
  retry: () => void;
  todayDay: string;
}) {
  const halts = useResource((s) => portal.haltStatus(merchantId, s), `portal:home-halts:${merchantId}`);
  return (
    <>
      <HaltBanner resource={halts.resource} scopes={['intake', 'payout']} />
      <LayoutDashboardView
        merchant={merchant}
        role={role}
        data={data}
        retry={retry}
        todayDay={todayDay}
        activity={role === 'owner' ? <RecentPayments portal={portal} merchantId={merchantId} /> : null}
        tier={<TierUsage portal={portal} merchantId={merchantId} />}
      />
    </>
  );
}
export function LayoutDashboardView({
  merchant,
  role,
  data,
  retry,
  todayDay,
  activity,
  tier,
}: {
  merchant: MerchantRecord | null;
  role: MemberRole | null;
  data: DashboardData;
  retry: () => void;
  todayDay: string;
  activity?: ReactNode;
  tier?: ReactNode;
}) {
  const { t } = c.useCopy();
  const [pickedAsset, setAsset] = useState('');
  const [period, setPeriod] = useState<MetricPreset>('today');
  const labels = { today: t('today'), rolling_7d: t('week'), rolling_30d: t('month') };
  const actions =
    role === 'owner' ? (
      <nav className="plo-actions" aria-label={t('available')}>
        <Button variant="primary" nativeButton={false} role="link" render={<a href={'/pay/links/new'} />}>
          <Link2 size={16} aria-hidden="true" />
          {t('createLink')}
        </Button>
        <Button variant="secondary" nativeButton={false} role="link" render={<a href={'/pay/payouts?view=tools'} />}>
          <ArrowUpRight size={16} aria-hidden="true" />
          {t('payOut')}
        </Button>
        <Button variant="secondary" nativeButton={false} role="link" render={<a href={'/pay/refunds/new'} />}>
          <Undo2 size={16} aria-hidden="true" />
          {t('refund')}
        </Button>
      </nav>
    ) : null;
  const hero = (
    <section className="plo-balance" aria-label={t('available')}>
      <p className="plo-label">{t('available')}</p>
      <Gate resource={data.today} retry={retry} rows={2}>
        {(snap) => (
          <>
            {snap.balances.length > 1 && (
              <ChoiceGroup
                items={snap.balances.map((b) => b.assetCode)}
                value={pickedAsset || snap.balances[0]!.assetCode}
                onChange={setAsset}
                label={t('balanceAsset')}
              />
            )}
            {snap.balances.length ? (
              snap.balances
                .filter(
                  (b) =>
                    b.assetCode === (snap.balances.some((b) => b.assetCode === pickedAsset) ? pickedAsset : snap.balances[0]?.assetCode),
                )
                .map((balance) => (
                  <div className="plo-balance-asset" key={balance.assetCode}>
                    <MoneyDisplay sensitive className="plo-number" value={balance.available} asset={balance.assetCode} />
                    <span className="plo-unit">{balance.assetCode}</span>
                  </div>
                ))
            ) : (
              <EmptyState title={t('noBalance')}>{t('noBalanceBody')}</EmptyState>
            )}
            <AsOf freshness={snap.freshness} />
          </>
        )}
      </Gate>
      {actions}
    </section>
  );
  const account = (
    <section className="plo-card plo-account">
      <div className="plo-section-head">
        <h2>{t('account')}</h2>
        <a href={'/pay/settings'}>
          <ArrowUpRight size={18} aria-label={t('settings')} />
        </a>
      </div>
      <div className="plo-account-status">
        {merchant && (
          <>
            <Chip kind="merchant" value={merchant.status} />
            <Chip kind="kyb" value={merchant.kybStatus} />
          </>
        )}
        {role && <span>{portalCopy.t(`role_${role}` as 'role_owner')}</span>}
      </div>
      {tier}
      {merchant && (merchant.status !== 'active' || merchant.kybStatus !== 'approved') && <a href={'/pay/onboarding'}>{t('setup')} →</a>}
    </section>
  );
  const pending = (
    <section className="plo-card">
      <div className="plo-section-head">
        <h2>{t('pending')}</h2>
        <a href={'/pay/settlements'}>{t('viewAll')} →</a>
      </div>
      <Gate resource={data.today} retry={retry} rows={1}>
        {(snap) => (
          <>
            <div className="plo-pending">
              {snap.balances.map((b) => (
                <div key={b.assetCode}>
                  <Money value={b.clearing} asset={b.assetCode} />
                </div>
              ))}
            </div>
            <AsOf freshness={snap.freshness} />
          </>
        )}
      </Gate>
    </section>
  );
  const metrics = (
    <section className="plo-metrics" aria-label={t('period')}>
      <div className="plo-section-head">
        <h2>{t('payments')}</h2>
        <ChoiceGroup
          items={['today', 'rolling_7d', 'rolling_30d']}
          value={period}
          labels={labels}
          onChange={(v) => setPeriod(v as MetricPreset)}
          label={t('period')}
        />
      </div>
      <Gate resource={data[period]} retry={retry} rows={1}>
        {(snap) => (
          <>
            <MetricStrip snap={snap} period={labels[period]} key={period} when={period} />
            <AsOf freshness={snap.freshness} />
          </>
        )}
      </Gate>
    </section>
  );
  const chart = <VolumeChart resource={data.series} retry={retry} todayDay={todayDay} />;
  return (
    <div className="plo-home-grid">
      <div className="plo-main">
        {hero}
        {metrics}
        {pending}
        <Accordion className="plo-card">
          <AccordionItem value="volume">
            <AccordionTrigger>{t('volume')}</AccordionTrigger>
            <AccordionPanel>{chart}</AccordionPanel>
          </AccordionItem>
          <AccordionItem value="insights">
            <AccordionTrigger>{t('insights')}</AccordionTrigger>
            <AccordionPanel>
              <DashboardInsights merchant={merchant} role={role} data={data} retry={retry} todayDay={todayDay} />
            </AccordionPanel>
          </AccordionItem>
        </Accordion>
      </div>
      <aside className="plo-rail">
        <section className="plo-card">{activity}</section>
        {account}
      </aside>
    </div>
  );
}

const WHEN = { today: 'today', rolling_7d: '7d', rolling_30d: '30d' } as const;
/** Each tile names its period and opens the list with that same period and filter in the address. */
export function MetricStrip({ snap, period, when }: { snap: Snapshot; period: string; when: MetricPreset }) {
  const { t } = c.useCopy();
  const key = WHEN[when];
  const range = dateRange(key, Date.now());
  const refunds = `/pay/refunds?${new URLSearchParams({ ...(range.from ? { from: range.from } : {}), ...(range.to ? { to: range.to } : {}) })}`;
  const payments = (status?: string) => `/pay/payments?${new URLSearchParams({ ...(status ? { status } : {}), date: key })}`;
  return (
    <div className="plo-kpi-strip">
      {[
        [t('captured'), <MoneyLines items={snap.captured} />, payments()],
        [t('count'), snap.paymentCount, payments()],
        [t('refunded'), <MoneyLines items={snap.refunded} />, refunds],
        [t('net'), <MoneyLines items={snap.net} />, '/pay/money'],
      ].map(([label, value, href], index) => (
        <a key={index} href={href as string}>
          <span>
            {label} · {period}
          </span>
          <strong>{value}</strong>
        </a>
      ))}
    </div>
  );
}
function RecentPayments({ portal, merchantId }: { portal: PortalApi; merchantId: string }) {
  const list = useResource((s) => portal.payments(merchantId, '', 6, s), `portal:home-recent:${merchantId}`);
  const at = useReadAt(list.resource.status === 'ready', list.resource);
  return <RecentPaymentsView resource={list.resource} retry={list.reload} at={at} />;
}
export function RecentPaymentsView({ resource, retry, at }: { resource: Resource<Payment[]>; retry: () => void; at: string | null }) {
  const { t } = c.useCopy();
  return (
    <>
      <div className="plo-section-head">
        <h2>{t('recent')}</h2>
        <a href={'/pay/payments'}>{t('viewAll')} →</a>
      </div>
      <Gate resource={resource} retry={retry} rows={4}>
        {(rows) =>
          rows.length ? (
            <>
              <ul className="plo-payment-feed">
                {rows.map((payment) => (
                  <li key={payment.id}>
                    <a href={`/pay/payments/${encodeURIComponent(payment.id)}`}>
                      <span className="plo-payment-icon">
                        <ArrowDownLeft size={18} aria-hidden="true" />
                      </span>
                      <span className="plo-payment-label">
                        <strong>{paymentLabel(payment)}</strong>
                        <span>
                          <Chip kind="payment" value={payment.status} /> ·{' '}
                          <DateTime value={payment.createdAt} timeZone={UTC} dayOnly />
                        </span>
                      </span>
                      <span className="plo-payment-amount">
                        <Money value={payment.amount} asset={payment.assetId} />
                      </span>
                    </a>
                  </li>
                ))}
              </ul>
              <ReadAt at={at} />
            </>
          ) : (
            <EmptyState title={t('noPayments')} action={<a href={'/pay/links/new'}>{t('createLink')}</a>}>
              {t('noPaymentsBody')}
            </EmptyState>
          )
        }
      </Gate>
    </>
  );
}
function VolumeChart({ resource, retry, todayDay }: { resource: Resource<Series>; retry: () => void; todayDay: string }) {
  const { t } = c.useCopy();
  const [days, setDays] = useState('30');
  const [pick, setPick] = useState('');
  const [table, setTable] = useState(false);
  return (
    <section className="plo-volume">
      <div className="plo-section-head">
        <h2>{t('volume')}</h2>
        <ChoiceGroup
          items={['1', '7', '30']}
          value={days}
          onChange={setDays}
          label={t('period')}
          labels={{ '1': t('today'), '7': t('week'), '30': t('month') }}
        />
      </div>
      <Gate resource={resource} retry={retry} rows={4}>
        {(series) => {
          const assets = seriesAssets(series);
          const asset = assets.includes(pick) ? pick : assets[0];
          if (!asset)
            return (
              <>
                <AsOf freshness={series.freshness} />
                <EmptyState title={t('noSeries')}>{t('noPaymentsBody')}</EmptyState>
              </>
            );
          const points = bars(series, asset, Number(days), todayDay);
          return (
            <>
              <p className="plo-chart-caption">
                {t('volumeBody')} · {asset}
              </p>
              {assets.length > 1 && <ChoiceGroup items={assets} value={asset} onChange={setPick} label={t('asset')} />}
              <div className="plo-chart" role="img" aria-label={`${t('volume')} · ${asset} · ${days}`}>
                {points.map((point) => (
                  <div className="plo-chart-slot" key={point.day} title={`${point.day}: ${portalAmount(point.volume, asset)} ${asset}`}>
                    <span style={{ height: `${point.pct}%` }} />
                  </div>
                ))}
              </div>
              <div className="plo-chart-axis">
                <span>{points[0]?.day}</span>
                <span>{points.at(-1)?.day}</span>
              </div>
              <AsOf freshness={series.freshness} />
              <Button variant="ghost" aria-expanded={table} onClick={() => setTable(!table)}>
                {t(table ? 'hideTable' : 'table')}
              </Button>
              {table && (
                <DataTable label={`${t('volume')} ${asset}`} headers={[t('day'), `${t('amount')} (${asset})`]}>
                  {points.map((point) => (
                    <tr key={point.day}>
                      <td>{point.day}</td>
                      <td>
                        <Money value={point.volume} asset={asset} />
                      </td>
                    </tr>
                  ))}
                </DataTable>
              )}
            </>
          );
        }}
      </Gate>
    </section>
  );
}
