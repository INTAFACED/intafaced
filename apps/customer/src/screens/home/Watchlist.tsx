import { assetName, homeCopy } from './copy';
import { priceText, type Favoriting, type Tickers } from './MarketsSection';
import { defaultDeskPair, direction, fmtPct, Button, CoinIcon, Pct, Skeleton, Sparkline, type Decimal, type Loadable } from './deps';
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
    <section className="home-watch" aria-labelledby="home-watch-title">
      <div className="home-watch__head">
        <h2 id="home-watch-title">{popular ? t('Popular') : t('Watchlist')}</h2>
        {/* The watchlist editor lives on the spot desk (star bar) until the M2 markets screen; /trade?tab=favorites opened a dead desk. */}
        <Button
          variant="ghost"
          size={32}
          nativeButton={false}
          render={<a href={`/trade/spot/${defaultDeskPair}`} />}
          aria-label={t('Edit your watchlist')}
        >
          {t('Edit')}
        </Button>
      </div>
      {loading ? (
        <div aria-hidden="true">
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <div className="home-watch__row" key={index}>
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
                <a className="home-watch__row" href={`/coin/${encodeURIComponent(item.base)}`}>
                  <CoinIcon asset={item.base} size={28} />
                  <span className="home-watch__name">
                    <span className="home-watch__ticker">{item.base}</span>
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
