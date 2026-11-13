import type { VenueMarket } from '../../../features/trade/venue-api';
import { spotVenueCopy } from './venue-copy';
import { bpsAsPercent } from './venue-desk';

/**
 * What this market allows, as the venue publishes it (J-cex-spot-04 #2): the price and amount steps, the smallest order
 * value, the price band, the open-order cap and the largest order, with the venue named. A rule the venue does not
 * publish reads "Not published by <venue>", never a default of ours. Folded on the ticket so it never pushes the form down.
 */
export function VenueMarketRules({ market, venueName }: { market: VenueMarket; venueName: string }) {
  const { t } = spotVenueCopy.useCopy();
  const none = t('Not published by', { venue: venueName });
  const largest =
    market.maxOrderQty && market.maxOrderNotional
      ? t('Rule largest value', {
          qty: market.maxOrderQty,
          base: market.baseAsset,
          notional: market.maxOrderNotional,
          quote: market.quoteAsset,
        })
      : market.maxOrderQty
        ? t('Rule largest qty', { qty: market.maxOrderQty, base: market.baseAsset })
        : market.maxOrderNotional
          ? t('Rule largest notional', { notional: market.maxOrderNotional, quote: market.quoteAsset })
          : none;
  const rows: Array<[string, string, string]> = [
    ['tick', t('Rule tick'), t('Rule step value', { step: market.tickSize, asset: market.quoteAsset })],
    ['lot', t('Rule lot'), t('Rule step value', { step: market.lotSize, asset: market.baseAsset })],
    [
      'min',
      t('Rule min'),
      market.minOrderNotional ? t('Rule min value', { min: market.minOrderNotional, quote: market.quoteAsset }) : none,
    ],
    ['band', t('Rule band'), market.priceBandBps ? t('Rule band value', { percent: bpsAsPercent(market.priceBandBps) }) : none],
    ['cap', t('Rule cap'), market.maxOpenOrders ? t('Rule cap value', { count: String(market.maxOpenOrders) }) : none],
    ['largest', t('Rule largest'), largest],
  ];
  return (
    <details data-testid="venue-rules" className="dk-rules dk-panel" open>
      <summary className="dk-rules-summary">{t('Rules title')}</summary>
      <p className="dk-note-small" data-testid="venue-rules-source">
        {t('Rules source', { venue: venueName })}
      </p>
      <dl aria-label={t('Rules title')}>
        {rows.map(([rule, name, value]) => (
          <div key={rule} data-rule={rule}>
            <dt>{name}</dt>
            <dd className="if-num">{value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
