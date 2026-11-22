// volt-room: /pay/analytics
// volt-room: portal:analytics
import { Bars as KitBars } from '@intafaced/ui/lit/templates';
import { useDayText } from '../../ui/DateTime';
import { Empty, EntityList, Failure, Freshness, KpiStrip, Loading, MoneyText, Section } from '../../volt/parts';
import { MonitorRoom } from '../../volt/MonitorRoom';
import { isNotLive } from '../../refusal';
import { useResource, type Resource } from '../../../../../shared/resource';
import type { ApiResult } from '../../../../../shared/api';
import type { SettingsBApi } from '../b-client';
import { analyticsCopy as c } from './copy';
import { Declines } from './Declines';
import { AnalyticsControls, useAnalyticsState, type AnalyticsState } from './Controls';
import { assetsOf, busiest, periodsWithSales, readAll, sumByAsset, totalCount, type Point } from './model';

type Loaded = {
  points: Point[];
  complete: boolean;
  freshness: { asOf: string | null; lagSeconds: number | null };
  source: 'analytics' | 'daily';
};

/** `/pay/analytics` on the monitor template: the business's captured volume and its declines, for the account the access resolved. */
export function AnalyticsRoom({ api, test }: { api: SettingsBApi; test: boolean }) {
  return <MonitorRoom>{({ merchantId }) => ({ panels: <Analytics api={api} merchantId={merchantId} test={test} /> })}</MonitorRoom>;
}

/** Captured volume over time: today, 7 or 30 days, or your own dates; by day or week; for one asset or all of them. */
function Analytics({
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
  return (
    <div className="lt-stack">
      <AnalyticsView state={state} resource={w ? data.resource : null} reload={data.reload} test={test} />
      <Declines api={api} merchantId={merchantId} state={state} test={test} />
    </div>
  );
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
    <div className="lt-stack">
      <AnalyticsControls state={state} assets={assets} />
      {!resource ? (
        <p className="lt-hint" role="status">
          {t('pickDates')}
        </p>
      ) : resource.status === 'loading' ? (
        <Loading rows={4} />
      ) : resource.status === 'failed' ? (
        <Failure result={resource.failure} retry={reload} />
      ) : (
        <VolumeBody data={resource.data} state={state} test={test} />
      )}
    </div>
  );
}

function VolumeBody({ data, state, test }: { data: Loaded; state: AnalyticsState; test: boolean }) {
  const { t } = c.useCopy();
  const dayText = useDayText();
  const { points } = data;
  if (points.length === 0)
    return (
      <>
        <Freshness asOf={data.freshness.asOf} lagSeconds={data.freshness.lagSeconds ?? 0} />
        <Empty title={t('emptyTitle')}>{t('emptyBody')}</Empty>
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
        <p className="lt-held" role="status">
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
              <span className="lt-stack">
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
            value: best ? dayText(best.period) : '—',
            ...(best ? { note: t('capturesCount', { n: best.count }) } : {}),
          },
          { label: t('tileActive'), period, href: link('payments'), value: open ? periodsWithSales(points) : '—' },
        ]}
      />
      {assetsOf(points).map((asset) => (
        <Section key={asset} title={t('chartTitle', { asset })} description={t(state.bucket === 'week' ? 'chartWeekly' : 'chartDaily')}>
          <Bars points={points} asset={asset} />
        </Section>
      ))}
      <Section title={t('tableTitle')} description={t('tableBody')}>
        <EntityList
          label={t('tableTitle')}
          rows={points}
          rowKey={(p) => `${p.period}:${p.assetCode}`}
          columns={[
            {
              header: state.bucket === 'week' ? t('colWeek') : t('colDay'),
              cell: (p) => (state.bucket === 'week' ? t('weekOf', { date: dayText(p.period) }) : dayText(p.period)),
            },
            { header: t('colAsset'), cell: (p) => p.assetCode },
            { header: t('colCaptured'), cell: (p) => <MoneyText value={p.volume} asset={p.assetCode} test={test} /> },
            { header: t('colPayments'), cell: (p) => (p.count === null ? '—' : p.count) },
          ]}
        />
        {data.source === 'daily' && <p className="lt-hint">{t('dailyOnly')}</p>}
      </Section>
    </>
  );
}

/**
 * One bar per period, the kit's bar chart, oldest first. The table below holds every exact amount; this is a picture of
 * it, and the chart carries the same amounts as its own text equivalent.
 */
export function Bars({ points, asset }: { points: readonly Point[]; asset: string }) {
  const { t } = c.useCopy();
  const dayText = useDayText();
  const rows = points.filter((p) => p.assetCode === asset).sort((a, b) => a.period.localeCompare(b.period));
  const first = rows[0];
  const last = rows[rows.length - 1];
  return (
    <div className="lt-stack">
      <KitBars
        label={t('chartAlt', {
          asset,
          n: rows.length,
          from: first ? dayText(first.period) : '',
          to: last ? dayText(last.period) : '',
        })}
        bars={rows.map((p) => ({ label: dayText(p.period), value: p.volume }))}
        asset={asset}
      />
      <p className="lt-hint">{first && last ? `${dayText(first.period)} – ${dayText(last.period)}` : ''}</p>
    </div>
  );
}
