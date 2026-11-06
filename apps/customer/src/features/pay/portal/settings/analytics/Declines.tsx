import { EmptyState } from '../../../ui-kit';
import { PaySection } from '../../../components';
import { NotLiveCard } from '../../chrome/NotLiveCard';
import { PortalFailure, PortalLoading } from '../../components';
import { EntityList } from '../../ui/EntityList';
import { Freshness } from '../../ui/Freshness';
import { KpiStrip } from '../../ui/Kpi';
import { isNotLive, notLiveReason } from '../../refusal';
import { useResource, type Resource } from '../../../../../shared/resource';
import type { ApiResult } from '../../../../../shared/api';
import type { SettingsBApi } from '../b-client';
import { analyticsCopy as c } from './copy';
import type { AnalyticsState } from './Controls';
import type { Declines as DeclinesData } from './schemas';

/**
 * Declines for the chosen period (M-adv-payments-core-02): the rate, the counts behind it and the reasons, all as
 * svc-pay worked them out (merchantAnalytics.declines). The page divides nothing: a rate it was not sent is not shown.
 */
export function Declines({
  api,
  merchantId,
  state,
  test = false,
}: {
  api: SettingsBApi;
  merchantId: string;
  state: AnalyticsState;
  test?: boolean;
}) {
  const w = state.window;
  const key = `analytics:declines:${merchantId}:${w?.from}:${w?.to}:${state.asset}`;
  const data = useResource<DeclinesData>(async (signal) => {
    if (!w) return { ok: false, reason: 'error', message: '', code: 'portal.local' } as ApiResult<DeclinesData>;
    return api.analyticsDeclines({ merchantId, from: w.from, to: w.to, ...(state.asset ? { assetId: state.asset } : {}) }, signal);
  }, key);
  if (!w) return null;
  return <DeclinesView resource={data.resource} reload={data.reload} state={state} test={test} />;
}

export function DeclinesView({
  resource,
  reload,
  state,
  test = false,
}: {
  resource: Resource<DeclinesData>;
  reload: () => void;
  state: AnalyticsState;
  test?: boolean;
}) {
  const { t } = c.useCopy();
  return (
    <PaySection title={t('declinesTitle')} description={t('declinesBody')}>
      {resource.status === 'loading' ? (
        <PortalLoading rows={2} />
      ) : resource.status === 'failed' ? (
        isNotLive(resource.failure) ? (
          <NotLiveCard reason={notLiveReason(resource.failure)} title={t('declinesOffTitle')} needs="merchantAnalytics.declines">
            {t('declinesOffBody')}
          </NotLiveCard>
        ) : (
          <PortalFailure result={resource.failure} retry={reload} />
        )
      ) : (
        <DeclinesBody data={resource.data} state={state} test={test} />
      )}
    </PaySection>
  );
}

function DeclinesBody({ data, state, test }: { data: DeclinesData; state: AnalyticsState; test: boolean }) {
  const { t } = c.useCopy();
  const freshness = <Freshness asOf={data.asOf} lagSeconds={0} />;
  if (data.rateStatus === 'no_payments' || data.rate === null)
    return (
      <>
        {freshness}
        <EmptyState title={t('declinesNone')}>{t('declinesNoneBody')}</EmptyState>
      </>
    );
  const period = state.preset === 'custom' ? t('yourDates') : t(`period_${state.preset}`);
  const window = state.window
    ? `date=custom&from=${state.window.from.slice(0, 10)}&to=${new Date(Date.parse(state.window.to) - 1).toISOString().slice(0, 10)}`
    : '';
  const asset = state.asset ? `&asset=${encodeURIComponent(state.asset)}` : '';
  const failed = `/pay/payments?status=failed&${window}${asset}`;
  const all = `/pay/payments?${window}${asset}`;
  return (
    <>
      {freshness}
      <KpiStrip
        label={t('declinesLabel')}
        tiles={[
          {
            label: t('tileDeclineRate'),
            period,
            href: failed,
            // A business that is not live yet carries the TEST tag on its figures, as its money does.
            value: test ? t('declineRateTest', { rate: data.rate }) : t('declineRateIs', { rate: data.rate }),
            note: data.rateStatus === 'rounded' ? t('declineRateRounded') : t('declineRateNote'),
          },
          { label: t('tileDeclined'), period, href: failed, value: data.declinedCount },
          { label: t('tileSucceeded'), period, href: all, value: data.succeededCount },
          { label: t('tileFinished'), period, href: all, value: data.finishedCount },
        ]}
      />
      {data.reasons.length > 0 && (
        <EntityList
          label={t('declinesReasons')}
          rows={data.reasons}
          rowKey={(r) => r.code}
          columns={[
            { header: t('colReason'), cell: (r) => r.message },
            { header: t('colCode'), cell: (r) => <code lang="und">{r.code}</code> },
            { header: t('colCount'), cell: (r) => r.count },
          ]}
          card={(r) => ({ title: r.message, time: r.code, amount: r.count })}
        />
      )}
    </>
  );
}
