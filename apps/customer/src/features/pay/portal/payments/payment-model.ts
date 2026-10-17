import { formatAmount, parseAmount } from '../../../../shared/money';
import type { MetricPreset, Payment } from '../schemas';

export type PeriodKey = 'today' | '7d' | '30d';
export const PERIODS: readonly PeriodKey[] = ['today', '7d', '30d'];
export const PRESET: Record<PeriodKey, MetricPreset> = { today: 'today', '7d': 'rolling_7d', '30d': 'rolling_30d' };

/**
 * The window the totals above a list cover. It follows the list's date filter when that is Today, 7 days or 30 days;
 * otherwise the totals are for the last 30 days and the page says the list is wider.
 */
export function totalsPeriod(date: string): { period: PeriodKey; matchesList: boolean } {
  return PERIODS.includes(date as PeriodKey) ? { period: date as PeriodKey, matchesList: true } : { period: '30d', matchesList: false };
}

export type RuleWords = 'standard' | 'tier' | 'merchant';
const LAYER: Record<string, RuleWords> = { global: 'standard', tier: 'tier', merchant: 'merchant' };

export type FeeSummary =
  | { kind: 'none' }
  | { kind: 'fee'; fee: string; net: string | null; assetId: string }
  | {
      kind: 'rule';
      fee: string;
      net: string | null;
      assetId: string;
      layer: RuleWords;
      percent: string;
      flatFee: string | null;
    };

/** Basis points as a percentage, exactly: 150 is "1.5". */
export function percentOf(bps: number): string {
  const whole = Math.floor(bps / 100);
  const frac = String(bps % 100)
    .padStart(2, '0')
    .replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : String(whole);
}

/**
 * The fee as it was stored when it was decided, never recomputed. Net is the stored fee taken off what was captured,
 * shown only when the payment was captured in the same asset the fee is in. A payment with no stored fee says so.
 */
export function feeSummary(payment: Pick<Payment, 'assetId' | 'capturedAmount' | 'pricingSnapshot'>): FeeSummary {
  const snap = payment.pricingSnapshot;
  if (!snap) return { kind: 'none' };
  const captured = parseAmount(payment.capturedAmount);
  const fee = parseAmount(snap.fee);
  const sameAsset = !('assetCode' in snap) || snap.assetCode === payment.assetId;
  const net = captured > 0n && sameAsset && captured >= fee ? formatAmount(captured - fee) : null;
  if ('ruleId' in snap) {
    return {
      kind: 'rule',
      fee: snap.fee,
      net,
      assetId: snap.assetCode,
      layer: LAYER[snap.appliedLayer] ?? 'standard',
      percent: percentOf(snap.feeBps),
      flatFee: snap.flatFee && parseAmount(snap.flatFee) > 0n ? snap.flatFee : null,
    };
  }
  return { kind: 'fee', fee: snap.fee, net, assetId: payment.assetId };
}

/** Show Refund only when something captured is still unrefunded. */
export function canRefund(payment: Pick<Payment, 'status' | 'capturedAmount' | 'refundedAmount'>): boolean {
  if (payment.status === 'failed' || payment.status === 'created' || payment.status === 'authorized') return false;
  return parseAmount(payment.capturedAmount) - parseAmount(payment.refundedAmount) > 0n;
}
