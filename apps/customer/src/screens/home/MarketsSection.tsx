import { assetName, homeCopy } from './copy';
import { direction, fmtPct, fmtPrice, Pct, Skeleton, Sparkline, StateBlock, type Decimal, type Loadable, type TickerRow } from './deps';
import { InfoTip } from './InfoTip';
import type { Listing } from './select';

export type Tickers = Loadable<Record<string, TickerRow>>;

export function priceText(item: Listing, ticker: TickerRow | undefined): string {
  return fmtPrice(ticker?.last, item.market.tickSize);
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
      <Sparkline values={points ?? []} width={154} height={56} endDot direction={direction(ticker?.changePct24h) ?? 'flat'} />
      {tickers.status === 'loading' ? (
        <span className="home-card__figures" aria-hidden="true">
          <Skeleton width={96} height={28} />
          <Skeleton width={64} height={20} />
        </span>
      ) : (
        <span className="home-card__figures">
          <span className="home-card__price" data-money>
            {priceText(item, ticker)}
          </span>
          <Pct value={fmtPct(ticker?.changePct24h)} arrow />
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
        <Skeleton key={index} width="100%" height={176} className="rounded-lg" />
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
    <ul className="home-pills">
      {movers.map(({ base, ticker }) => (
        <li key={base}>
          <a className="home-pill" href={`/coin/${encodeURIComponent(base)}`}>
            <span>{base}</span>
            <Pct value={fmtPct(ticker.changePct24h)} arrow />
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
        <Skeleton key={index} width={140} height={40} circle />
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
