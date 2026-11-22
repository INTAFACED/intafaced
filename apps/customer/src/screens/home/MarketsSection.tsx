import { assetName, homeCopy } from './copy';
import { Sparkline } from '@intafaced/ui/lit/templates';
import { coinHref, direction, fmtPct, fmtPrice, type Decimal, type Loadable, type TickerRow } from './deps';
import { InfoTip } from './InfoTip';
import { StarButton } from './Star';
import { Ghost, Pct, StateBlock, UNKNOWN } from './volt-parts';
import { isUsdQuote, type Listing } from './select';

export type Tickers = Loadable<Record<string, TickerRow>>;

/** "$64,815.49" for a dollar-quoted market, "0.0123 BTC" otherwise; an unknown price is a bare "—" (critic M3). */
export function priceText(item: Listing, ticker: TickerRow | undefined): string {
  const price = fmtPrice(ticker?.last, item.market.tickSize);
  if (price === UNKNOWN) return price;
  return isUsdQuote(item.market.quote) ? `$${price}` : `${price} ${item.market.quote}`;
}

export interface Favoriting {
  isFavorite: (symbol: string) => boolean;
  toggle: (symbol: string) => void;
}

function MarketCard({
  item,
  tickers,
  points,
  favoriting,
}: {
  item: Listing;
  tickers: Tickers;
  points: Decimal[] | undefined;
  favoriting: Favoriting;
}) {
  const copy = homeCopy.useCopy();
  const ticker = tickers.status === 'ready' ? tickers.data[item.symbol] : undefined;
  const name = assetName(item.base, copy);
  const dir = direction(ticker?.changePct24h) ?? 'flat';
  return (
    <div className="lt-stack">
      <a data-testid="home-card" className="lt-lines" href={coinHref(item.base, 'simple')}>
        <span>
          <span data-testid="home-card__ticker">{item.base}</span>
          {name ? <span className="lt-hint"> {name}</span> : null}
        </span>
        <Sparkline
          values={points ?? []}
          label={copy.t('Price trend {asset}', { asset: item.base })}
          tone={dir === 'flat' ? 'neutral' : dir}
        />
        {tickers.status === 'loading' ? (
          <Ghost shape="text" count={2} />
        ) : (
          <span>
            <span data-testid="home-card__price" className="lt-figure" data-money>
              {priceText(item, ticker)}
            </span>{' '}
            <Pct value={fmtPct(ticker?.changePct24h)} arrow />
          </span>
        )}
      </a>
      <StarButton asset={item.base} on={favoriting.isFavorite(item.symbol)} toggle={() => favoriting.toggle(item.symbol)} />
    </div>
  );
}

export function MarketsRow({
  cards,
  tickers,
  sparklines,
  favoriting,
}: {
  cards: Listing[];
  tickers: Tickers;
  sparklines: Loadable<Record<string, Decimal[]>>;
  favoriting: Favoriting;
}) {
  const points = sparklines.status === 'ready' ? sparklines.data : {};
  return (
    <div data-testid="home-cards" className="lt-actions">
      {cards.map((item) => (
        <MarketCard key={item.symbol} item={item} tickers={tickers} points={points[item.symbol]} favoriting={favoriting} />
      ))}
    </div>
  );
}

/** As many placeholders as the final row will have, so nothing moves when the data arrives (critic M4). */
export function MarketsSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div data-testid="home-cards" className="lt-actions" aria-hidden="true">
      {Array.from({ length: Math.min(4, count) }, (_, index) => index).map((index) => (
        <Ghost key={index} shape="chart" />
      ))}
    </div>
  );
}

export function MarketsFailure({ retry }: { retry?: () => void }) {
  const { t } = homeCopy.useCopy();
  return retry ? (
    <StateBlock kind="error" title={t('Couldn’t load markets')} onRetry={retry} retryLabel={t('Try again')} />
  ) : (
    <StateBlock kind="empty" title={t('Couldn’t load markets')} />
  );
}

export function MoversRow({ movers }: { movers: Array<{ base: string; ticker: TickerRow }> }) {
  return (
    <ul data-testid="home-pills" className="lt-actions">
      {movers.map(({ base, ticker }) => (
        <li key={base}>
          <a data-testid="home-pill" className="lt-button lt-button-secondary" href={coinHref(base, 'simple')}>
            <span>{base}</span>
            <Pct value={fmtPct(ticker.changePct24h)} arrow />
          </a>
        </li>
      ))}
    </ul>
  );
}

/** As many mover keys as the real row draws, so the row keeps its size when they arrive. */
export function MoversSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div data-testid="home-pills" aria-hidden="true">
      <Ghost shape="keys" count={Math.min(6, count)} />
    </div>
  );
}

export function MoversHeading() {
  const { t } = homeCopy.useCopy();
  return (
    <h2>
      {t('Top movers')}
      <InfoTip text={t('Top movers rule')} label={t('Top movers label')} />
    </h2>
  );
}
