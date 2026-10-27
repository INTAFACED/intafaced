import type { Offer, Trade } from '../schemas';
import { settlementCopy } from './settlement-copy';

/** A settlement window in the largest whole unit (days, then hours), else minutes rounded up. */
export function windowParts(seconds: number): { unit: 'day' | 'days' | 'hour' | 'hours' | 'minutes'; count: number } {
  if (seconds % 86_400 === 0) return seconds === 86_400 ? { unit: 'day', count: 1 } : { unit: 'days', count: seconds / 86_400 };
  if (seconds % 3_600 === 0) return seconds === 3_600 ? { unit: 'hour', count: 1 } : { unit: 'hours', count: seconds / 3_600 };
  return { unit: 'minutes', count: Math.ceil(seconds / 60) };
}

function useWindowText() {
  const { t } = settlementCopy.useCopy();
  return (seconds: number) => {
    const { unit, count } = windowParts(seconds);
    return t(unit, { count: String(count) });
  };
}

/**
 * What an ad says about its non-instant methods (P-disputes-security-09): one line per method with the longest window
 * any market sets, and the seller's consent. Nothing for an ad whose methods are all instant.
 */
export function OfferSettlement({ offer, label }: { offer: Offer; label: (methodId: string) => string }) {
  const { t } = settlementCopy.useCopy();
  const windowText = useWindowText();
  const slow = offer.nonInstantMethods ?? [];
  if (slow.length === 0) return null;
  return (
    <span className="stack" data-testid="offer-settlement">
      {slow.map((entry) => (
        <span key={entry.methodId} className="muted">
          {entry.windowSeconds === null
            ? t('nonInstantBlank', { method: label(entry.methodId) })
            : t('nonInstant', { method: label(entry.methodId), window: windowText(entry.windowSeconds) })}
        </span>
      ))}
      {offer.acceptsNonInstant ? <span className="muted">{t('consent')}</span> : null}
    </span>
  );
}

/** The take form's notice for the chosen method, when it is not instant. */
export function TakeSettlementNotice({ offer, method }: { offer: Offer; method: string }) {
  const { t } = settlementCopy.useCopy();
  const windowText = useWindowText();
  const entry = (offer.nonInstantMethods ?? []).find((item) => item.methodId === method.toLowerCase());
  if (!entry) return null;
  return (
    <p className="muted" role="note" data-testid="take-settlement">
      {entry.windowSeconds === null ? t('takeNoticeBlank') : t('takeNotice', { window: windowText(entry.windowSeconds) })}
    </p>
  );
}

/** The order's own profile, copied at take: nothing for an instant method or a read without it. */
export function OrderSettlement({ trade }: { trade: Trade }) {
  const { t } = settlementCopy.useCopy();
  const windowText = useWindowText();
  const settlement = trade.settlement;
  if (!settlement || settlement.instant) return null;
  return (
    <p className="muted" data-testid="order-settlement">
      {settlement.windowSeconds === null ? t('orderBlank') : t('order', { window: windowText(settlement.windowSeconds) })}
    </p>
  );
}
