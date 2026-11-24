// volt-room: /pay/analytics/fees
// volt-room: portal:analytics-fees
import type { ReactNode } from 'react';
import { KeyValue } from '@intafaced/ui/lit/templates';
import { reason } from '../../chrome/copy';
import { rateText } from '../../money/fee-rate-read';
import type { EffectiveRate } from '../../money/fee-rate-schema';
import { mc as moneyCopy } from '../../money/copy';
import { uiCopy } from '../../ui/copy';
import { useDayText } from '../../ui/DateTime';
import { effectiveFeeRate } from '../../ui/format';
import { Empty, EntityList, Failure, Freshness, KpiStrip, Loading, MoneyText, NotLive, Section } from '../../volt/parts';
import { MonitorRoom } from '../../volt/MonitorRoom';
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
  /** The service's own rate per asset over the whole window; undefined on an older service. */
  rates?: EffectiveRate[];
  conversionCost: unknown;
};

/** `/pay/analytics/fees` on the monitor template: what the business's payments cost, for the account the access resolved. */
export function FeesRoom({ api, test }: { api: SettingsBApi; test: boolean }) {
  return <MonitorRoom>{({ merchantId }) => ({ panels: <Fees api={api} merchantId={merchantId} test={test} /> })}</MonitorRoom>;
}

/** What your payments cost: gross, fees taken, net and refunds, by day or week. The rate is shown only when INTAFACED has stored it. */
function Fees({
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
    let rates: EffectiveRate[] | undefined;
    let conversion: unknown = null;
    const read = await readAll((cursor) =>
      api.analyticsFees(q, cursor, signal).then((r) => {
        if (r.ok) {
          rate = r.data.effectiveRate ?? null;
          rates ??= r.data.rates;
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
        rates,
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
    <div className="lt-stack">
      <AnalyticsControls state={state} assets={loaded ? assetsOf(loaded.points) : []} />
      {!resource ? (
        <p className="lt-hint" role="status">
          {t('pickDates')}
        </p>
      ) : resource.status === 'loading' ? (
        <Loading rows={4} />
      ) : resource.status === 'failed' ? (
        isNotLive(resource.failure) ? (
          <NotLive reason={notLiveReason(resource.failure)} title={t('feesOffTitle')} needs="merchantAnalytics.fees">
            {t('feesOffBody')}
          </NotLive>
        ) : (
          <Failure result={resource.failure} retry={reload} />
        )
      ) : (
        <FeesBody data={resource.data} state={state} test={test} />
      )}
    </div>
  );
}

function FeesBody({ data, state, test }: { data: Loaded; state: AnalyticsState; test: boolean }) {
  const { t } = c.useCopy();
  const { t: mt } = moneyCopy.useCopy();
  const dayText = useDayText();
  const { points } = data;
  if (points.length === 0)
    return (
      <>
        <Freshness asOf={data.freshness.asOf} lagSeconds={data.freshness.lagSeconds ?? 0} />
        <Empty title={t('feesEmptyTitle')}>{t('feesEmptyBody')}</Empty>
      </>
    );
  const totals = feeTotals(points);
  const period = state.preset === 'custom' ? t('yourDates') : t(`period_${state.preset}`);
  const filter = state.window
    ? `date=custom&from=${state.window.from.slice(0, 10)}&to=${new Date(Date.parse(state.window.to) - 1).toISOString().slice(0, 10)}`
    : '';
  const href = `/pay/settlements?${filter}${state.asset ? `&asset=${encodeURIComponent(state.asset)}` : ''}`;
  const lines = (rows: Array<{ assetCode: string; total: string }>) => (
    <span className="lt-stack">
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
        <p className="lt-held" role="status">
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
      <Section title={t('rateTitle')}>
        {data.rates ? (
          <EffectiveRatesList rates={data.rates}>
            <p className="lt-hint">{mt('rateWindowShown')}</p>
          </EffectiveRatesList>
        ) : rate ? (
          <p>{t('rateIs', { rate })}</p>
        ) : open ? (
          <EffectiveFeeRates gross={totals.gross} fees={totals.fees} />
        ) : (
          <NotLive reason={reason('reasonDetail')} title={t('rateOffTitle')} needs="fee rule snapshots aggregated">
            {t('rateOffBody')}
          </NotLive>
        )}
      </Section>
      <Section title={t('feesTableTitle')} description={t('feesTableBody')}>
        <EntityList
          label={t('feesTableTitle')}
          rows={points}
          rowKey={(p) => `${p.period}:${p.assetCode}`}
          columns={[
            {
              header: state.bucket === 'week' ? t('colWeek') : t('colDay'),
              cell: (p) => (state.bucket === 'week' ? t('weekOf', { date: dayText(p.period) }) : dayText(p.period)),
            },
            { header: t('colAsset'), cell: (p) => p.assetCode },
            { header: t('tileGross'), cell: (p) => <MoneyText value={p.gross} asset={p.assetCode} test={test} /> },
            { header: t('tileFees'), cell: (p) => <MoneyText value={p.fees} asset={p.assetCode} test={test} /> },
            { header: t('tileNet'), cell: (p) => <MoneyText value={p.net} asset={p.assetCode} test={test} /> },
            { header: t('tileRefunded'), cell: (p) => <MoneyText value={p.refunded} asset={p.assetCode} test={test} /> },
          ]}
        />
      </Section>
    </>
  );
}

/** The rates the service sent, one line per asset (`EffectiveRatesList` in `../../money/fee-rate`, drawn with the kit). */
function EffectiveRatesList({ rates, children }: { rates: readonly EffectiveRate[]; children?: ReactNode }) {
  const { t } = moneyCopy.useCopy();
  if (rates.length === 0) return <p className="lt-hint">{t('rateNone')}</p>;
  return (
    <div className="lt-stack">
      <KeyValue label={t('rateListLabel')} rows={rates.map((r) => ({ label: r.assetCode, value: rateText(t, r), ltr: true }))} />
      {children}
    </div>
  );
}

/**
 * The effective fee rate per asset: fees taken ÷ gross, exact decimal math, never a mix of assets (`EffectiveFeeRates` in
 * the portal's old fee-rate part, drawn with the kit). Both lists come from reads the page already made.
 */
function EffectiveFeeRates({
  gross,
  fees,
}: {
  gross: readonly { assetCode: string; total: string }[];
  fees: readonly { assetCode: string; total: string }[];
}) {
  const { t } = uiCopy.useCopy();
  return (
    <div className="lt-stack">
      <KeyValue
        label={t('rateLabel')}
        rows={gross.map((g) => {
          const rate = effectiveFeeRate(fees.find((f) => f.assetCode === g.assetCode)?.total ?? '0', g.total);
          return { label: g.assetCode, value: rate ?? '—', note: rate === null ? t('rateNone') : undefined };
        })}
      />
      <p className="lt-hint">{t('rateHow')}</p>
    </div>
  );
}
