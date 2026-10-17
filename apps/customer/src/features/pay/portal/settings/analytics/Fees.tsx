import { EmptyState } from '../../../ui-kit';
import { PaySection } from '../../../components';
import { NotLiveCard } from '../../chrome/NotLiveCard';
import { reason } from '../../chrome/copy';
import { PortalFailure, PortalLoading } from '../../components';
import { EntityList } from '../../ui/EntityList';
import { EffectiveFeeRates } from '../../ui/FeeRate';
import { Freshness } from '../../ui/Freshness';
import { KpiStrip } from '../../ui/Kpi';
import { MoneyText } from '../../ui/MoneyText';
import { isNotLive, notLiveReason } from '../../refusal';
import { useResource, type Resource } from '../../../../../shared/resource';
import type { ApiResult } from '../../../../../shared/api';
import type { SettingsBApi } from '../b-client';
import { analyticsCopy as c } from './copy';
import { AnalyticsControls, useAnalyticsState, type AnalyticsState } from './Controls';
import { assetsOf, feeTotals, readAll } from './model';
import type { FeePoint } from './schemas';

type Loaded = {
  points: FeePoint[];
  complete: boolean;
  freshness: { asOf: string | null; lagSeconds: number | null };
  effectiveRate: unknown;
  conversionCost: unknown;
};

/** What your payments cost: gross, fees taken, net and refunds, by day or week. The rate is shown only when INTAFACED has stored it. */
export function Fees({
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
  const key = `analytics:fees:${merchantId}:${w?.from}:${w?.to}:${state.bucket}:${state.asset}`;
  const data = useResource<Loaded>(async (signal) => {
    if (!w) return { ok: false, reason: 'error', message: '', code: 'portal.local' } as ApiResult<Loaded>;
    const q = { merchantId, from: w.from, to: w.to, bucket: state.bucket, ...(state.asset ? { assetId: state.asset } : {}) };
    let rate: unknown = null;
    let conversion: unknown = null;
    const read = await readAll((cursor) =>
      api.analyticsFees(q, cursor, signal).then((r) => {
        if (r.ok) {
          rate = r.data.effectiveRate ?? null;
          conversion = r.data.conversionCost ?? null;
        }
        return r;
      }),
    );
    if (!read.ok) return read;
    return {
      ok: true,
      data: {
        points: read.data.items,
        complete: read.data.complete,
        freshness: read.data.freshness,
        effectiveRate: rate,
        conversionCost: conversion,
      },
    };
  }, key);
  return <FeesView state={state} resource={w ? data.resource : null} reload={data.reload} test={test} />;
}

export function FeesView({
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
  return (
    <div className="stack">
      <AnalyticsControls state={state} assets={loaded ? assetsOf(loaded.points) : []} />
      {!resource ? (
        <p className="muted" role="status">
          {t('pickDates')}
        </p>
      ) : resource.status === 'loading' ? (
        <PortalLoading rows={4} />
      ) : resource.status === 'failed' ? (
        isNotLive(resource.failure) ? (
          <NotLiveCard variant="page" reason={notLiveReason(resource.failure)} title={t('feesOffTitle')} needs="merchantAnalytics.fees">
            {t('feesOffBody')}
          </NotLiveCard>
        ) : (
          <PortalFailure result={resource.failure} retry={reload} />
        )
      ) : (
        <FeesBody data={resource.data} state={state} test={test} />
      )}
    </div>
  );
}

function FeesBody({ data, state, test }: { data: Loaded; state: AnalyticsState; test: boolean }) {
  const { t } = c.useCopy();
  const { points } = data;
  if (points.length === 0)
    return (
      <>
        <Freshness asOf={data.freshness.asOf} lagSeconds={data.freshness.lagSeconds ?? 0} />
        <EmptyState title={t('feesEmptyTitle')}>{t('feesEmptyBody')}</EmptyState>
      </>
    );
  const totals = feeTotals(points);
  const period = state.preset === 'custom' ? t('yourDates') : t(`period_${state.preset}`);
  const filter = state.window
    ? `date=custom&from=${state.window.from.slice(0, 10)}&to=${new Date(Date.parse(state.window.to) - 1).toISOString().slice(0, 10)}`
    : '';
  const href = `/pay/settlements?${filter}${state.asset ? `&asset=${encodeURIComponent(state.asset)}` : ''}`;
  const lines = (rows: Array<{ assetCode: string; total: string }>) => (
    <span className="pp-stack">
      {rows.map((r) => (
        <MoneyText key={r.assetCode} value={r.total} asset={r.assetCode} test={test} />
      ))}
    </span>
  );
  const open = data.complete;
  const rate = typeof data.effectiveRate === 'string' || typeof data.effectiveRate === 'number' ? String(data.effectiveRate) : null;
  return (
    <>
      <Freshness asOf={data.freshness.asOf} lagSeconds={data.freshness.lagSeconds ?? 0} />
      {!open && (
        <p className="pp-callout" role="status">
          {t('cutShort')}
        </p>
      )}
      <KpiStrip
        label={t('feesTitle')}
        tiles={[
          { label: t('tileGross'), period, href, value: open ? lines(totals.gross) : '—' },
          { label: t('tileFees'), period, href, value: open ? lines(totals.fees) : '—' },
          { label: t('tileNet'), period, href, value: open ? lines(totals.net) : '—' },
          { label: t('tileRefunded'), period, href, value: open ? lines(totals.refunded) : '—' },
        ]}
      />
      <PaySection title={t('rateTitle')}>
        {rate ? (
          <p>{t('rateIs', { rate })}</p>
        ) : open ? (
          <EffectiveFeeRates gross={totals.gross} fees={totals.fees} />
        ) : (
          <NotLiveCard reason={reason('reasonDetail')} title={t('rateOffTitle')} needs="fee rule snapshots aggregated">
            {t('rateOffBody')}
          </NotLiveCard>
        )}
      </PaySection>
      <PaySection title={t('feesTableTitle')} description={t('feesTableBody')}>
        <EntityList
          label={t('feesTableTitle')}
          rows={points}
          rowKey={(p) => `${p.period}:${p.assetCode}`}
          columns={[
            { header: state.bucket === 'week' ? t('colWeek') : t('colDay'), cell: (p) => p.period },
            { header: t('colAsset'), cell: (p) => p.assetCode },
            { header: t('tileGross'), cell: (p) => <MoneyText value={p.gross} asset={p.assetCode} test={test} /> },
            { header: t('tileFees'), cell: (p) => <MoneyText value={p.fees} asset={p.assetCode} test={test} /> },
            { header: t('tileNet'), cell: (p) => <MoneyText value={p.net} asset={p.assetCode} test={test} /> },
            { header: t('tileRefunded'), cell: (p) => <MoneyText value={p.refunded} asset={p.assetCode} test={test} /> },
          ]}
          card={(p) => ({
            title: state.bucket === 'week' ? t('weekOf', { date: p.period }) : p.period,
            time: t('feesOf', { asset: p.assetCode }),
            amount: <MoneyText value={p.fees} asset={p.assetCode} test={test} />,
          })}
        />
      </PaySection>
    </>
  );
}
