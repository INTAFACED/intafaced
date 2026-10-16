import { createContext, useContext, useState } from 'react';
import { Amount, Button } from '@intafaced/ui';
import { fmtAmount } from '../../../data/format';
import { displayAmount, parseAmount } from '../../../shared/money';
import { layoutCopy } from './home-layout/copy';
import type { Payment } from './schemas';

/** Full precision is an explicit choice in a detail, statement or review, never the headline default. */
export const ExactMoneyContext = createContext(false);
export function portalAmount(value: string, asset: string): string {
  const places = asset === 'USD' || asset === 'USDT' ? 2 : 8;
  const scaled = parseAmount(value);
  const abs = scaled < 0n ? -scaled : scaled;
  // Match Home's bigint formatter; preserve the fact that dust is nonzero without a long decimal headline.
  if (abs > 0n && abs < 10n ** BigInt(18 - places)) return `${scaled < 0n ? '−' : ''}<${places === 2 ? '0.01' : '0.00000001'}`;
  return fmtAmount(value, { places, fixed: places === 2 });
}
export function MoneyDisplay({
  value,
  asset,
  className,
  sensitive = false,
}: {
  value: string;
  asset: string;
  className?: string;
  sensitive?: boolean;
}) {
  const canShowExact = useContext(ExactMoneyContext);
  const [exact, setExact] = useState(false);
  const { t } = layoutCopy.useCopy();
  const compact = portalAmount(value, asset);
  const full = displayAmount(value);
  const hasExtraPrecision = /[1-9]/.test((value.split('.')[1] ?? '').slice(asset === 'USD' || asset === 'USDT' ? 2 : 8));
  return (
    <span className="plo-money-exact">
      <Amount className={className} value={exact && canShowExact ? full : compact} sensitive={sensitive} />
      {canShowExact && hasExtraPrecision && (
        <Button variant="ghost" aria-pressed={exact} onClick={() => setExact(!exact)}>
          {t(exact ? 'hideExact' : 'showExact')}
        </Button>
      )}
    </span>
  );
}
export function paymentLabel(payment: Pick<Payment, 'id' | 'customerRef' | 'description'>): string {
  return (
    payment.customerRef?.trim() ||
    payment.description?.trim() ||
    layoutCopy.t('paymentReference', { id: payment.id.split('-')[0]!.slice(0, 8) })
  );
}
