import { useResource, type Resource } from '../../../../shared/resource';
import { PayTime, PaySection } from '../../components';
import { reason } from '../chrome/copy';
import { AsOf, NotLive, Facts, Kpi, KpiGrid, Money, NotConfigured, PortalFailure, PortalLoading, TestTag, UsageBar } from '../components';
import { portalCopy } from './copy';
import { capKinds, type ControlProfile, type MerchantRecord, type Usage } from '../schemas';
import { closestToLimit, freshnessAt, limitRows, type LimitRow } from './model';
import { useReadAt } from '../hooks';
import type { PortalApi } from '../api';

/** `/pay/limits`: your tier and how much of each limit is used, with when it resets. */
export function Limits({ portal, merchantId, merchant }: { portal: PortalApi; merchantId: string; merchant: MerchantRecord | null }) {
  const control = useResource((s) => portal.control(merchantId, s), `portal:control:${merchantId}`);
  const usage = useResource((s) => portal.usage(merchantId, s), `portal:usage:${merchantId}`);
  const readAt = useReadAt(usage.resource.status === 'ready', usage.resource);
  return (
    <LimitsView
      control={control.resource}
      usage={usage.resource}
      now={readAt ? Date.parse(readAt) : Date.now()}
      testValues={merchant === null || merchant.kybStatus !== 'approved'}
      retry={() => {
        control.reload();
        usage.reload();
      }}
    />
  );
}

export function LimitsView({
  control,
  usage,
  now,
  testValues,
  retry,
}: {
  control: Resource<ControlProfile>;
  usage: Resource<Usage>;
  now: number;
  testValues: boolean;
  retry: () => void;
}) {
  const { t } = portalCopy.useCopy();
  if (control.status === 'loading' || usage.status === 'loading') return <PortalLoading rows={4} />;
  // If both reads are refused there is nothing to show; if only one is, show the other and say what is missing.
  if (control.status === 'failed' && usage.status === 'failed') return <PortalFailure result={control.failure} retry={retry} />;
  const profile = control.status === 'ready' ? control.data : null;
  const use = usage.status === 'ready' ? usage.data : null;
  const rows = limitRows(use, profile);
  const configured = rows.filter((r) => r.configured);
  const tier = profile?.tierId ?? use?.tierId ?? null;
  const close = closestToLimit(rows);
  const nextReset = rows
    .map((r) => r.resetsAt)
    .filter((x): x is string => x !== null)
    .sort()[0];
  return (
    <div className="stack">
      <PaySection title={t('limitsKpiTitle')} description={t('limitsKpiBody')}>
        {use && <AsOf freshness={freshnessAt(use.asOf, now)} />}
        {testValues && (
          <p className="pp-callout" role="note">
            <TestTag /> {t('testValuesNote')}
          </p>
        )}
        <KpiGrid label={t('limitsKpiTitle')}>
          <Kpi
            label={t('colTier')}
            value={tier ? <span className="pp-mono">{tier}</span> : <NotConfigured>{t('tierNotAssigned')}</NotConfigured>}
          />
          <Kpi label={t('kpiLimitsSet')} value={`${configured.length} / ${capKinds.length}`} note={t('kpiLimitsSetNote')} />
          <Kpi
            label={t('kpiClosest')}
            value={close ? `${Math.round(close.pct!)}%` : '—'}
            note={close ? t(`limitKind_${close.kind}` as 'limitKind_daily_intake') : t('kpiClosestNone')}
            tone={close && close.pct! >= 100 ? 'attention' : undefined}
          />
          <Kpi label={t('kpiNextReset')} value={nextReset ? <PayTime value={nextReset} /> : '—'} />
        </KpiGrid>
      </PaySection>

      <PaySection title={t('usageTitle')} description={t('usageBody')}>
        {usage.status === 'failed' && <PortalFailure result={usage.failure} retry={retry} />}
        {control.status === 'failed' && <PortalFailure result={control.failure} retry={retry} />}
        {configured.length === 0 && use !== null && (
          <div className="pp-callout pp-callout--warn" role="note">
            <NotConfigured /> {t('limitsNotConfiguredBody')}
          </div>
        )}
        <ul className="pp-limits" aria-label={t('usageTitle')}>
          {rows.map((row, i) => (
            <LimitItem key={`${row.kind}:${row.assetCode ?? ''}:${i}`} row={row} testValues={testValues} />
          ))}
        </ul>
        <p className="muted pp-note">{t('usageHow')}</p>
      </PaySection>

      <NotLive reason={reason('reasonLimits')} title={t('tierLadderSoonTitle')}>
        {t('tierLadderSoonBody')}
      </NotLive>
      <NotLive reason={reason('reasonLimits')} title={t('increaseSoonTitle')}>
        {t('increaseSoonBody')}
      </NotLive>
    </div>
  );
}

function LimitItem({ row, testValues }: { row: LimitRow; testValues: boolean }) {
  const { t } = portalCopy.useCopy();
  const kind = t(`limitKind_${row.kind}` as 'limitKind_daily_intake');
  const countCap = row.kind === 'beneficiaries_per_day';
  return (
    <li className="pp-limit">
      <div className="pp-limit-head">
        <h3>{row.assetCode ? `${kind} (${row.assetCode})` : kind}</h3>
        {testValues && row.configured && <TestTag />}
      </div>
      <p className="muted pp-note">{t(`limitKindBody_${row.kind}` as 'limitKindBody_daily_intake')}</p>
      {!row.configured || row.limit === null ? (
        <p>
          <NotConfigured />
        </p>
      ) : (
        <>
          {row.pct !== null && <UsageBar pct={row.pct} label={kind} />}
          <Facts
            items={[
              [t('capLimit'), countCap ? row.limit : <Money value={row.limit} asset={row.assetCode ?? ''} />],
              ...(row.used !== null
                ? ([
                    [t('capUsed'), countCap ? row.used : <Money value={row.used} asset={row.assetCode ?? ''} />],
                    [
                      t('capRemaining'),
                      row.remaining === null ? '—' : countCap ? row.remaining : <Money value={row.remaining} asset={row.assetCode ?? ''} />,
                    ],
                    [t('capResets'), row.resetsAt ? <PayTime value={row.resetsAt} /> : '—'],
                  ] as const)
                : ([[t('capUsed'), <span className="muted">{t('capNoUsage')}</span>]] as const)),
            ]}
          />
        </>
      )}
    </li>
  );
}
