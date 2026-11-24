import { AssetIcon } from '@intafaced/ui/lit';
import { moneyCopy } from './copy';
import type { MoneyView } from './portfolio-source';
import { fmtCoinPrice, marketName } from './price-text';
import { clockTime } from './time';
import type { Preferences } from '../../shared/preferences';

type Copy = ReturnType<typeof moneyCopy.useCopy>;

/**
 * How each value on the page was worked out (PF-overview-01, portfolio-overview-008): the market and price that valued
 * each coin, when, how often the page asks again, that dollar coins count as exactly one dollar, and which coins were
 * left out and why. Every figure is the valuation's own; nothing here is worked out again.
 */
export function ValuationNote({
  view,
  copy,
  refreshMs,
  timeZone,
  priceSourceNote,
}: {
  view: MoneyView;
  copy: Copy;
  refreshMs: number;
  timeZone: Preferences['timeZone'];
  /** Optional line naming the published price list and venue behind the prices (launch model). */
  priceSourceNote?: string;
}) {
  const { t } = copy;
  return (
    <section id="valuation" data-testid="money-card" className="lt-stack" aria-labelledby="money-valuation-title">
      <header data-testid="money-card__head" className="lt-title-row">
        <h2 id="money-valuation-title">{t('How these values are worked out')}</h2>
      </header>
      <p className="lt-hint" data-testid="valuation-time">
        {view.source === 'server'
          ? t('Valued at {time}, refreshed every {seconds} seconds', {
              time: clockTime(view.asOf, timeZone),
              seconds: String(refreshMs / 1000),
            })
          : t('Valued on this device at {time}', { time: clockTime(view.asOf, timeZone) })}
      </p>
      {priceSourceNote ? (
        <p className="lt-hint" data-testid="valuation-source">
          {priceSourceNote}
        </p>
      ) : null}
      <p className="lt-hint">{t('Stable coins rule')}</p>
      <table data-testid="money-table" className="lt-table">
        <thead>
          <tr>
            <th scope="col">{t('Coin')}</th>
            <th scope="col">{t('Priced by')}</th>
            <th scope="col" data-align="end">
              {t('Price')}
            </th>
          </tr>
        </thead>
        <tbody>
          {view.rows.map((row) => {
            const reason = view.unpricedReasons[row.asset];
            const source =
              row.usdValue === null
                ? reason === 'no_price_yet'
                  ? t('Not counted: market has no last price')
                  : reason === 'no_market'
                    ? t('Not counted: no dollar market')
                    : t('Not counted: no price')
                : row.class === 'cash'
                  ? t('Counted at exactly $1')
                  : row.priceSymbol
                    ? t('Last trade on {market}', { market: marketName(row.priceSymbol) })
                    : t('Last trade price');
            return (
              <tr key={row.asset} data-coin={row.asset}>
                <td>
                  <span className="lt-actions">
                    <AssetIcon asset={row.asset} size="sm" />
                    <span>{row.asset}</span>
                  </span>
                </td>
                <td data-col="source" data-label={t('Priced by')}>
                  {source}
                </td>
                <td data-align="end" data-col="price" data-label={t('Price')}>
                  {row.usdValue === null ? t('Not counted') : row.priceUsd === null ? '—' : fmtCoinPrice(row.priceUsd)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
