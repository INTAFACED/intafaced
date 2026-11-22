import { CoinMark, Sparkline } from '@intafaced/ui/lit/templates';
import { assetName, homeCopy } from './copy';
import { priceText, type Favoriting, type Tickers } from './MarketsSection';
import { coinHref, direction, fmtPct, type Decimal, type Loadable } from './deps';
import { StarButton } from './Star';
import type { Listing } from './select';
import { Ghost, Pct } from './volt-parts';

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
    <section data-testid="home-watch" className="lt-stack" aria-labelledby="home-watch-title">
      <div data-testid="home-watch__head" className="lt-title-row">
        <h2 id="home-watch-title">{popular ? t('Popular') : t('Watchlist')}</h2>
        {/* No Edit button: the stars on each row edit the watchlist; a markets screen comes in M2 (critic N6). */}
      </div>
      {popular && !loading ? (
        <p data-testid="home-side__empty--hint" className="lt-hint">
          {t('Watchlist hint')}
        </p>
      ) : null}
      {loading ? (
        <div data-testid="home-watch__row" aria-hidden="true">
          <Ghost shape="rows" count={6} />
        </div>
      ) : (
        <ul className="lt-rows">
          {items.map((item) => {
            const ticker = tickers.status === 'ready' ? tickers.data[item.symbol] : undefined;
            const name = assetName(item.base, copy);
            const dir = direction(ticker?.changePct24h) ?? 'flat';
            return (
              <li key={item.symbol} className="lt-actions">
                <a data-testid="home-watch__row" className="lt-row-link" href={coinHref(item.base, 'simple')}>
                  <CoinMark asset={item.base} />
                  <span className="lt-lines">
                    <span data-testid="home-watch__ticker">{item.base}</span>
                    {name ? <span className="lt-hint">{name}</span> : null}
                  </span>
                  <Sparkline
                    values={points[item.symbol] ?? []}
                    label={t('Price trend {asset}', { asset: item.base })}
                    tone={dir === 'flat' ? 'neutral' : dir}
                    size="row"
                  />
                  <span className="lt-lines">
                    <span data-money>{priceText(item, ticker)}</span>
                    <Pct value={fmtPct(ticker?.changePct24h)} />
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
