import { useResource, type Resource } from '../../../../shared/resource';
import type { ReactNode } from 'react';
import type { PortalApi } from '../api';
import { PortalLoading } from '../components';
import { mc } from './copy';
import type { EffectiveRate } from './fee-rate-schema';

export { effectiveRateSchema, type EffectiveRate } from './fee-rate-schema';

/**
 * A fraction as a percentage, by string arithmetic (never a JS number): "0.015" is "1.50%", "0.015873" is "1.5873%".
 * At least two decimal places, at most the four the service's six-place fraction carries.
 */
export function ratePercent(rate: string): string {
  const [whole = '0', fraction = ''] = rate.split('.');
  const digits = `${whole}${fraction.padEnd(6, '0')}`;
  const integer = digits.slice(0, -4).replace(/^0+(?=\d)/, '') || '0';
  const decimals = digits.slice(-4).replace(/0+$/, '').padEnd(2, '0');
  return `${integer}.${decimals}%`;
}

/** The last 30 whole UTC days, ending after today. Both bounds are required by the service. */
export function rateWindow(now: number): { from: string; to: string } {
  const day = 86_400_000;
  const start = Math.floor(now / day) * day;
  return { from: new Date(start - 29 * day).toISOString(), to: new Date(start + day).toISOString() };
}

/**
 * The rates over the last 30 days, per asset, as INTAFACED worked them out (`merchantAnalytics.fees`). `rates` is null
 * when the service does not send them yet; the caller then keeps whatever it showed before.
 */
export function useEffectiveFeeRates(portal: PortalApi, merchantId: string, now: number = Date.now()) {
  const { from, to } = rateWindow(now);
  return useResource<EffectiveRate[] | null>(
    async (signal) => {
      const read = await portal.feeRates({ merchantId, from, to }, signal);
      return read.ok ? { ok: true as const, data: read.data.rates ?? null } : read;
    },
    `money:fee-rates:${merchantId}:${from.slice(0, 10)}`,
  );
}

/** One asset's rate in words: "1.50% of what customers paid", "1.5873% (rounded down)", or why there is none. */
export function rateText(t: ReturnType<typeof mc.useCopy>['t'], r: EffectiveRate): string {
  if (r.rateStatus === 'no_volume') return t('rateNoVolume');
  if (r.rateStatus === 'refused' || r.rate === null) return t('rateRefused');
  return r.rateStatus === 'exact' ? ratePercent(r.rate) : t('rateRounded', { pct: ratePercent(r.rate) });
}

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
