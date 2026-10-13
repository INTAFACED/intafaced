import { assetName, homeCopy } from './copy';
import {
  directionOf,
  fmtPct,
  fmtPrice,
  InfoTip,
  Pct,
  Skeleton,
  Sparkline,
  StateBlock,
  type Decimal,
  type Loadable,
  type TickerRow,
} from './deps';
import { isUsdQuote, type Listing } from './select';

export type Tickers = Loadable<Record<string, TickerRow>>;

export function priceText(item: Listing, ticker: TickerRow | undefined): string {
  return fmtPrice(ticker?.last, item.market.tickSize, isUsdQuote(item.market.quote));
}

function MarketCard({ item, tickers, points }: { item: Listing; tickers: Tickers; points: Decimal[] | undefined }) {
  const copy = homeCopy.useCopy();
  const ticker = tickers.status === 'ready' ? tickers.data[item.symbol] : undefined;
  const name = assetName(item.base, copy);
  return (
    <a className="home-card" href={`/coin/${encodeURIComponent(item.base)}`}>
      <span className="home-card__name">
        <span className="home-card__ticker">{item.base}</span>
        {name ? <span className="home-card__full">{name}</span> : null}
      </span>
      <Sparkline points={points} width={154} height={56} />
      {tickers.status === 'loading' ? (
        <span className="home-card__figures" aria-hidden="true">
          <Skeleton width={96} height={28} radius={4} />
          <Skeleton width={64} height={20} radius={4} />
        </span>
      ) : (
        <span className="home-card__figures">
          <span className="home-card__price" data-money>
            {priceText(item, ticker)}
          </span>
          <Pct text={fmtPct(ticker?.changePct24h)} direction={directionOf(ticker?.changePct24h)} />
        </span>
      )}
    </a>
  );
}

export function MarketsRow({
  cards,
  tickers,
  sparklines,
}: {
  cards: Listing[];
  tickers: Tickers;
  sparklines: Loadable<Record<string, Decimal[]>>;
}) {
  const points = sparklines.status === 'ready' ? sparklines.data : {};
  return (
    <div className="home-cards">
      {cards.map((item) => (
        <MarketCard key={item.symbol} item={item} tickers={tickers} points={points[item.symbol]} />
      ))}
    </div>
  );
}

export function MarketsSkeleton() {
  return (
    <div className="home-cards" aria-hidden="true">
      {[0, 1, 2, 3].map((index) => (
        <Skeleton key={index} width="100%" height={176} radius={16} />
      ))}
    </div>
  );
}

export function MarketsFailure({ retry }: { retry?: () => void }) {
  const { t } = homeCopy.useCopy();
  return <StateBlock title={t('Couldn’t load markets')} action={retry ? { label: t('Try again'), onClick: retry } : undefined} />;
}

export function MoversRow({ movers }: { movers: Array<{ base: string; ticker: TickerRow }> }) {
  return (
    <ul className="home-pills">
      {movers.map(({ base, ticker }) => (
        <li key={base}>
          <a className="home-pill" href={`/coin/${encodeURIComponent(base)}`}>
            <span>{base}</span>
            <Pct text={fmtPct(ticker.changePct24h)} direction={directionOf(ticker.changePct24h)} />
          </a>
        </li>
      ))}
    </ul>
  );
}

export function MoversSkeleton() {
  return (
    <div className="home-pills" aria-hidden="true">
      {[0, 1, 2, 3, 4, 5].map((index) => (
        <Skeleton key={index} width={140} height={40} radius={999} />
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
