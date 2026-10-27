import { createContext, useContext, useId, useMemo, useState, type ReactNode } from 'react';
import { Ellipsis, Star } from 'lucide-react';
import { assetName, marketsCopy } from './copy';
import {
  Badge,
  Button,
  CoinIcon,
  direction,
  fmtPct,
  isHiddenPath,
  Menu,
  MenuContent,
  MenuLinkItem,
  MenuTrigger,
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
import { opensLabel, rowStatus, type ListingStatusMap } from './listing-status';
import { partialWindowStart, sinceLabel } from './window';
import { usePreferences } from '../../../shared/preferences';
import type { Density } from './view-state';
import type { FavoriteControl } from './MarketRow';

/** Rows drawn at first, and added by each "Show more"; sparklines are read for the rows drawn only. */
const PAGE_SIZE = 50;

/**
 * Explicit column widths (px). A price like "$64,772.05" and the headers "24h change" / "24h volume" must never be cut,
 * so the table keeps the sum of these as its minimum and scrolls sideways (the name column stays pinned) instead of
 * squeezing. The chart is the first column to give: it is the narrowest and its line only needs ~96 px.
 */
const LAST_WIDTH = 120;
const PRICE_WIDTH = 112;
const WIDE_WIDTH = 132;
const SPREAD_WIDTH = 96;
const CHART_WIDTH = 104;
const STATUS_WIDTH = 150;
/** The action button plus its "more" menu button. */
const ACTION_WIDTH = 150;
const PRO_MIN_WIDTH =
  220 + LAST_WIDTH + WIDE_WIDTH + 4 * PRICE_WIDTH + SPREAD_WIDTH + WIDE_WIDTH + CHART_WIDTH + STATUS_WIDTH + ACTION_WIDTH;
const SIMPLE_MIN_WIDTH = 280 + LAST_WIDTH + WIDE_WIDTH + CHART_WIDTH + WIDE_WIDTH + ACTION_WIDTH;

/** Convert opens with the pair filled in (it reads `from` and `to`): pay in the quote, get the coin. */
const convertHref = (market: MarketData) => `/trade/convert?from=${encodeURIComponent(market.quote)}&to=${encodeURIComponent(market.base)}`;

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
      className={`w-7 shrink-0 px-0 ${favorite.on ? 'text-accent-text' : ''}`}
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
  return <Sparkline values={useContext(SparkContext)[symbol] ?? []} width={96} height={height} direction={trend} />;
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
  /** Session and group facts from the listing; null when that read is not available. */
  statuses?: ListingStatusMap | null;
  loading: boolean;
  /** Drawn in place of the rows when there are none. */
  empty: ReactNode;
  label: string;
}

/** Click order: largest first for figures and A-Z for Name, then the other way, then the service's order. */
const firstDirection = (columnId: string) => (columnId === 'name' ? 'asc' : 'desc');

export function MarketsList({
  entries,
  mode,
  density,
  sort,
  onSortChange,
  favorite,
  signedIn,
  statuses = null,
  loading,
  empty,
  label,
}: MarketsListProps) {
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
      width: number,
    ): TableColumn<Entry> => ({
      id,
      header,
      numeric: true,
      sortable: true,
      sortType: 'decimal',
      width,
      value: read,
      cell,
    });
    const price = (id: string, header: string, key: 'last' | 'bid' | 'ask' | 'high24h' | 'low24h') =>
      figure(
        id,
        header,
        ({ ticker }) => ticker?.[key] ?? null,
        ({ market, ticker }) => priceText(market, ticker?.[key]),
        PRICE_WIDTH,
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
      width: pro ? 220 : 280,
      value: ({ market }) => `${market.base}/${market.quote}`,
      cell: (entry) => {
        const { market } = entry;
        const full = assetName(market.base, copy);
        return (
          <span className="mkt-namecell">
            <FavoriteStar asset={market.base} favorite={favorite(market)} />
            <CoinIcon asset={market.base} size={dense ? 24 : 32} />
            <span className="mkt-name">
              <span data-testid="mkt-name__ticker" className="mkt-name__ticker">
                {market.base}
                <span data-testid="mkt-name__quote" className="mkt-muted mkt-name__quote">
                  /{market.quote}
                </span>
              </span>
              {full && !dense ? (
                <span data-testid="mkt-name__full" className="mkt-name__full">
                  {full}
                </span>
              ) : null}
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
      LAST_WIDTH,
    );
    const change = figure(
      'change',
      t('24h change'),
      ({ ticker }) => ticker?.changePct24h ?? null,
      (entry) => (
        <span className="mkt-stack">
          <Pct value={fmtPct(entry.ticker?.changePct24h)} arrow />
          {sinceOf(entry) ? (
            <span data-testid="mkt-since" className="mkt-since">
              {sinceOf(entry)}
            </span>
          ) : null}
        </span>
      ),
      WIDE_WIDTH,
    );
    const spread = figure(
      'spread',
      t('Spread'),
      ({ ticker }) => spreadRatio(ticker),
      ({ ticker }) => spreadText(ticker),
      SPREAD_WIDTH,
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
          {sinceOf(entry) ? (
            <span data-testid="mkt-since" className="mkt-since">
              {sinceOf(entry)}
            </span>
          ) : null}
        </span>
      ),
      WIDE_WIDTH,
    );
    const chart: TableColumn<Entry> = {
      id: 'chart',
      header: t('Last 24h'),
      width: CHART_WIDTH,
      cell: ({ market, ticker }) => (
        <SparkCell symbol={market.symbol} height={dense ? 24 : 32} trend={direction(ticker?.changePct24h) ?? 'flat'} />
      ),
    };
    const status: TableColumn<Entry> = {
      id: 'status',
      header: t('Status'),
      width: STATUS_WIDTH,
      cell: (entry) => {
        const state = rowStatus(!isPaused(entry), statuses?.[entry.market.symbol]);
        if (state.kind === 'closed')
          return (
            <span className="mkt-stack" data-start="">
              <Badge tone="warn" density={dense ? 'dense' : 'comfortable'}>
                {t('Closed')}
              </Badge>
              {state.opensAt !== null ? (
                <span data-testid="mkt-since" className="mkt-since">
                  {t('Opens {time}', { time: opensLabel(state.opensAt, timeZone) })}
                </span>
              ) : null}
            </span>
          );
        return state.kind === 'paused' ? (
          <Badge tone="warn" density={dense ? 'dense' : 'comfortable'}>
            {t('Paused')}
          </Badge>
        ) : (
          <Badge tone="lime" density={dense ? 'dense' : 'comfortable'}>
            {t('Open')}
          </Badge>
        );
      },
    };
    const action: TableColumn<Entry> = {
      id: 'action',
      header: '',
      headerLabel: t('Action'),
      align: 'end',
      width: ACTION_WIDTH,
      cell: (entry) => {
        const { market } = entry;
        const text = pro ? t('Trade') : t('Buy');
        const aria = pro ? t('Trade {pair}', { pair: `${market.base}/${market.quote}` }) : t('Buy {asset}', { asset: market.base });
        const size = dense ? 28 : 32;
        const pair = `${market.base}/${market.quote}`;
        const more = (
          <Menu>
            <MenuTrigger
              render={
                <Button variant="ghost" size={size} className="w-7 shrink-0 px-0" aria-label={t('More actions for {pair}', { pair })} />
              }
            >
              <Ellipsis size={16} aria-hidden="true" />
            </MenuTrigger>
            <MenuContent align="end">
              <MenuLinkItem href={convertHref(market)}>{t('Convert')}</MenuLinkItem>
            </MenuContent>
          </Menu>
        );
        const wrap = (button: ReactNode) => (
          <span className="mkt-actions">
            {button}
            {more}
          </span>
        );
        if (isPaused(entry))
          // Disabled but still reachable by keyboard, so the reason can be read (title for the pointer, aria-describedby for readers).
          return wrap(
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
            </Button>,
          );
        return wrap(
          <Button
            variant="secondary"
            size={size}
            nativeButton={false}
            render={<a href={marketTarget(market, mode, isHiddenPath, signedIn)} />}
            aria-label={aria}
          >
            {text}
          </Button>,
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
  }, [pro, dense, mode, signedIn, favorite, timeZone, pausedNote, statuses, copy.renderedLocale]);

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
        minWidth={pro ? PRO_MIN_WIDTH : SIMPLE_MIN_WIDTH}
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
