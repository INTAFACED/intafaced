import { assetName, homeCopy } from './copy';
import { priceText, type Favoriting, type Tickers } from './MarketsSection';
import { coinHref, direction, fmtPct, CoinIcon, Pct, Skeleton, Sparkline, type Decimal, type Loadable } from './deps';
import { IN_PANEL } from './panel';
import { StarButton } from './Star';
import type { Listing } from './select';

export function Watchlist({
  items,
  popular,
  tickers,
  sparklines,
  loading,
  favoriting,
}: {
  items: Listing[];
  popular: boolean;
  tickers: Tickers;
  sparklines: Loadable<Record<string, Decimal[]>>;
  loading: boolean;
  favoriting: Favoriting;
}) {
  const copy = homeCopy.useCopy();
  const { t } = copy;
  const points = sparklines.status === 'ready' ? sparklines.data : {};
  return (
    <section data-testid="home-watch" className="home-watch" aria-labelledby="home-watch-title">
      <div data-testid="home-watch__head" className="home-watch__head">
        <h2 id="home-watch-title">{popular ? t('Popular') : t('Watchlist')}</h2>
        {/* No Edit button: the stars on each row edit the watchlist; a markets screen comes in M2 (critic N6). */}
      </div>
      {popular && !loading ? (
        <p data-testid="home-side__empty--hint" className="home-side__empty home-side__empty--hint">
          {t('Watchlist hint')}
        </p>
      ) : null}
      {loading ? (
        <div aria-hidden="true">
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <div data-testid="home-watch__row" className="home-watch__row" key={index}>
              <Skeleton width={28} height={28} circle className={IN_PANEL} />
              <Skeleton width={72} height={36} className={IN_PANEL} />
              <Skeleton width={64} height={24} className={IN_PANEL} />
              <Skeleton width={72} height={36} className={IN_PANEL} />
            </div>
          ))}
        </div>
      ) : (
        <ul className="home-watch__list">
          {items.map((item) => {
            const ticker = tickers.status === 'ready' ? tickers.data[item.symbol] : undefined;
            const name = assetName(item.base, copy);
            return (
              <li key={item.symbol} className="home-watch__item">
                <a data-testid="home-watch__row" className="home-watch__row" href={coinHref(item.base, 'simple')}>
                  <CoinIcon asset={item.base} size={28} />
                  <span className="home-watch__name">
                    <span data-testid="home-watch__ticker" className="home-watch__ticker">
                      {item.base}
                    </span>
                    {name ? <span className="home-watch__full">{name}</span> : null}
                  </span>
                  <Sparkline
                    values={points[item.symbol] ?? []}
                    width={64}
                    height={24}
                    direction={direction(ticker?.changePct24h) ?? 'flat'}
                  />
                  <span className="home-watch__figures">
                    <span className="home-watch__price" data-money>
                      {priceText(item, ticker)}
                    </span>
                    <Pct value={fmtPct(ticker?.changePct24h)} className="home-watch__pct" />
                  </span>
                </a>
                <StarButton asset={item.base} on={favoriting.isFavorite(item.symbol)} toggle={() => favoriting.toggle(item.symbol)} />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
