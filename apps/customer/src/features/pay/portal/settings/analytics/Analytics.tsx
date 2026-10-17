import { useState } from 'react';
import { EmptyState } from '../../../ui-kit';
import { PaySection } from '../../../components';
import { PortalFailure, PortalLoading } from '../../components';
import { Freshness } from '../../ui/Freshness';
import { KpiStrip } from '../../ui/Kpi';
import { MoneyText } from '../../ui/MoneyText';
import { EntityList } from '../../ui/EntityList';
import { isNotLive } from '../../refusal';
import { useResource, type Resource } from '../../../../../shared/resource';
import type { ApiResult } from '../../../../../shared/api';
import type { SettingsBApi } from '../b-client';
import { analyticsCopy as c } from './copy';
import { AnalyticsControls, useAnalyticsState, type AnalyticsState } from './Controls';
import { assetsOf, barsFor, busiest, periodsWithSales, readAll, sumByAsset, totalCount, type Point } from './model';

type Loaded = {
  points: Point[];
  complete: boolean;
  freshness: { asOf: string | null; lagSeconds: number | null };
  source: 'analytics' | 'daily';
};

/** Captured volume over time: today, 7 or 30 days, or your own dates; by day or week; for one asset or all of them. */
export function Analytics({
  api,
  merchantId,
  test = false,
  now = Date.now(),
}: {
  api: SettingsBApi;
  merchantId: string;
  test?: boolean;
  now?: number;
}) {
  const state = useAnalyticsState(now);
  const w = state.window;
  const key = `analytics:volume:${merchantId}:${w?.from}:${w?.to}:${state.bucket}:${state.asset}`;
  const data = useResource<Loaded>(async (signal) => {
    if (!w) return { ok: false, reason: 'error', message: '', code: 'portal.local' } as ApiResult<Loaded>;
    const q = { merchantId, from: w.from, to: w.to, bucket: state.bucket, ...(state.asset ? { assetId: state.asset } : {}) };
    const read = await readAll((cursor) => api.analyticsVolume(q, cursor, signal));
    if (read.ok)
      return {
        ok: true,
        data: { points: read.data.items, complete: read.data.complete, freshness: read.data.freshness, source: 'analytics' },
      };
    // Where the fuller read is not switched on, the daily capture totals the account already has still answer.
    if (!isNotLive(read)) return read;
    const daily = await api.analyticsDailySeries(merchantId, w.from, w.to, signal);
    if (!daily.ok) return daily;
    const points = daily.data.points
      .filter((p) => !state.asset || p.assetCode === state.asset)
      .map((p) => ({ period: p.day, assetCode: p.assetCode, volume: p.volume, count: null }));
    return { ok: true, data: { points, complete: true, freshness: daily.data.freshness, source: 'daily' } };
  }, key);
  return <AnalyticsView state={state} resource={w ? data.resource : null} reload={data.reload} test={test} />;
}

export function AnalyticsView({
  state,
  resource,
  reload,
  test,
}: {
  state: AnalyticsState;
  resource: Resource<Loaded> | null;
  reload: () => void;
  test: boolean;
}) {
  const { t } = c.useCopy();
  const loaded = resource?.status === 'ready' ? resource.data : null;
  const assets = loaded ? assetsOf(loaded.points) : [];
  return (
    <div className="stack">
      <AnalyticsControls state={state} assets={assets} />
      {!resource ? (
        <p className="muted" role="status">
          {t('pickDates')}
        </p>
      ) : resource.status === 'loading' ? (
        <PortalLoading rows={4} />
      ) : resource.status === 'failed' ? (
        <PortalFailure result={resource.failure} retry={reload} />
      ) : (
        <VolumeBody data={resource.data} state={state} test={test} />
      )}
    </div>
  );
}

function VolumeBody({ data, state, test }: { data: Loaded; state: AnalyticsState; test: boolean }) {
  const { t } = c.useCopy();
  const { points } = data;
  if (points.length === 0)
    return (
      <>
        <Freshness asOf={data.freshness.asOf} lagSeconds={data.freshness.lagSeconds ?? 0} />
        <EmptyState title={t('emptyTitle')}>{t('emptyBody')}</EmptyState>
      </>
    );
  const period = state.preset === 'custom' ? t('yourDates') : t(`period_${state.preset}`);
  const sums = sumByAsset(points, (p) => p.volume);
  const count = totalCount(points);
  const best = busiest(points);
  const filter = state.window
    ? `date=custom&from=${state.window.from.slice(0, 10)}&to=${new Date(Date.parse(state.window.to) - 1).toISOString().slice(0, 10)}`
    : '';
  const link = (path: string) => `/pay/${path}?${filter}${state.asset ? `&asset=${encodeURIComponent(state.asset)}` : ''}`;
  const open = data.complete;
  return (
    <>
      <Freshness asOf={data.freshness.asOf} lagSeconds={data.freshness.lagSeconds ?? 0} />
      {!open && (
        <p className="pp-callout" role="status">
          {t('cutShort')}
        </p>
      )}
      <KpiStrip
        label={t('volumeTitle')}
        tiles={[
          {
            label: t('tileVolume'),
            period,
            href: link('payments'),
            value: open ? (
              <span className="pp-stack">
                {sums.map((s) => (
                  <MoneyText key={s.assetCode} value={s.total} asset={s.assetCode} test={test} />
                ))}
              </span>
            ) : (
              '—'
            ),
            note: open ? t('volumeNote') : t('noTotalCut'),
          },
          {
            label: t('tilePayments'),
            period,
            href: link('payments'),
            value: open ? (count ?? '—') : '—',
            ...(count === null ? { note: t('noCountDaily') } : {}),
          },
          {
            label: t('tileBusiest'),
            period,
            href: link('payments'),
            value: best ? best.period : '—',
            ...(best ? { note: t('capturesCount', { n: best.count }) } : {}),
          },
          { label: t('tileActive'), period, href: link('payments'), value: open ? periodsWithSales(points) : '—' },
        ]}
      />
      {assetsOf(points).map((asset) => (
        <PaySection key={asset} title={t('chartTitle', { asset })} description={t(state.bucket === 'week' ? 'chartWeekly' : 'chartDaily')}>
          <Bars points={points} asset={asset} />
        </PaySection>
      ))}
      <PaySection title={t('tableTitle')} description={t('tableBody')}>
        <EntityList
          label={t('tableTitle')}
          rows={points}
          rowKey={(p) => `${p.period}:${p.assetCode}`}
          columns={[
            { header: state.bucket === 'week' ? t('colWeek') : t('colDay'), cell: (p) => p.period },
            { header: t('colAsset'), cell: (p) => p.assetCode },
            { header: t('colCaptured'), cell: (p) => <MoneyText value={p.volume} asset={p.assetCode} test={test} /> },
            { header: t('colPayments'), cell: (p) => (p.count === null ? '—' : p.count) },
          ]}
          card={(p) => ({
            title: state.bucket === 'week' ? t('weekOf', { date: p.period }) : p.period,
            time: p.count === null ? undefined : t('capturesCount', { n: p.count }),
            amount: <MoneyText value={p.volume} asset={p.assetCode} test={test} />,
          })}
        />
        {data.source === 'daily' && <p className="muted">{t('dailyOnly')}</p>}
      </PaySection>
    </>
  );
}

const H = 96;
/** One bar per period, tallest to scale. The table below holds every exact amount; this is a picture of it. */
export function Bars({ points, asset }: { points: readonly Point[]; asset: string }) {
  const { t } = c.useCopy();
  const bars = barsFor(points, asset, H);
  const [hover, setHover] = useState<number | null>(null);
  const w = 100 / Math.max(1, bars.length);
  const first = bars[0];
  const last = bars[bars.length - 1];
  return (
    <figure className="pp-chart">
      <svg
        viewBox={`0 0 100 ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={t('chartAlt', { asset, n: bars.length, from: first?.period ?? '', to: last?.period ?? '' })}
      >
        {bars.map((b, i) => (
          <rect
            key={b.period}
            className="pp-bar"
            x={i * w + w * 0.1}
            width={w * 0.8}
            y={H - b.h}
            height={b.h}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          >
            <title>{`${b.period}: ${b.volume} ${asset}`}</title>
          </rect>
        ))}
      </svg>
      <figcaption className="muted">
        {hover !== null && bars[hover]
          ? `${bars[hover]!.period} · ${bars[hover]!.volume} ${asset}`
          : first && last
            ? `${first.period} – ${last.period}`
            : ''}
      </figcaption>
    </figure>
  );
}
