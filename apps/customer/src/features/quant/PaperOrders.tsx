import { ordersCopy } from './orders-copy';

export interface PaperOrderEvent {
  readonly seq: number;
  readonly order: string;
  readonly kind: string;
  readonly type: string;
  readonly side: string;
  readonly symbol: string;
  readonly qty: string;
  readonly tif: string;
  readonly market: string;
  readonly limit?: string | undefined;
  readonly price?: string | undefined;
  readonly reason?: string | undefined;
  readonly notional?: string | undefined;
  readonly fee?: string | undefined;
  readonly cash?: string | undefined;
  readonly position?: string | undefined;
  readonly reserved?: string | undefined;
}

export interface PaperReverseLeg {
  readonly leg: string;
  readonly side: string;
  readonly symbol: string;
  readonly qty: string;
  readonly checked: boolean;
  readonly outcome: string;
  readonly order: string;
  readonly reason: string | null;
}

/** A paper run's order events, its reversal legs and the TEST price path its resting limits met (AL-orders-01..03). */
export function PaperOrders({
  events,
  legs,
  ticks,
}: {
  events: readonly PaperOrderEvent[];
  legs: readonly PaperReverseLeg[];
  ticks: { label: 'TEST'; path: Readonly<Record<string, readonly string[]>> };
}) {
  const { t } = ordersCopy.useCopy();
  const reasonText = (reason: string) => (reason === 'no short rule' ? t('noShortRule') : reason);
  return (
    <>
      <h3>{t('eventsTitle')}</h3>
      <p className="muted">{t('eventsNote')}</p>
      {events.length === 0 ? (
        <p className="muted">{t('eventsNone')}</p>
      ) : (
        <ol data-testid="quant-order-events">
          {events.map((e) => (
            <li
              key={e.seq}
              data-testid="quant-order-event"
              data-order={e.order}
              data-kind={e.kind}
              data-type={e.type}
              data-side={e.side}
              data-qty={e.qty}
              data-market={e.market}
              data-limit={e.limit}
              data-price={e.price}
              data-reason={e.reason}
              data-notional={e.notional}
              data-fee={e.fee}
              data-cash={e.cash}
              lang="und"
            >
              {t('event', { order: e.order, kind: e.kind, side: e.side, qty: e.qty, symbol: e.symbol, type: e.type, market: e.market })}
              {e.limit !== undefined && t('eventLimit', { limit: e.limit })}
              {e.price !== undefined && t('eventPrice', { price: e.price })}
              {e.kind === 'filled' && e.fee !== undefined && t('eventFee', { fee: e.fee })}
              {e.reason !== undefined && t('eventReason', { reason: e.reason })}
              {e.notional !== undefined && t('eventCash', { notional: e.notional, fee: e.fee ?? '', cash: e.cash ?? '' })}
              {e.position !== undefined && t('eventPosition', { position: e.position, reserved: e.reserved ?? '0' })}
            </li>
          ))}
        </ol>
      )}
      {legs.length > 0 && (
        <>
          <h3>{t('legsTitle')}</h3>
          <ol>
            {legs.map((leg) => (
              <li
                key={leg.order}
                data-testid="quant-reverse-leg"
                data-leg={leg.leg}
                data-qty={leg.qty}
                data-checked={String(leg.checked)}
                data-outcome={leg.outcome}
                lang="und"
              >
                {t('leg', { leg: leg.leg, side: leg.side, qty: leg.qty, symbol: leg.symbol, outcome: leg.outcome })}
                {leg.reason !== null && t('legReason', { reason: reasonText(leg.reason) })}
              </li>
            ))}
          </ol>
        </>
      )}
      <h3>{t('ticksTitle')}</h3>
      <p className="muted">{t('ticksNote')}</p>
      <ul data-testid="quant-paper-ticks" data-label={ticks.label}>
        {Object.entries(ticks.path).map(([symbol, path]) => (
          <li key={symbol} lang="zxx">
            {t('ticks', { symbol, path: path.join(' → ') })}
          </li>
        ))}
      </ul>
    </>
  );
}
