import { fmtAmount, fmtPct } from '../../../data/format';
import { LoadGate } from './HistoryTab';
import { useMarginSummary } from './data';
import type { MarginSummary } from './api';
import { metricsCopy } from './metrics-copy';

type T = ReturnType<typeof metricsCopy.useCopy>['t'];

/** Why a figure is blank, in words. The haircut belongs to buying power, which this panel doesn't show. */
export function waitingFor(summary: MarginSummary, t: T): string | null {
  const known: Record<string, string> = {
    available: t('Missing available'),
    usedMargin: t('Missing usedMargin'),
    maintenanceMargin: t('Missing maintenanceMargin'),
    initialMargin: t('Missing initialMargin'),
    collateral: t('Missing collateral'),
    unrealizedPnl: t('Missing unrealizedPnl'),
  };
  const words = [...new Set(summary.missing.filter((m) => m.code === 'missing_input').map((m) => known[m.field] ?? t('Missing other')))];
  return words.length ? t('Metrics waiting', { fields: words.join('; ') }) : null;
}

/**
 * Account metrics (D-margin-04): equity, available, used margin, maintenance margin and margin ratio, each read from the
 * service's margin summary and shown to its last digit. Nothing here is summed in the browser.
 */
export function AccountMetrics({ asset }: { asset: string }) {
  const { t } = metricsCopy.useCopy();
  const summary = useMarginSummary(asset);
  return (
    <section aria-label={t('Metrics heading')} className="flex flex-col gap-2 border-t border-line px-4 py-3">
      <h2 className="text-sm font-medium text-fg">{t('Metrics heading')}</h2>
      <LoadGate load={summary} thing={t('Metrics thing')}>
        {(s) => {
          // A figure is drawn only in the asset the service named; with no asset named there is nothing to draw it in.
          const money = (v: string | null) =>
            v === null || s.asset === null ? fmtAmount(null) : `${fmtAmount(v, { places: 18 })} ${s.asset}`;
          const flat = s.positions === 0;
          const rows: [string, string, string, string][] = [
            ['equity', t('Metrics equity'), t('Metrics equity hint'), money(s.equity)],
            ['available', t('Metrics available'), t('Metrics available hint'), money(s.available)],
            ['used', t('Metrics used'), t('Metrics used hint'), money(s.usedMargin)],
            ['maintenance', t('Metrics maintenance'), t('Metrics maintenance hint'), money(s.totalMaintenanceMargin)],
            ['ratio', t('Metrics ratio'), t('Metrics ratio hint'), fmtPct(s.marginRatio, { places: 16, signed: false })],
          ];
          const waiting = waitingFor(s, t);
          return (
            <>
              <dl className="grid grid-cols-1 gap-x-6 gap-y-3 md:grid-cols-2 xl:grid-cols-5">
                {rows.map(([id, label, hint, value]) => (
                  <div key={id} className="flex min-w-0 flex-col gap-0.5">
                    <dt className="text-xs text-fg-2" title={hint}>
                      {label}
                    </dt>
                    <dd data-testid={`metric-${id}`} className="if-num break-all text-sm text-fg">
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
              <p className="text-xs text-fg-2">{flat ? t('Metrics no positions') : t('Metrics exact')}</p>
              {waiting ? (
                <p role="status" className="text-xs text-warn">
                  {waiting}
                </p>
              ) : null}
            </>
          );
        }}
      </LoadGate>
    </section>
  );
}
