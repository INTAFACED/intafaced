import { CoinIcon } from './deps';
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
}: {
  view: MoneyView;
  copy: Copy;
  refreshMs: number;
  timeZone: Preferences['timeZone'];
}) {
  const { t } = copy;
  return (
    <section id="valuation" data-testid="money-card" className="money-card" aria-labelledby="money-valuation-title">
      <header data-testid="money-card__head" className="money-card__head">
        <h2 id="money-valuation-title">{t('How these values are worked out')}</h2>
      </header>
      <p className="money-card__note" data-testid="valuation-time">
        {view.source === 'server'
          ? t('Valued at {time}, refreshed every {seconds} seconds', {
              time: clockTime(view.asOf, timeZone),
              seconds: String(refreshMs / 1000),
            })
          : t('Valued on this device at {time}', { time: clockTime(view.asOf, timeZone) })}
      </p>
      <p className="money-card__note">{t('Stable coins rule')}</p>
      <table data-testid="money-table" className="money-table money-valuation">
        <thead>
          <tr>
            <th scope="col">{t('Coin')}</th>
            <th scope="col">{t('Priced by')}</th>
            <th scope="col" className="money-num">
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
                  <span className="money-coin">
                    <CoinIcon asset={row.asset} size={24} />
                    <span className="money-coin__ticker">{row.asset}</span>
                  </span>
                </td>
                <td data-col="source">{source}</td>
                <td className="money-num" data-col="price">
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
