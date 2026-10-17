import { createContext, useContext, useId, useMemo, useState, type ReactNode } from 'react';
import { Star } from 'lucide-react';
import { assetName, marketsCopy } from './copy';
import {
  Badge,
  Button,
  CoinIcon,
  direction,
  fmtPct,
  isHiddenPath,
  navigate,
  Pct,
  Price,
  sortRows,
  Sparkline,
  Table,
  useSparklines,
  type Decimal,
  type MarketData,
  type SortState,
  type TableColumn,
} from './deps';
import { isPaused, marketTarget, priceText, spreadRatio, spreadText, volumeText, type Entry, type Mode } from './select';
import { partialWindowStart, sinceLabel } from './window';
import { usePreferences } from '../../../shared/preferences';
import type { Density } from './view-state';
import type { FavoriteControl } from './MarketRow';

/** Rows drawn at first, and added by each "Show more"; sparklines are read for the rows drawn only. */
const PAGE_SIZE = 50;

/** A click on the star must not open the row; the kit table already ignores clicks that start on a button or link. */
function FavoriteStar({ asset, favorite }: { asset: string; favorite: FavoriteControl }) {
  const { t } = marketsCopy.useCopy();
  if ('signInHref' in favorite)
    return (
      <Button
        variant="ghost"
        size={28}
        className="w-7 shrink-0 px-0"
        nativeButton={false}
        render={<a href={favorite.signInHref} />}
        aria-label={t('Log in to star {asset}', { asset })}
      >
        <Star size={16} aria-hidden="true" />
      </Button>
    );
  return (
    <Button
      variant="ghost"
      size={28}
      className={`w-7 shrink-0 px-0 ${favorite.on ? 'text-lime' : ''}`}
      aria-pressed={favorite.on}
      aria-label={favorite.on ? t('Remove {asset} from favorites', { asset }) : t('Add {asset} to favorites', { asset })}
      onClick={favorite.onToggle}
    >
      <Star size={16} aria-hidden="true" fill={favorite.on ? 'currentColor' : 'none'} />
    </Button>
  );
}

/** Hourly closes by symbol, read once for the rows drawn and handed to the chart cells. */
const EMPTY: Record<string, Decimal[]> = {};
const SparkContext = createContext<Record<string, Decimal[]>>(EMPTY);

function SparkCell({ symbol, height, trend }: { symbol: string; height: number; trend: 'up' | 'down' | 'flat' }) {
  return <Sparkline values={useContext(SparkContext)[symbol] ?? []} width={120} height={height} direction={trend} />;
}

export interface MarketsListProps {
  /** Rows after the filters, in the default order; the list sorts them by `sort`. */
  entries: readonly Entry[];
  /** Simple opens the coin page (Buy card) and says "Buy"; Pro opens the desk and says "Trade". */
  mode: Mode;
  density: Density;
  sort: SortState | null;
  onSortChange: (sort: SortState | null) => void;
  /** Star for a market. */
  favorite: (market: MarketData) => FavoriteControl;
  signedIn: boolean;
  loading: boolean;
  /** Drawn in place of the rows when there are none. */
  empty: ReactNode;
  label: string;
}

/** Click order: largest first for figures and A-Z for Name, then the other way, then the service's order. */
const firstDirection = (columnId: string) => (columnId === 'name' ? 'asc' : 'desc');

export function MarketsList({ entries, mode, density, sort, onSortChange, favorite, signedIn, loading, empty, label }: MarketsListProps) {
  const copy = marketsCopy.useCopy();
  const { t } = copy;
  const { timeZone } = usePreferences();
  const pausedNote = useId();
  const [limit, setLimit] = useState(PAGE_SIZE);
  const pro = mode === 'pro';
  const dense = density === 'compact';

  const columns = useMemo<TableColumn<Entry>[]>(() => {
    const figure = (
      id: string,
      header: string,
      read: (entry: Entry) => string | null,
      cell: (entry: Entry) => ReactNode,
    ): TableColumn<Entry> => ({
      id,
      header,
      numeric: true,
      sortable: true,
      sortType: 'decimal',
      value: read,
      cell,
    });
    const price = (id: string, header: string, key: 'last' | 'bid' | 'ask' | 'high24h' | 'low24h') =>
      figure(
        id,
        header,
        ({ ticker }) => ticker?.[key] ?? null,
        ({ market, ticker }) => priceText(market, ticker?.[key]),
      );
    // A market younger than a day: its "24h" figures start later. Said on its own row, so the headers stay true for the rest.
    const sinceOf = (entry: Entry) => {
      const start = partialWindowStart(entry.ticker, Date.now());
      return start === null ? null : t('since {time}', { time: sinceLabel(start, timeZone) });
    };

    const name: TableColumn<Entry> = {
      id: 'name',
      header: t('Name'),
      pin: 'start',
      sortable: true,
      sortType: 'text',
      width: pro ? 240 : 280,
      value: ({ market }) => `${market.base}/${market.quote}`,
      cell: (entry) => {
        const { market } = entry;
        const full = assetName(market.base, copy);
        return (
          <span className="mkt-namecell">
            <FavoriteStar asset={market.base} favorite={favorite(market)} />
            <CoinIcon asset={market.base} size={dense ? 24 : 32} />
            <span className="mkt-name">
              <span className="mkt-name__ticker">
                {market.base}
                <span className="mkt-muted mkt-name__quote">/{market.quote}</span>
              </span>
              {full && !dense ? <span className="mkt-name__full">{full}</span> : null}
            </span>
          </span>
        );
      },
    };
    const last = figure(
      'last',
      t('Last'),
      ({ ticker }) => ticker?.last ?? null,
      ({ market, ticker }) => <Price className="mkt-price" value={priceText(market, ticker?.last)} />,
    );
    const change = figure(
      'change',
      t('24h change'),
      ({ ticker }) => ticker?.changePct24h ?? null,
      (entry) => (
        <span className="mkt-stack">
          <Pct value={fmtPct(entry.ticker?.changePct24h)} arrow />
          {sinceOf(entry) ? <span className="mkt-since">{sinceOf(entry)}</span> : null}
        </span>
      ),
    );
    const spread = figure(
      'spread',
      t('Spread'),
      ({ ticker }) => spreadRatio(ticker),
      ({ ticker }) => spreadText(ticker),
    );
    const volume = figure(
      'volume',
      t('24h volume'),
      ({ ticker }) => ticker?.quoteVolume24h ?? null,
      (entry) => (
        <span className="mkt-stack">
          <span className="mkt-volume" data-slot="volume">
            {volumeText(entry.market, entry.ticker)}
          </span>
          {sinceOf(entry) ? <span className="mkt-since">{sinceOf(entry)}</span> : null}
        </span>
      ),
    );
    const chart: TableColumn<Entry> = {
      id: 'chart',
      header: t('Last 24h'),
      width: 150,
      cell: ({ market, ticker }) => (
        <SparkCell symbol={market.symbol} height={dense ? 24 : 32} trend={direction(ticker?.changePct24h) ?? 'flat'} />
      ),
    };
    const status: TableColumn<Entry> = {
      id: 'status',
      header: t('Status'),
      width: 96,
      cell: (entry) =>
        isPaused(entry) ? (
          <Badge tone="warn" density={dense ? 'dense' : 'comfortable'}>
            {t('Paused')}
          </Badge>
        ) : (
          <Badge tone="lime" density={dense ? 'dense' : 'comfortable'}>
            {t('Open')}
          </Badge>
        ),
    };
    const action: TableColumn<Entry> = {
      id: 'action',
      header: '',
      headerLabel: t('Action'),
      align: 'end',
      width: pro ? 112 : 96,
      cell: (entry) => {
        const { market } = entry;
        const text = pro ? t('Trade') : t('Buy');
        const aria = pro ? t('Trade {pair}', { pair: `${market.base}/${market.quote}` }) : t('Buy {asset}', { asset: market.base });
        const size = dense ? 28 : 32;
        if (isPaused(entry))
          // Disabled but still reachable by keyboard, so the reason can be read (title for the pointer, aria-describedby for readers).
          return (
            <Button
              variant="secondary"
              size={size}
              disabled
              focusableWhenDisabled
              aria-label={aria}
              aria-describedby={pausedNote}
              title={t('Orders are paused on this market')}
            >
              {text}
            </Button>
          );
        return (
          <Button
            variant="secondary"
            size={size}
            nativeButton={false}
            render={<a href={marketTarget(market, mode, isHiddenPath, signedIn)} />}
            aria-label={aria}
          >
            {text}
          </Button>
        );
      },
    };
    return pro
      ? [
          name,
          last,
          change,
          price('bid', t('Bid'), 'bid'),
          price('ask', t('Ask'), 'ask'),
          spread,
          price('high', t('24h high'), 'high24h'),
          price('low', t('24h low'), 'low24h'),
          volume,
          chart,
          status,
          action,
        ]
      : [name, last, change, chart, volume, action];
    // `copy` changes only with the language.
  }, [pro, dense, mode, signedIn, favorite, timeZone, pausedNote, copy.renderedLocale]);

  const sorted = useMemo(() => sortRows(entries, columns, sort), [entries, columns, sort]);
  const shown = useMemo(() => sorted.slice(0, limit), [sorted, limit]);
  const sparklines = useSparklines(useMemo(() => shown.map((entry) => entry.market.symbol), [shown]));
  const more = Math.min(PAGE_SIZE, sorted.length - shown.length);

  return (
    <SparkContext.Provider value={sparklines.status === 'ready' ? sparklines.data : EMPTY}>
      <Table
        label={label}
        columns={columns}
        rows={shown}
        getRowId={(entry) => entry.market.symbol}
        density={dense ? 'dense' : 'comfortable'}
        status={loading ? 'loading' : 'ready'}
        loadingRows={8}
        emptyState={empty}
        sort={sort}
        onSortChange={(next) =>
          onSortChange(sort && sort.columnId === next.columnId && sort.direction !== firstDirection(next.columnId) ? null : next)
        }
        onRowActivate={(entry) => navigate(marketTarget(entry.market, mode, isHiddenPath, signedIn))}
        minWidth={pro ? 1320 : 760}
        labels={{ loading: t('Loading') }}
      />
      <span id={pausedNote} className="sr-only">
        {t('Orders are paused on this market')}
      </span>
      {more > 0 ? (
        <div className="mkt-more">
          <span className="mkt-muted">{t('Showing {shown} of {total} markets', { shown: shown.length, total: sorted.length })}</span>
          <Button variant="secondary" size={32} onClick={() => setLimit(limit + PAGE_SIZE)}>
            {t('Show {count} more markets', { count: more })}
          </Button>
        </div>
      ) : null}
    </SparkContext.Provider>
  );
}
