import { deskCopy } from './copy';
import { fmtAmount, fmtPct, fmtPrice } from './deps';
import type { DeskMarket } from './market';
import { placesOf } from './text';

/**
 * What this pair allows, as published (J-cex-spot-04 step 2): the price and amount steps, the smallest order, the
 * price band and the open-order cap. A value the owner has not published reads "Not published", never a default.
 * One list, shown in the chart's Info tab and folded on the order ticket.
 */
export function MarketRulesList({ market }: { market: DeskMarket }) {
  const { t } = deskCopy.useCopy();
  const none = t('Rule not published');
  const amount = (value: string | null) => (value ? `${fmtAmount(value, { places: placesOf(market.lotSize) })} ${market.base}` : none);
  const rows: Array<[string, string]> = [
    [t('Price step'), `${fmtPrice(market.tickSize, market.tickSize)} ${market.quote}`],
    [t('Amount step'), amount(market.lotSize)],
    [t('Smallest amount'), amount(market.minAmount)],
    [t('Smallest order value'), market.minCost ? `${fmtAmount(market.minCost, { places: 8 })} ${market.quote}` : none],
    [t('Rule price band'), market.band ? t('Rule price band value', { pct: fmtPct(market.band, { signed: false, places: 0 }) }) : none],
    [t('Rule open orders'), market.openOrderCap ? t('Rule open orders value', { cap: market.openOrderCap }) : none],
  ];
  return (
    <dl aria-label={t('Market rules')}>
      {rows.map(([name, value]) => (
        <div key={name}>
          <dt>{name}</dt>
          <dd className="if-num">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The same list on the order ticket, folded under one line so it never pushes the form down. */
export function TicketRules({ market }: { market: DeskMarket }) {
  const { t } = deskCopy.useCopy();
  return (
    <details data-testid="dk-rules" className="dk-rules">
      <summary className="dk-rules-summary">{t('Ticket rules', { pair: market.symbol })}</summary>
      <MarketRulesList market={market} />
    </details>
  );
}
