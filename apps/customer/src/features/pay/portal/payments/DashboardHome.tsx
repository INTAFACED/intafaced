import { useState, type ReactNode } from 'react';
import { ArrowDownLeft, ArrowUpRight, Link2, Undo2 } from 'lucide-react';
import { Button } from '@intafaced/ui/lit';
import { Bars, Disclosure, SectionTabs } from '@intafaced/ui/lit/templates';
import { useResource, type Resource } from '../../../../shared/resource';
import type { PortalApi } from '../api';
import { DashboardInsights, type DashboardData } from './Dashboard';
import {
  AsOf,
  Chip,
  Empty,
  Gate,
  Grid,
  HaltNotice,
  HeroFigure,
  LinkButton,
  MoneyAction,
  MoneyLines,
  MoneyText,
  ReadAt,
  Section,
  haltShows,
} from '../volt/parts';
import { OverviewRoom, type OverviewFrame } from '../volt/OverviewRoom';
import { useReadAt } from '../hooks';
import { bars } from '../model';
import { largestAsset, seriesAssets } from './model';
import type { MemberRole, MerchantRecord, MetricPreset, Payment, Series, Snapshot } from '../schemas';
import { layoutCopy as c, portalCopy } from './copy';
import { paymentLabel } from '../presentation';
import { TierUsage } from './TierUsage';
import { RefundsIssuedValue } from './RefundsIssued';
import { HomePanels } from './HomePanels';
import { dateRange } from '../ui/FilterRow';
import { DateTime, useDayText } from '../ui/DateTime';

export function LayoutDashboard({
  portal,
  merchantId,
  merchant,
  role,
  data,
  retry,
  todayDay,
  frame,
}: {
  portal: PortalApi;
  merchantId: string;
  merchant: MerchantRecord | null;
  role: MemberRole | null;
  data: DashboardData;
  retry: () => void;
  todayDay: string;
  frame: OverviewFrame;
}) {
  const halts = useResource((s) => portal.haltStatus(merchantId, s), `portal:home-halts:${merchantId}`);
  return (
    <LayoutDashboardView
      frame={frame}
      merchant={merchant}
      role={role}
      data={data}
      retry={retry}
      todayDay={todayDay}
      halts={
        haltShows(halts.resource, ['intake', 'payout']) ? <HaltNotice resource={halts.resource} scopes={['intake', 'payout']} /> : undefined
      }
      activity={role === 'owner' ? <RecentPayments portal={portal} merchantId={merchantId} /> : null}
      tier={<TierUsage portal={portal} merchantId={merchantId} />}
      issued={(when) => <RefundsIssuedValue portal={portal} merchantId={merchantId} when={WHEN[when]} />}
      panels={<HomePanels portal={portal} merchantId={merchantId} merchant={merchant} role={role} />}
    />
  );
}

/**
 * `/pay/merchant` on the overview template: the balance is the hero, the owner's money actions the actions, a pause the
 * needs-you slot; the period figures, pending settlement and the folding volume and insights are the sections; recent
 * payments, the account and the three home panels sit beside them.
 */
export function LayoutDashboardView({
  frame,
  merchant,
  role,
  data,
  retry,
  todayDay,
  halts,
  activity,
  tier,
  issued,
  panels,
}: {
  frame: OverviewFrame;
  merchant: MerchantRecord | null;
  role: MemberRole | null;
  data: DashboardData;
  retry: () => void;
  todayDay: string;
  halts?: ReactNode;
  activity?: ReactNode;
  tier?: ReactNode;
  /** Refunds made in the period, worked out from the refunds list. Left out when no list is wired (tests, quiet accounts). */
  issued?: (when: MetricPreset) => ReactNode;
  panels?: ReactNode;
}) {
  const { t } = c.useCopy();
  const [pickedAsset, setAsset] = useState('');
  const [period, setPeriod] = useState<MetricPreset>('today');
  const dayText = useDayText();
  const labels = { today: `${t('today')}: ${dayText(todayDay)}`, rolling_7d: t('week'), rolling_30d: t('month') };
  const actions =
    role === 'owner' ? (
      <nav data-testid="plo-actions" className="lt-actions" aria-label={t('available')}>
        <LinkButton href="/pay/links/new" tone="primary">
          <Link2 size={16} aria-hidden="true" />
          {t('createLink')}
        </LinkButton>
        <MoneyAction kind="payout">
          <LinkButton href="/pay/payouts?view=tools">
            <ArrowUpRight size={16} aria-hidden="true" />
            {t('payOut')}
          </LinkButton>
        </MoneyAction>
        <MoneyAction kind="refund">
          <LinkButton href="/pay/refunds/new">
            <Undo2 size={16} aria-hidden="true" />
            {t('refund')}
          </LinkButton>
        </MoneyAction>
      </nav>
    ) : undefined;
  const hero = (
    <section aria-label={t('available')}>
      <p className="lt-hint">{t('available')}</p>
      <Gate resource={data.today} retry={retry} rows={2}>
        {(snap) => {
          const shown = snap.balances.some((b) => b.assetCode === pickedAsset) ? pickedAsset : snap.balances[0]?.assetCode;
          const balance = snap.balances.find((b) => b.assetCode === shown);
          return (
            <>
              {snap.balances.length > 1 && (
                <SectionTabs
                  label={t('balanceAsset')}
                  value={shown!}
                  onChange={setAsset}
                  items={snap.balances.map((b) => ({ value: b.assetCode, label: b.assetCode }))}
                />
              )}
              {balance ? (
                <HeroFigure testId="plo-balance-amount" value={balance.available} asset={balance.assetCode} />
              ) : (
                <Empty title={t('noBalance')}>{t('noBalanceBody')}</Empty>
              )}
              <AsOf freshness={snap.freshness} />
            </>
          );
        }}
      </Gate>
    </section>
  );
  const account = (
    <Section
      title={t('account')}
      action={
        <a className="lt-link" href="/pay/settings">
          <ArrowUpRight size={18} aria-label={t('settings')} />
        </a>
      }
    >
      <p className="lt-actions">
        {merchant && (
          <>
            <Chip kind="merchant" value={merchant.status} />
            <Chip kind="kyb" value={merchant.kybStatus} />
          </>
        )}
        {role && <span>{portalCopy.t(`role_${role}` as 'role_owner')}</span>}
      </p>
      {tier}
      {merchant && (merchant.status !== 'active' || merchant.kybStatus !== 'approved') && (
        <a className="lt-link" href="/pay/onboarding">
          {t('setup')} →
        </a>
      )}
    </Section>
  );
  const pending = (
    <Section
      title={t('pending')}
      action={
        <a className="lt-link" href="/pay/settlements">
          {t('viewAll')} →
        </a>
      }
    >
      <Gate resource={data.today} retry={retry} rows={1}>
        {(snap) => (
          <>
            <ul className="lt-lines">
              {snap.balances.map((b) => (
                <li key={b.assetCode}>
                  <MoneyText value={b.clearing} asset={b.assetCode} />
                </li>
              ))}
            </ul>
            <AsOf freshness={snap.freshness} />
          </>
        )}
      </Gate>
    </Section>
  );
  const metrics = (
    <section aria-label={t('period')}>
      <h2>{t('payments')}</h2>
      <SectionTabs
        items={(['today', 'rolling_7d', 'rolling_30d'] as const).map((value) => ({ value, label: labels[value] }))}
        value={period}
        onChange={setPeriod}
        label={t('period')}
      />
      <Gate resource={data[period]} retry={retry} rows={1}>
        {(snap) => (
          <>
            <MetricStrip
              snap={snap}
              period={period === 'today' ? t('today') : labels[period]}
              key={period}
              when={period}
              {...(issued ? { issued: issued(period) } : {})}
            />
            <AsOf freshness={snap.freshness} />
          </>
        )}
      </Gate>
    </section>
  );
  const chart = <VolumeChart resource={data.series} retry={retry} todayDay={todayDay} />;
  return (
    <OverviewRoom
      frame={frame}
      hero={hero}
      actions={actions}
      needsYou={halts}
      sections={
        <>
          {metrics}
          {pending}
          <Disclosure
            defaultOpen={['volume']}
            items={[
              { value: 'volume', title: t('volume'), body: chart },
              {
                value: 'insights',
                title: t('insights'),
                body: <DashboardInsights data={data} retry={retry} {...(issued ? { issued } : {})} />,
              },
            ]}
          />
        </>
      }
      watching={
        <>
          {activity ? <section>{activity}</section> : null}
          {account}
          {panels}
        </>
      }
    />
  );
}

const WHEN = { today: 'today', rolling_7d: '7d', rolling_30d: '30d' } as const;
/** Each tile names its period and opens the list with that same period and filter in the address. */
export function MetricStrip({ snap, period, when, issued }: { snap: Snapshot; period: string; when: MetricPreset; issued?: ReactNode }) {
  const { t } = c.useCopy();
  const key = WHEN[when];
  const range = dateRange(key, Date.now());
  const refunds = `/pay/refunds?${new URLSearchParams({ ...(range.from ? { from: range.from } : {}), ...(range.to ? { to: range.to } : {}) })}`;
  const payments = (status?: string) => `/pay/payments?${new URLSearchParams({ ...(status ? { status } : {}), date: key })}`;
  return (
    <div data-testid="plo-kpi-strip" className="lt-kv">
      {[
        [t('captured'), <MoneyLines items={snap.captured} />, payments()],
        [t('count'), snap.paymentCount, payments()],
        [t('kpiRefunded'), <MoneyLines items={snap.refunded} />, refunds, t('kpiRefundedNote')],
        ...(issued ? [[t('refundsIssuedLabel'), issued, refunds, t('refundsIssuedNote')]] : []),
        [t('net'), <MoneyLines items={snap.net} />, '/pay/money'],
      ].map(([label, value, href, note], index) => (
        <a key={index} className="lt-row-link" href={href as string} {...(note ? { title: note as string } : {})}>
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
      <h2>{t('recent')}</h2>
      <p className="lt-actions">
        <a className="lt-link" href="/pay/payments">
          {t('viewAll')} →
        </a>
      </p>
      <Gate resource={resource} retry={retry} rows={4}>
        {(rows) =>
          rows.length ? (
            <>
              <ul className="lt-rows">
                {rows.map((payment) => (
                  <li key={payment.id}>
                    <a className="lt-row-link" href={`/pay/payments/${encodeURIComponent(payment.id)}`}>
                      <ArrowDownLeft size={18} aria-hidden="true" />
                      <span>
                        <strong>{paymentLabel(payment)}</strong>{' '}
                        <span>
                          <Chip kind="payment" value={payment.status} /> · <DateTime value={payment.createdAt} />
                        </span>
                      </span>{' '}
                      <MoneyText value={payment.amount} asset={payment.assetId} />
                    </a>
                  </li>
                ))}
              </ul>
              <ReadAt at={at} />
            </>
          ) : (
            <Empty
              title={t('noPayments')}
              action={
                <a className="lt-link" href="/pay/links/new">
                  {t('createLink')}
                </a>
              }
            >
              {t('noPaymentsBody')}
            </Empty>
          )
        }
      </Gate>
    </>
  );
}
function VolumeChart({ resource, retry, todayDay }: { resource: Resource<Series>; retry: () => void; todayDay: string }) {
  const { t } = c.useCopy();
  const dayText = useDayText();
  const [days, setDays] = useState<'1' | '7' | '30'>('30');
  const [pick, setPick] = useState('');
  const [table, setTable] = useState(false);
  const dayLabels = { '1': t('today'), '7': t('week'), '30': t('month') };
  return (
    <section data-testid="plo-volume">
      <SectionTabs
        items={(['1', '7', '30'] as const).map((value) => ({ value, label: dayLabels[value] }))}
        value={days}
        onChange={setDays}
        label={t('period')}
      />
      <Gate resource={resource} retry={retry} rows={4}>
        {(series) => {
          const assets = seriesAssets(series);
          const asset = assets.includes(pick) ? pick : largestAsset(series);
          if (!asset)
            return (
              <>
                <AsOf freshness={series.freshness} />
                <Empty title={t('noSeries')}>{t('noPaymentsBody')}</Empty>
              </>
            );
          const points = bars(series, asset, Number(days), todayDay);
          return (
            <>
              <p className="lt-hint">
                {t('volumeBody')} · {asset}
              </p>
              {assets.length > 1 && (
                <SectionTabs label={t('asset')} value={asset} onChange={setPick} items={assets.map((a) => ({ value: a, label: a }))} />
              )}
              <Bars
                label={`${t('volume')} · ${asset} · ${days}`}
                asset={asset}
                bars={points.map((point) => ({ label: dayText(point.day), value: point.volume }))}
              />
              <p className="lt-actions">
                <span>{points[0] ? dayText(points[0].day) : null}</span>
                <span>{points.length ? dayText(points[points.length - 1]!.day) : null}</span>
              </p>
              <AsOf freshness={series.freshness} />
              <Button tone="quiet" aria-expanded={table} onClick={() => setTable(!table)}>
                {t(table ? 'hideTable' : 'table')}
              </Button>
              {table && (
                <Grid label={`${t('volume')} ${asset}`} headers={[t('day'), `${t('amount')} (${asset})`]}>
                  {points.map((point) => (
                    <tr key={point.day}>
                      <td>{dayText(point.day)}</td>
                      <td>
                        <MoneyText value={point.volume} asset={asset} />
                      </td>
                    </tr>
                  ))}
                </Grid>
              )}
            </>
          );
        }}
      </Gate>
    </section>
  );
}
