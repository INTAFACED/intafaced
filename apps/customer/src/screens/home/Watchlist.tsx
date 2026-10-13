import { assetName, homeCopy } from './copy';
import { priceText, type Tickers } from './MarketsSection';
import { direction, fmtPct, Button, CoinIcon, Pct, Skeleton, Sparkline, type Decimal, type Loadable } from './deps';
import type { Listing } from './select';

export function Watchlist({
  items,
  popular,
  tickers,
  sparklines,
  loading,
}: {
  items: Listing[];
  popular: boolean;
  tickers: Tickers;
  sparklines: Loadable<Record<string, Decimal[]>>;
  loading: boolean;
}) {
  const copy = homeCopy.useCopy();
  const { t } = copy;
  const points = sparklines.status === 'ready' ? sparklines.data : {};
  return (
    <section className="home-watch" aria-labelledby="home-watch-title">
      <div className="home-watch__head">
        <h2 id="home-watch-title">{popular ? t('Popular') : t('Watchlist')}</h2>
        <Button
          variant="ghost"
          size={32}
          nativeButton={false}
          render={<a href="/trade?tab=favorites" />}
          aria-label={t('Edit your watchlist')}
        >
          {t('Edit')}
        </Button>
      </div>
      {loading ? (
        <div aria-hidden="true">
          {[0, 1, 2, 3, 4, 5].map((index) => (
            <div className="home-watch__row" key={index}>
              <Skeleton width={28} height={28} circle />
              <Skeleton width={72} height={36} />
              <Skeleton width={64} height={24} />
              <Skeleton width={72} height={36} />
            </div>
          ))}
        </div>
      ) : (
        <ul className="home-watch__list">
          {items.map((item) => {
            const ticker = tickers.status === 'ready' ? tickers.data[item.symbol] : undefined;
            const name = assetName(item.base, copy);
            return (
              <li key={item.symbol}>
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
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
