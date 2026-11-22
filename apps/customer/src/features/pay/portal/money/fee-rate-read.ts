import { useResource } from '../../../../shared/resource';
import type { PortalApi } from '../api';
import type { mc } from './copy';
import type { EffectiveRate } from './fee-rate-schema';

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
