import { assetName, homeCopy } from './copy';
import {
  coinHref,
  direction,
  fmtPct,
  fmtPrice,
  Pct,
  Skeleton,
  Sparkline,
  StateBlock,
  type Decimal,
  type Loadable,
  type TickerRow,
} from './deps';

const UNKNOWN = '—';
import { InfoTip } from './InfoTip';
import { STATE_IN_COLUMN } from './panel';
import { StarButton } from './Star';
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
  return (
    <div className="home-card-wrap">
      <a data-testid="home-card" className="home-card" href={coinHref(item.base, 'simple')}>
        <span className="home-card__name">
          <span data-testid="home-card__ticker" className="home-card__ticker">
            {item.base}
          </span>
          {name ? <span className="home-card__full">{name}</span> : null}
        </span>
        <Sparkline values={points ?? []} width={154} height={56} endDot direction={direction(ticker?.changePct24h) ?? 'flat'} />
        {tickers.status === 'loading' ? (
          <span className="home-card__figures" aria-hidden="true">
            <Skeleton width={96} height={28} />
            <Skeleton width={64} height={20} />
          </span>
        ) : (
          <span className="home-card__figures">
            <span data-testid="home-card__price" className="home-card__price" data-money>
              {priceText(item, ticker)}
            </span>
            <Pct value={fmtPct(ticker?.changePct24h)} arrow />
          </span>
        )}
      </a>
      <StarButton
        asset={item.base}
        on={favoriting.isFavorite(item.symbol)}
        toggle={() => favoriting.toggle(item.symbol)}
        className="home-card__star"
      />
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
    <div data-testid="home-cards" className="home-cards">
      {cards.map((item) => (
        <MarketCard key={item.symbol} item={item} tickers={tickers} points={points[item.symbol]} favoriting={favoriting} />
      ))}
    </div>
  );
}

/** As many placeholders as the final row will have, so nothing moves when the data arrives (critic M4). */
export function MarketsSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div data-testid="home-cards" className="home-cards" aria-hidden="true">
      {Array.from({ length: Math.min(4, count) }, (_, index) => index).map((index) => (
        <Skeleton key={index} width="100%" height={176} className="rounded-lg" />
      ))}
    </div>
  );
}

export function MarketsFailure({ retry }: { retry?: () => void }) {
  const { t } = homeCopy.useCopy();
  return retry ? (
    <StateBlock kind="error" className={STATE_IN_COLUMN} title={t('Couldn’t load markets')} onRetry={retry} retryLabel={t('Try again')} />
  ) : (
    <StateBlock kind="empty" className={STATE_IN_COLUMN} title={t('Couldn’t load markets')} />
  );
}

export function MoversRow({ movers }: { movers: Array<{ base: string; ticker: TickerRow }> }) {
  return (
    <ul data-testid="home-pills" className="home-pills">
      {movers.map(({ base, ticker }) => (
        <li key={base}>
          <a data-testid="home-pill" className="home-pill" href={coinHref(base, 'simple')}>
            <span>{base}</span>
            <Pct value={fmtPct(ticker.changePct24h)} arrow />
          </a>
        </li>
      ))}
    </ul>
  );
}

/** A mover pill is about 135 px wide, so six wrap onto a second row exactly as the real ones do. */
const PILL_WIDTHS = [135, 135, 135, 135, 135, 135];

export function MoversSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div data-testid="home-pills" className="home-pills" aria-hidden="true">
      {PILL_WIDTHS.slice(0, Math.min(6, count)).map((width, index) => (
        <Skeleton key={index} width={width} height={40} circle />
      ))}
    </div>
  );
}

export function MoversHeading() {
  const { t } = homeCopy.useCopy();
  return (
    <h2 className="home-h2">
      {t('Top movers')}
      <InfoTip text={t('Top movers rule')} label={t('Top movers label')} />
    </h2>
  );
}
