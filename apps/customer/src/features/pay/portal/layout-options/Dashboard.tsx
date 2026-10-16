import { useState, type ReactNode } from 'react';
import { ArrowDownLeft, ArrowUpRight, Link2, Undo2 } from 'lucide-react';
import { Amount, Button, ChoiceGroup, DataTable, EmptyState } from '@intafaced/ui';
import { useResource, type Resource } from '../../../../shared/resource';
import { displayAmount } from '../../../../shared/money';
import type { PortalApi } from '../api';
import type { DashboardData } from '../Dashboard';
import { AsOf, Chip, Gate, HaltBanner, Money, MoneyLines, ReadAt } from '../components';
import { useReadAt } from '../hooks';
import { bars, seriesAssets, shortId } from '../model';
import type { MemberRole, MerchantRecord, MetricPreset, Payment, Series, Snapshot } from '../schemas';
import { layoutCopy as c } from './copy';
import { layoutHref, type PortalLayout } from './layout';

export function LayoutDashboard({
  layout,
  portal,
  merchantId,
  merchant,
  role,
  data,
  retry,
  todayDay,
}: {
  layout: PortalLayout;
  portal: PortalApi;
  merchantId: string;
  merchant: MerchantRecord | null;
  role: MemberRole | null;
  data: DashboardData;
  retry: () => void;
  todayDay: string;
}) {
  const halts = useResource((s) => portal.haltStatus(merchantId, s), `portal:option-halts:${merchantId}`);
  return (
    <>
      <HaltBanner resource={halts.resource} scopes={['intake', 'payout']} />
      <LayoutDashboardView
        layout={layout}
        merchant={merchant}
        role={role}
        data={data}
        retry={retry}
        todayDay={todayDay}
        activity={role === 'owner' ? <RecentPayments portal={portal} merchantId={merchantId} layout={layout} /> : null}
      />
    </>
  );
}
export function LayoutDashboardView({
  layout,
  merchant,
  role,
  data,
  retry,
  todayDay,
  activity,
}: {
  layout: PortalLayout;
  merchant: MerchantRecord | null;
  role: MemberRole | null;
  data: DashboardData;
  retry: () => void;
  todayDay: string;
  activity: ReactNode;
}) {
  const { t } = c.useCopy();
  const [period, setPeriod] = useState<MetricPreset>('today');
  const labels = { today: t('today'), rolling_7d: t('week'), rolling_30d: t('month') };
  const actions =
    role === 'owner' ? (
      <nav className="plo-actions" aria-label={t('available')}>
        <Button variant="primary" nativeButton={false} role="link" render={<a href={layoutHref('/pay/links/new', layout)} />}>
          <Link2 size={16} aria-hidden="true" />
          {t('createLink')}
        </Button>
        <Button variant="secondary" nativeButton={false} role="link" render={<a href={layoutHref('/pay/payouts?view=tools', layout)} />}>
          <ArrowUpRight size={16} aria-hidden="true" />
          {t('payOut')}
        </Button>
        <Button variant="secondary" nativeButton={false} role="link" render={<a href={layoutHref('/pay/refunds/new', layout)} />}>
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
            {snap.balances.length ? (
              snap.balances.map((balance) => (
                <div className="plo-balance-asset" key={balance.assetCode}>
                  <Amount className="plo-number" value={displayAmount(balance.available)} />
                  <span className="plo-unit">{balance.assetCode}</span>
                </div>
              ))
            ) : (
              <EmptyState title={t('noBalance')}>{t('noBalanceBody')}</EmptyState>
            )}
            <p className="plo-change">{t('changeUnavailable')}</p>
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
        <a href={layoutHref('/pay/settings', layout)}>
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
        {role && <span>{role}</span>}
      </div>
      <p>{t('tierSoon')}</p>
      {merchant && (merchant.status !== 'active' || merchant.kybStatus !== 'approved') && (
        <a href={layoutHref('/pay/onboarding', layout)}>{t('setup')} →</a>
      )}
    </section>
  );
  const pending = (
    <section className="plo-card">
      <div className="plo-section-head">
        <h2>{t('pending')}</h2>
        <a href={layoutHref('/pay/settlements', layout)}>{t('viewAll')} →</a>
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
            <MetricStrip snap={snap} layout={layout} period={labels[period]} />
            <AsOf freshness={snap.freshness} />
          </>
        )}
      </Gate>
    </section>
  );
  const chart = <VolumeChart resource={data.series} retry={retry} todayDay={todayDay} />;
  if (layout === 'a')
    return (
      <div className="plo-home-grid">
        <div className="plo-main">
          {hero}
          {metrics}
          {pending}
          <details className="plo-card plo-disclosure">
            <summary>{t('volume')}</summary>
            {chart}
          </details>
        </div>
        <aside className="plo-rail">
          <section className="plo-card">{activity}</section>
          {account}
        </aside>
      </div>
    );
  if (layout === 'b')
    return (
      <div className="plo-centered">
        {hero}
        <section className="plo-feed">{activity}</section>
        <details className="plo-disclosure">
          <summary>{t('payments')}</summary>
          {metrics}
          {chart}
        </details>
        <details className="plo-disclosure">
          <summary>{t('moneyOut')}</summary>
          {pending}
        </details>
        <details className="plo-disclosure">
          <summary>{t('account')}</summary>
          {account}
        </details>
      </div>
    );
  return (
    <div className="plo-trading">
      {hero}
      {chart}
      {metrics}
      <nav className="plo-activity-tabs" aria-label={t('activity')}>
        {(['payments', 'payouts', 'disputes'] as const).map((key, index) => (
          <a key={key} href={layoutHref(`/pay/${key}`, layout)} aria-current={index === 0 ? 'page' : undefined}>
            {t(key)}
          </a>
        ))}
      </nav>
      <section className="plo-feed">{activity}</section>
      <details className="plo-disclosure">
        <summary>{t('account')}</summary>
        {account}
        {pending}
      </details>
    </div>
  );
}
function MetricStrip({ snap, layout, period }: { snap: Snapshot; layout: PortalLayout; period: string }) {
  const { t } = c.useCopy();
  return (
    <div className="plo-kpi-strip">
      {[
        [t('captured'), <MoneyLines items={snap.captured} />],
        [t('count'), snap.paymentCount],
        [t('refunded'), <MoneyLines items={snap.refunded} />],
        [t('net'), <MoneyLines items={snap.net} />],
      ].map(([label, value], index) => (
        <a key={index} href={layoutHref('/pay/payments', layout)}>
          <span>
            {label} · {period}
          </span>
          <strong>{value}</strong>
        </a>
      ))}
    </div>
  );
}
function RecentPayments({ portal, merchantId, layout }: { portal: PortalApi; merchantId: string; layout: PortalLayout }) {
  const list = useResource((s) => portal.payments(merchantId, '', 6, s), `portal:option-recent:${merchantId}`);
  const at = useReadAt(list.resource.status === 'ready', list.resource);
  return <RecentPaymentsView resource={list.resource} layout={layout} retry={list.reload} at={at} />;
}
export function RecentPaymentsView({
  resource,
  layout,
  retry,
  at,
}: {
  resource: Resource<Payment[]>;
  layout: PortalLayout;
  retry: () => void;
  at: string | null;
}) {
  const { t } = c.useCopy();
  return (
    <>
      <div className="plo-section-head">
        <h2>{t(layout === 'a' ? 'recent' : 'activity')}</h2>
        <a href={layoutHref('/pay/payments', layout)}>{t('viewAll')} →</a>
      </div>
      <Gate resource={resource} retry={retry} rows={4}>
        {(rows) =>
          rows.length ? (
            <>
              <ul className="plo-payment-feed">
                {rows.map((payment) => (
                  <li key={payment.id}>
                    <a href={layoutHref(`/pay/payments/${encodeURIComponent(payment.id)}`, layout)}>
                      <span className="plo-payment-icon">
                        <ArrowDownLeft size={18} aria-hidden="true" />
                      </span>
                      <span className="plo-payment-label">
                        <strong>
                          {t('received')} {shortId(payment.id)}
                        </strong>
                        <span>
                          <Chip kind="payment" value={payment.status} /> ·{' '}
                          <time dateTime={payment.createdAt}>
                            {new Date(payment.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' })}
                          </time>
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
            <EmptyState title={t('noPayments')} action={<a href={layoutHref('/pay/links/new', layout)}>{t('createLink')}</a>}>
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
                  <div className="plo-chart-slot" key={point.day} title={`${point.day}: ${displayAmount(point.volume)} ${asset}`}>
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
                      <td>{displayAmount(point.volume)}</td>
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
