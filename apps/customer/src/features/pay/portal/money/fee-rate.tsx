import type { Resource } from '../../../../shared/resource';
import type { ReactNode } from 'react';
import type { PortalApi } from '../api';
import { PortalLoading } from '../components';
import { mc } from './copy';
import type { EffectiveRate } from './fee-rate-schema';
import { rateText, useEffectiveFeeRates } from './fee-rate-read';

export { effectiveRateSchema, type EffectiveRate } from './fee-rate-schema';
export { ratePercent, rateText, rateWindow, useEffectiveFeeRates } from './fee-rate-read';

/** The rates the service sent, one line per asset. Two assets are never mixed into one figure. */
export function EffectiveRatesList({ rates, children }: { rates: readonly EffectiveRate[]; children?: ReactNode }) {
  const { t } = mc.useCopy();
  if (rates.length === 0) return <p className="muted">{t('rateNone')}</p>;
  return (
    <div>
      <ul className="pp-lines" style={{ listStyle: 'none', padding: 0, margin: 0 }} aria-label={t('rateListLabel')}>
        {rates.map((r) => (
          <li key={r.assetCode} className="pp-line">
            <strong className="numeric">{rateText(t, r)}</strong>{' '}
            <span className="pp-unit" lang="zxx">
              {r.assetCode}
            </span>
          </li>
        ))}
      </ul>
      {children}
    </div>
  );
}

/**
 * Home's "Your fee" and any other small place: the rates over the last 30 days, or `fallback` while the service does
 * not send them. Loading shows a quiet placeholder; a failed read shows `fallback` too, because the price on the
 * account is still true.
 */
export function YourEffectiveFee({ portal, merchantId, fallback = null }: { portal: PortalApi; merchantId: string; fallback?: ReactNode }) {
  const { t } = mc.useCopy();
  const read = useEffectiveFeeRates(portal, merchantId);
  return <EffectiveFeeView resource={read.resource} fallback={fallback} note={t('rateWindow30')} />;
}

export function EffectiveFeeView({
  resource,
  fallback,
  note,
}: {
  resource: Resource<EffectiveRate[] | null>;
  fallback: ReactNode;
  note: string;
}) {
  if (resource.status === 'loading') return <PortalLoading rows={1} />;
  if (resource.status === 'failed' || resource.data === null) return <>{fallback}</>;
  return (
    <EffectiveRatesList rates={resource.data}>
      <p className="muted pp-note">{note}</p>
    </EffectiveRatesList>
  );
}
