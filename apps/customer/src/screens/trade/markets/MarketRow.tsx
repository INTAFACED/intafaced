import type { CSSProperties, ReactNode } from 'react';
import { Star } from 'lucide-react';
import { useSession } from '../../../features/session/session';
import { assetName, marketsCopy } from './copy';
import {
  Button,
  CoinIcon,
  direction,
  fmtPct,
  fmtPrice,
  isHiddenPath,
  Pct,
  Price,
  Sparkline,
  type Decimal,
  type MarketData,
  type TickerRow,
} from './deps';
import { partialWindowStart, sinceLabel } from './window';
import { usePreferences } from '../../../shared/preferences';
import { ALL_COLUMNS, marketTarget, priceText, rangePosition, volumeText, type MarketColumn, type Mode } from './select';

/**
 * A star beside a market. Signed in it is a button that toggles the favourite; signed out it is a link to sign in
 * and come back (UI-SPEC 5.6: "star requires sign-in").
 */
export type FavoriteControl = { on: boolean; onToggle: () => void } | { signInHref: string };

export interface MarketRowProps {
  /** The market: symbol such as "BTC-USDT", base, quote, tick size. */
  market: MarketData;
  /** Its latest ticker, or undefined while prices load or when the service has none (the row shows "—"). */
  ticker: TickerRow | undefined;
  /** Up to 24 hourly closes, oldest first, from `useSparklines`. Undefined draws nothing. */
  points?: Decimal[];
  /** Which cells to draw, in order. Default: all seven. Ignored by `variant="panel"`. */
  columns?: readonly MarketColumn[];
  /** Simple sends the action to the Buy card ("Buy"); Pro sends it to the desk ("Trade"). */
  mode: Mode;
  /**
   * Where the row goes when it is clicked or Enter is pressed. Default: `marketTarget(market, mode)`, which is the
   * Buy card for Simple (while it is live) and the desk `/trade/spot/<PAIR>` otherwise.
   */
  href?: string;
  /** Star control; omit to draw no star. */
  favorite?: FavoriteControl;
  /** `table` is the 60 px full-width row; `panel` is the two-line 60 px row for the desk's 280 px markets panel. */
  variant?: 'table' | 'panel';
  /** Highlights the row (the desk's current pair). */
  selected?: boolean;
  /** 1-based row position, for assistive tech when the list is windowed. */
  ariaRowIndex?: number;
  /** Position within the list; the table uses it for arrow-key movement. */
  index?: number;
  style?: CSSProperties;
}

export function MarketStar({ asset, favorite }: { asset: string; favorite: FavoriteControl }) {
  const { t } = marketsCopy.useCopy();
  if ('signInHref' in favorite)
    return (
      <a className="mkt-star" href={favorite.signInHref} aria-label={t('Log in to star {asset}', { asset })}>
        <Star size={16} aria-hidden="true" />
      </a>
    );
  return (
    <button
      type="button"
      className={`mkt-star ${favorite.on ? 'mkt-star--on' : ''}`}
      aria-pressed={favorite.on}
      aria-label={favorite.on ? t('Remove {asset} from favorites', { asset }) : t('Add {asset} to favorites', { asset })}
      onClick={favorite.onToggle}
    >
      <Star size={16} aria-hidden="true" fill={favorite.on ? 'currentColor' : 'none'} />
    </button>
  );
}

function RangeCell({ market, ticker }: { market: MarketData; ticker: TickerRow | undefined }) {
  const { t } = marketsCopy.useCopy();
  const position = rangePosition(ticker);
  const low = ticker?.low24h ?? null;
  const high = ticker?.high24h ?? null;
  if (position === null || fmtPrice(low, market.tickSize) === '—' || fmtPrice(high, market.tickSize) === '—')
    return <span className="mkt-muted">—</span>;
  return (
    <div
      className="mkt-range"
      role="img"
      aria-label={`${t('Low {price}', { price: priceText(market, low) })}, ${t('High {price}', { price: priceText(market, high) })}`}
    >
      <div className="mkt-range__bar" aria-hidden="true">
        <span data-testid="mkt-range__marker" className="mkt-range__marker" style={{ left: `${position}%` }} />
      </div>
      <div data-testid="mkt-range__ends" className="mkt-range__ends" aria-hidden="true">
        <span>{priceText(market, low)}</span>
        <span>{priceText(market, high)}</span>
      </div>
    </div>
  );
}

/**
 * One market. Used by the Markets list (`variant="table"`), and by Home Pro and the desk's markets panel.
 * The whole row is a link (a stretched anchor around the name); the star and the action buttons sit above it.
 */
export function MarketRow({
  market,
  ticker,
  points,
  columns,
  mode,
  href,
  favorite,
  variant = 'table',
  selected = false,
  ariaRowIndex,
  index,
  style,
}: MarketRowProps) {
  const copy = marketsCopy.useCopy();
  const { t } = copy;
  const { session } = useSession();
  const name = assetName(market.base, copy);
  const target = href ?? marketTarget(market, mode, isHiddenPath, Boolean(session));
  const dir = direction(ticker?.changePct24h) ?? 'flat';
  const price = priceText(market, ticker?.last);
  const change = fmtPct(ticker?.changePct24h);
  const { timeZone } = usePreferences();
  // A market younger than a day: its "24h" figures start later. Said on its own row, so the headers stay true for the rest.
  const start = partialWindowStart(ticker, Date.now());
  const since = start === null ? null : t('since {time}', { time: sinceLabel(start, timeZone) });
  const coinPath = `/coin/${encodeURIComponent(market.base)}`;
  const showDetails = Boolean(session) && !isHiddenPath(coinPath);
  const rowProps = {
    role: 'row',
    'aria-rowindex': ariaRowIndex,
    'data-symbol': market.symbol,
    'data-row-index': index,
    'data-selected': selected || undefined,
    style,
  } as const;

  if (variant === 'panel')
    return (
      <div data-testid="mkt-row" className="mkt-row mkt-row--panel" {...rowProps}>
        <div role="cell" className="mkt-panel__star">
          {favorite ? <MarketStar asset={market.base} favorite={favorite} /> : null}
        </div>
        <div role="cell" className="mkt-panel__name">
          <a className="mkt-link" data-row-link href={target} aria-current={selected ? 'page' : undefined}>
            <span className="mkt-panel__pair">
              {market.base}
              <span className="mkt-muted">/{market.quote}</span>
            </span>
            <span className="mkt-panel__sub">
              {name ? `${name} · ` : ''}
              {volumeText(market, ticker)}
            </span>
          </a>
        </div>
        <div role="cell" className="mkt-panel__figures">
          <Price className="mkt-panel__price" value={price} />
          <Pct value={change} />
          {since ? (
            <span data-testid="mkt-since" className="mkt-since">
              {since}
            </span>
          ) : null}
        </div>
      </div>
    );

  const cells: Record<MarketColumn, ReactNode> = {
    name: (
      <div role="cell" className="mkt-cell mkt-cell--name" data-col="name" key="name">
        {favorite ? <MarketStar asset={market.base} favorite={favorite} /> : <span className="mkt-star-gap" />}
        <a className="mkt-link" data-row-link href={target}>
          <CoinIcon asset={market.base} size={32} />
          <span className="mkt-name">
            <span data-testid="mkt-name__ticker" className="mkt-name__ticker">
              {market.base}
              <span data-testid="mkt-name__quote" className="mkt-muted mkt-name__quote">
                /{market.quote}
              </span>
            </span>
            {name ? (
              <span data-testid="mkt-name__full" className="mkt-name__full">
                {name}
              </span>
            ) : null}
          </span>
        </a>
      </div>
    ),
    price: (
      <div role="cell" data-testid="mkt-cell--num" className="mkt-cell mkt-cell--num" data-col="price" key="price">
        <Price className="mkt-price" value={price} />
      </div>
    ),
    change: (
      <div role="cell" data-testid="mkt-cell--num" className="mkt-cell mkt-cell--num" data-col="change" key="change">
        <span className="mkt-stack">
          <Pct value={change} arrow />
          {since ? (
            <span data-testid="mkt-since" className="mkt-since">
              {since}
            </span>
          ) : null}
        </span>
      </div>
    ),
    spark: (
      <div role="cell" className="mkt-cell" data-col="spark" key="spark">
        <Sparkline values={points ?? []} width={120} height={32} direction={dir} />
      </div>
    ),
    range: (
      <div role="cell" className="mkt-cell" data-col="range" key="range">
        <RangeCell market={market} ticker={ticker} />
      </div>
    ),
    volume: (
      <div role="cell" data-testid="mkt-cell--num" className="mkt-cell mkt-cell--num" data-col="volume" key="volume">
        <span className="mkt-stack">
          <span className="mkt-volume" data-slot="volume">
            {volumeText(market, ticker)}
          </span>
          {since ? (
            <span data-testid="mkt-since" className="mkt-since">
              {since}
            </span>
          ) : null}
        </span>
      </div>
    ),
    action: (
      <div role="cell" className="mkt-cell mkt-cell--action" data-col="action" key="action">
        <Button
          variant="secondary"
          size={32}
          nativeButton={false}
          render={<a href={target} />}
          aria-label={
            mode === 'simple' ? t('Buy {asset}', { asset: market.base }) : t('Trade {pair}', { pair: `${market.base}/${market.quote}` })
          }
        >
          {mode === 'simple' ? t('Buy') : t('Trade')}
        </Button>
        {showDetails ? (
          <Button
            variant="ghost"
            size={32}
            nativeButton={false}
            render={<a href={coinPath} />}
            aria-label={t('Details for {asset}', { asset: market.base })}
          >
            {t('Details')}
          </Button>
        ) : null}
      </div>
    ),
  };

  return (
    <div data-testid="mkt-row" className="mkt-row" {...rowProps}>
      {(columns ?? ALL_COLUMNS).map((column) => cells[column])}
    </div>
  );
}
