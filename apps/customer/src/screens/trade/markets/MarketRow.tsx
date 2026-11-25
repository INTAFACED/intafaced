import type { ReactNode } from 'react';
import { Star } from 'lucide-react';
import { AssetIcon, Button } from '@intafaced/ui/lit';
import { Meter, Skeleton, Sparkline, type Column } from '@intafaced/ui/lit/templates';
import { useSession } from '../../../features/session/session';
import { isHiddenPath } from '../../../app/feature-registry';
import { direction, fmtPct, fmtPrice, type Decimal, type MarketRow as MarketData, type TickerRow } from '../../../data';
import { usePreferences } from '../../../shared/preferences';
import { assetName, marketsCopy } from './copy';
import { partialWindowStart, sinceLabel } from './window';
import { marketTarget, priceText, rangePosition, volumeText, type Entry, type MarketColumn, type Mode } from './select';

/**
 * A star beside a market. Signed in it is a button that toggles the favourite; signed out it is a link to sign in
 * and come back (UI-SPEC 5.6: "star requires sign-in").
 */
export type FavoriteControl = { on: boolean; onToggle: () => void } | { signInHref: string };

/** One row of the markets table: a market with its latest ticker, or a placeholder in the row's shape while they load. */
export type MarketLine = { entry: Entry } | { ghost: number };

/** What every row's cells share: where a row goes, its star, its line's points. */
export interface MarketCells {
  mode: Mode;
  hrefFor?: (market: MarketData, mode: Mode) => string;
  favorite?: (market: MarketData) => FavoriteControl | undefined;
  sparklines?: Record<string, Decimal[]>;
}

const NUMERIC: readonly MarketColumn[] = ['price', 'change', 'volume'];

const LABEL = {
  name: 'Name',
  price: 'Price',
  change: '24h change',
  spark: 'Last 24h',
  range: '24h range',
  volume: '24h volume',
  action: 'Action',
} as const satisfies Record<MarketColumn, string>;

function MarketStar({ asset, favorite }: { asset: string; favorite: FavoriteControl }) {
  const { t } = marketsCopy.useCopy();
  if ('signInHref' in favorite)
    return (
      <a className="lt-link" href={favorite.signInHref} aria-label={t('Log in to star {asset}', { asset })}>
        <Star size={16} aria-hidden="true" />
      </a>
    );
  return (
    <Button
      tone="quiet"
      aria-pressed={favorite.on}
      aria-label={favorite.on ? t('Remove {asset} from favorites', { asset }) : t('Add {asset} to favorites', { asset })}
      onClick={favorite.onToggle}
    >
      <Star size={16} aria-hidden="true" fill={favorite.on ? 'currentColor' : 'none'} />
    </Button>
  );
}

/** Where the row goes: the caller's own target, else the Buy card (Simple) or the desk (Pro). */
function useTarget(market: MarketData, cells: MarketCells): string | null {
  const signedIn = Boolean(useSession().session);
  return cells.hrefFor ? cells.hrefFor(market, cells.mode) : marketTarget(market, cells.mode, isHiddenPath, signedIn);
}

/** A market younger than a day: its "24h" figures start later, said on its own row so the headers stay true for the rest. */
function Since({ ticker }: { ticker: TickerRow | undefined }) {
  const { t } = marketsCopy.useCopy();
  const { timeZone } = usePreferences();
  const start = partialWindowStart(ticker, Date.now());
  if (start === null) return null;
  return (
    <span data-testid="mkt-since" className="lt-hint">
      {t('since {time}', { time: sinceLabel(start, timeZone) })}
    </span>
  );
}

function NameCell({ entry, cells }: { entry: Entry; cells: MarketCells }) {
  const copy = marketsCopy.useCopy();
  const { market } = entry;
  const name = assetName(market.base, copy);
  const favorite = cells.favorite?.(market);
  return (
    <span className="lt-actions">
      {favorite ? <MarketStar asset={market.base} favorite={favorite} /> : null}
      <Link href={useTarget(market, cells)}>
        <AssetIcon asset={market.base} />
        <span data-testid="mkt-name__ticker">
          {market.base}
          <span data-testid="mkt-name__quote" className="lt-hint">
            /{market.quote}
          </span>
        </span>
        {name ? (
          <span data-testid="mkt-name__full" className="lt-hint">
            {name}
          </span>
        ) : null}
      </Link>
    </span>
  );
}

/** The row's name as its link, or as plain words when it has nowhere shown to go (the beta draws a hidden room's link as nothing). */
function Link({ href, children }: { href: string | null; children: ReactNode }) {
  if (href === null) return <span className="lt-row-link">{children}</span>;
  return (
    <a className="lt-row-link" data-row-link="" href={href}>
      {children}
    </a>
  );
}

function ChangeCell({ ticker }: { ticker: TickerRow | undefined }) {
  const change = fmtPct(ticker?.changePct24h);
  const dir = direction(ticker?.changePct24h) ?? 'flat';
  // Drawn (the kit's lt-arrow-up / lt-arrow-down), never typed: Volt's faces carry no ▲ ▼ glyphs.
  const arrow = ticker?.changePct24h == null || dir === 'flat' ? null : dir;
  return (
    <>
      <span data-slot="pct" data-direction={dir} data-dir={dir === 'flat' ? undefined : dir} dir="ltr" data-ltr="">
        {arrow ? (
          <>
            <span className={`lt-arrow lt-arrow-${arrow}`} aria-hidden="true" data-arrow={arrow} />{' '}
          </>
        ) : null}
        {change}
      </span>
      <Since ticker={ticker} />
    </>
  );
}

function SparkCell({ entry, cells }: { entry: Entry; cells: MarketCells }) {
  const { t } = marketsCopy.useCopy();
  const dir = direction(entry.ticker?.changePct24h);
  return (
    <Sparkline
      label={`${entry.market.base}/${entry.market.quote} ${t('Last 24h')}`}
      values={cells.sparklines?.[entry.market.symbol] ?? []}
      tone={dir === 'up' ? 'up' : dir === 'down' ? 'down' : 'neutral'}
      size="row"
    />
  );
}

function RangeCell({ market, ticker }: { market: MarketData; ticker: TickerRow | undefined }) {
  const { t } = marketsCopy.useCopy();
  const position = rangePosition(ticker);
  const low = ticker?.low24h ?? null;
  const high = ticker?.high24h ?? null;
  if (position === null || fmtPrice(low, market.tickSize) === '—' || fmtPrice(high, market.tickSize) === '—')
    return <span className="lt-hint">—</span>;
  const ends = `${t('Low {price}', { price: priceText(market, low) })}, ${t('High {price}', { price: priceText(market, high) })}`;
  return (
    <span className="lt-stack">
      {/* Where the last price sits between the day's low and high (a position for drawing, never money). */}
      <span data-testid="mkt-range__marker">
        <Meter label={t('24h range')} value={position} text={ends} />
      </span>
      <span data-testid="mkt-range__ends" className="lt-hint" aria-hidden="true" dir="ltr" data-ltr="">
        {priceText(market, low)} – {priceText(market, high)}
      </span>
    </span>
  );
}

function ActionCell({ market, cells }: { market: MarketData; cells: MarketCells }) {
  const { t } = marketsCopy.useCopy();
  const { session } = useSession();
  const target = useTarget(market, cells);
  const coinPath = `/coin/${encodeURIComponent(market.base)}`;
  const showDetails = Boolean(session) && !isHiddenPath(coinPath);
  return (
    <span className="lt-actions">
      {target === null ? null : (
        <a
          className="lt-button lt-button-secondary"
          href={target}
          aria-label={
            cells.mode === 'simple'
              ? t('Buy {asset}', { asset: market.base })
              : t('Trade {pair}', { pair: `${market.base}/${market.quote}` })
          }
        >
          {cells.mode === 'simple' ? t('Buy') : t('Trade')}
        </a>
      )}
      {showDetails ? (
        <a className="lt-link" href={coinPath} aria-label={t('Details for {asset}', { asset: market.base })}>
          {t('Details')}
        </a>
      ) : null}
    </span>
  );
}

function cell(column: MarketColumn, entry: Entry, cells: MarketCells): ReactNode {
  const { market, ticker } = entry;
  switch (column) {
    case 'name':
      return <NameCell entry={entry} cells={cells} />;
    case 'price':
      return (
        <span data-slot="price" dir="ltr" data-ltr="">
          {priceText(market, ticker?.last)}
        </span>
      );
    case 'change':
      return <ChangeCell ticker={ticker} />;
    case 'spark':
      return <SparkCell entry={entry} cells={cells} />;
    case 'range':
      return <RangeCell market={market} ticker={ticker} />;
    case 'volume':
      return (
        <>
          <span data-slot="volume">{volumeText(market, ticker)}</span>
          <Since ticker={ticker} />
        </>
      );
    case 'action':
      return <ActionCell market={market} cells={cells} />;
  }
}

/**
 * The markets table's columns on the kit's Table: one market per row, each cell drawn from the kit, every cell and
 * header keeping the marks its tests find it by (`data-col`, `mkt-cell--num`, `mkt-head--num`). A placeholder row draws
 * each cell's ghost in its final place.
 */
export function marketColumns(
  shown: readonly MarketColumn[],
  cells: MarketCells,
  t: ReturnType<typeof marketsCopy.useCopy>['t'],
  sortable: (column: MarketColumn) => boolean,
): Column<MarketLine>[] {
  return shown.map((column) => {
    const numeric = NUMERIC.includes(column);
    const label = t(LABEL[column]);
    return {
      key: column,
      label,
      align: numeric ? 'end' : 'start',
      headMarks: { 'data-col': column, 'data-testid': numeric ? 'mkt-head--num' : undefined },
      cellMarks: () => ({ 'data-col': column, 'data-testid': numeric ? 'mkt-cell--num' : undefined }),
      ...(sortable(column)
        ? { sortType: column === 'name' ? 'text' : 'decimal', sortLabel: t('Sort by {column}', { column: label }) }
        : {}),
      cell: (line) => ('ghost' in line ? <Skeleton shape="text" count={1} /> : cell(column, line.entry, cells)),
    } satisfies Column<MarketLine>;
  });
}
