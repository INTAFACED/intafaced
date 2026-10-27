import { createContext, useContext, useState } from 'react';
import { Amount, Button } from '@intafaced/ui';
import { layoutCopy } from './home-layout/copy';
import type { Payment } from './schemas';
import { useExactMoneyScope } from './ui/ExactMoneyScope';
import { formatMoney, isRounded } from './ui/format';

/** Full precision is an explicit choice in a detail, statement or review, never the headline default. */
export const ExactMoneyContext = createContext(false);
/** The portal's one money formatter (ui/format.ts), kept under this name for the pages that already import it. */
export function portalAmount(value: string, asset: string): string {
  return formatMoney(value, asset);
}
export function MoneyDisplay({
  value,
  asset,
  className,
  sensitive = false,
  unit,
  unitClassName = 'pp-unit',
  testId,
}: {
  value: string;
  asset: string;
  className?: string;
  sensitive?: boolean;
  /** The asset code to show right after the amount, so "Show exact" sits after both and never between them. */
  unit?: string;
  unitClassName?: string;
  /** A test id for the amount itself. */
  testId?: string;
}) {
  const canShowExact = useContext(ExactMoneyContext);
  const inReview = useExactMoneyScope();
  const [exact, setExact] = useState(false);
  const { t } = layoutCopy.useCopy();
  const compact = portalAmount(value, asset);
  const full = formatMoney(value, asset, { exact: true });
  // In a review the exact amount is the default and needs no toggle. In a detail view the compact amount keeps a "Show exact" button.
  const unitText = unit ? (
    <span className={unitClassName} lang="zxx">
      {unit}
    </span>
  ) : null;
  if (inReview)
    return (
      <>
        <Amount data-testid={testId} className={className} value={full} sensitive={sensitive} />
        {unitText && <> {unitText}</>}
        {isRounded(value, asset) && <span className="pp-exact-tag"> ({t('exactTag')})</span>}
      </>
    );
  const hasExtraPrecision = isRounded(value, asset);
  return (
    <span className="plo-money-exact">
      <Amount data-testid={testId} className={className} value={exact && canShowExact ? full : compact} sensitive={sensitive} />
      {unitText}
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
