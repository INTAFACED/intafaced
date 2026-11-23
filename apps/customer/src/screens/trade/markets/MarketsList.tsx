import { createContext, useContext, useId, useMemo, useState, type ReactNode } from 'react';
import { ArrowLeftRight, Star } from 'lucide-react';
import { AssetIcon, Button, GridTable, Tag, type GridColumn } from '@intafaced/ui/lit';
import { sortRows, Sparkline, type SortState } from '@intafaced/ui/lit/templates';
import { assetName, marketsCopy } from './copy';
import { direction, isHiddenPath, navigate, useSparklines, type Decimal, type MarketData } from './deps';
import { Pct } from './parts';
import { isAnnounced, isPaused, marketTarget, priceText, spreadRatio, spreadText, volumeText, type Entry, type Mode } from './select';
import { isSessionShut, opensLabel, rowStatus, type ListingStatusMap } from './listing-status';
import { maintenanceWhen, type MaintenanceWindowSoon } from '../../../shared/market-maintenance';
import { ianaZone, partialWindowStart, sinceLabel } from './window';
import { usePreferences } from '../../../shared/preferences';
import type { Density } from './view-state';
import type { FavoriteControl } from './MarketRow';

/** Rows drawn at first, and added by each "Show more"; sparklines are read for the rows drawn only. */
const PAGE_SIZE = 50;

/** Convert opens with the pair filled in (it reads `from` and `to`): pay in the quote, get the coin. */
const convertHref = (market: MarketData) => `/trade/convert?from=${encodeURIComponent(market.quote)}&to=${encodeURIComponent(market.base)}`;

/** A click on the star must not open the row; the grid ignores clicks that start on a button or link. */
function FavoriteStar({ asset, favorite }: { asset: string; favorite: FavoriteControl }) {
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

/** Hourly closes by symbol, read once for the rows drawn and handed to the chart cells. */
const EMPTY: Record<string, Decimal[]> = {};
const SparkContext = createContext<Record<string, Decimal[]>>(EMPTY);

type Tone = 'up' | 'down' | 'neutral';

/** A row's state word (Open, Paused, Closed, Upcoming, Delisting) as the kit's tag. */
function StateTag({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <Tag tone={tone}>{children}</Tag>;
}

/** The upcoming-maintenance flag on a market's row (J-cex-spot-14 #5). */
function MaintenanceFlag({ window }: { window: MaintenanceWindowSoon }) {
  const { t } = marketsCopy.useCopy();
  const when = maintenanceWhen(window, Date.now());
  const text =
    when.kind === 'now'
      ? t('Maintenance now')
      : when.kind === 'hours'
        ? when.n === 1
          ? t('Maintenance in one hour')
          : t('Maintenance in hours', { n: when.n })
        : t('Maintenance in minutes', { n: when.n });
  return (
    <span data-testid="mkt-maintenance" className="lt-hint">
      {text}
    </span>
  );
}

/** "16 Nov 2026" in the person's zone: the day a delisting market leaves the board. */
function delistingDate(iso: string, zone: Parameters<typeof ianaZone>[0]): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: ianaZone(zone) }).format(
    Date.parse(iso),
  );
}

/** An upcoming or delisting listing's state on its row, with the delisting's date (J-cex-spot-14 #1). */
function ListingState({ market }: { market: MarketData }) {
  const { t } = marketsCopy.useCopy();
  const { timeZone } = usePreferences();
  if (market.listing === 'upcoming')
    return (
      <span data-testid="mkt-listing" data-listing="upcoming" className="lt-lines">
        <StateTag tone="neutral">{t('Upcoming')}</StateTag>
      </span>
    );
  if (market.listing === 'delisting')
    return (
      <span data-testid="mkt-listing" data-listing="delisting" className="lt-lines">
        <StateTag tone="down">{t('Delisting')}</StateTag>
        {market.delistsAt ? (
          <span className="lt-hint">{t('Leaves the board on {date}', { date: delistingDate(market.delistsAt, timeZone) })}</span>
        ) : null}
      </span>
    );
  return null;
}

function SparkCell({ symbol, label, trend }: { symbol: string; label: string; trend: Tone }) {
  return <Sparkline label={label} values={useContext(SparkContext)[symbol] ?? []} tone={trend} size="row" />;
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

/** A sortable column's reading, for `sortRows`: figures compare as decimals, the name as text. */
interface SortSpec {
  id: string;
  sortType: 'text' | 'decimal';
  value: (entry: Entry) => string | null;
}

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

  const { columns, sorting } = useMemo(() => {
    const sorting: SortSpec[] = [];
    const figure = (
      key: string,
      header: string,
      read: (entry: Entry) => string | null,
      cell: (entry: Entry) => ReactNode,
    ): GridColumn<Entry> => {
      sorting.push({ id: key, sortType: 'decimal', value: read });
      return {
        key,
        label: header,
        align: 'end',
        sortType: 'decimal',
        sortLabel: t('Sort by {column}', { column: header }),
        headMarks: { 'data-col': key },
        cellMarks: () => ({ 'data-col': key, 'data-cell': key }),
        cell,
      };
    };
    const plain = (key: string, header: string, cell: (entry: Entry) => ReactNode): GridColumn<Entry> => ({
      key,
      label: header,
      headMarks: { 'data-col': key },
      cellMarks: () => ({ 'data-col': key, 'data-cell': key }),
      cell,
    });
    const price = (key: string, header: string, field: 'last' | 'bid' | 'ask' | 'high24h' | 'low24h') =>
      figure(
        key,
        header,
        ({ ticker }) => ticker?.[field] ?? null,
        ({ market, ticker }) => (
          <span className="lt-num" dir="ltr">
            {priceText(market, ticker?.[field])}
          </span>
        ),
      );
    // A market younger than a day: its "24h" figures start later. Said on its own row, so the headers stay true for the rest.
    const sinceOf = (entry: Entry) => {
      const start = partialWindowStart(entry.ticker, Date.now());
      return start === null ? null : t('since {time}', { time: sinceLabel(start, timeZone) });
    };
    const since = (entry: Entry) =>
      sinceOf(entry) ? (
        <span data-testid="mkt-since" className="lt-hint">
          {sinceOf(entry)}
        </span>
      ) : null;

    sorting.push({ id: 'name', sortType: 'text', value: ({ market }) => `${market.base}/${market.quote}` });
    const name: GridColumn<Entry> = {
      key: 'name',
      label: t('Name'),
      sortType: 'text',
      sortLabel: t('Sort by {column}', { column: t('Name') }),
      headMarks: { 'data-col': 'name' },
      cellMarks: () => ({ 'data-col': 'name', 'data-cell': 'name' }),
      cell: (entry) => {
        const { market } = entry;
        const full = assetName(market.base, copy);
        const pair = (
          <>
            <span data-testid="mkt-name__ticker">
              {market.base}
              <span data-testid="mkt-name__quote" className="lt-muted">
                /{market.quote}
              </span>
            </span>
            {full && !dense ? (
              <span data-testid="mkt-name__full" className="lt-hint">
                {full}
              </span>
            ) : null}
          </>
        );
        return (
          <span className="lt-cell-name">
            <FavoriteStar asset={market.base} favorite={favorite(market)} />
            <AssetIcon asset={market.base} size={dense ? 'sm' : 'md'} />
            <span className="lt-lines">
              {/* An announced listing never trades, so its name opens nothing; every other row's name is its link. */}
              {isAnnounced(market) ? (
                <span className="lt-lines">{pair}</span>
              ) : (
                <a className="lt-row-link" data-row-link="" href={marketTarget(market, mode, isHiddenPath, signedIn)}>
                  <span className="lt-lines">{pair}</span>
                </a>
              )}
              <ListingState market={market} />
              {/* The simple list has no status column, so a shut session is named by the name, with when it opens (J-cex-spot-14 #6). */}
              {!pro && isSessionShut(statuses, market.symbol) ? (
                <span data-testid="mkt-session" className="lt-lines">
                  <StateTag tone="down">{t('Closed')}</StateTag>
                  {statuses?.[market.symbol]?.opensAt != null ? (
                    <span className="lt-hint">{t('Opens {time}', { time: opensLabel(statuses[market.symbol]!.opensAt!, timeZone) })}</span>
                  ) : null}
                </span>
              ) : null}
              {/* The simple list has no status column, so a maintenance window is flagged by the name (J-cex-spot-14 #5). */}
              {!pro && statuses?.[market.symbol]?.maintenance ? <MaintenanceFlag window={statuses[market.symbol]!.maintenance!} /> : null}
            </span>
          </span>
        );
      },
    };
    const last = figure(
      'last',
      t('Last'),
      ({ ticker }) => ticker?.last ?? null,
      ({ market, ticker }) => (
        <span data-slot="price" className="lt-num" dir="ltr">
          {priceText(market, ticker?.last)}
        </span>
      ),
    );
    const change = figure(
      'change',
      t('24h change'),
      ({ ticker }) => ticker?.changePct24h ?? null,
      (entry) => (
        <span className="lt-lines">
          <Pct value={entry.ticker?.changePct24h} />
          {since(entry)}
        </span>
      ),
    );
    const spread = figure(
      'spread',
      t('Spread'),
      ({ ticker }) => spreadRatio(ticker),
      ({ ticker }) => (
        <span className="lt-num" dir="ltr">
          {spreadText(ticker)}
        </span>
      ),
    );
    const volume = figure(
      'volume',
      t('24h volume'),
      ({ ticker }) => ticker?.quoteVolume24h ?? null,
      (entry) => (
        <span className="lt-lines">
          <span className="lt-num" data-slot="volume" dir="ltr">
            {volumeText(entry.market, entry.ticker)}
          </span>
          {since(entry)}
        </span>
      ),
    );
    const chart = plain('chart', t('Last 24h'), ({ market, ticker }) => (
      <SparkCell
        symbol={market.symbol}
        label={`${market.base}/${market.quote} ${t('Last 24h')}`}
        trend={(direction(ticker?.changePct24h) ?? 'flat') === 'flat' ? 'neutral' : (direction(ticker?.changePct24h) as Tone)}
      />
    ));
    const status = plain('status', t('Status'), (entry) => {
      const state = rowStatus(!isPaused(entry), statuses?.[entry.market.symbol]);
      const maintenance = statuses?.[entry.market.symbol]?.maintenance ?? null;
      const flag = maintenance ? <MaintenanceFlag window={maintenance} /> : null;
      if (state.kind === 'closed')
        return (
          <span className="lt-lines">
            <StateTag tone="down">{t('Closed')}</StateTag>
            {state.opensAt !== null ? (
              <span data-testid="mkt-since" className="lt-hint">
                {t('Opens {time}', { time: opensLabel(state.opensAt, timeZone) })}
              </span>
            ) : null}
            {flag}
          </span>
        );
      const tag = state.kind === 'paused' ? <StateTag tone="down">{t('Paused')}</StateTag> : <StateTag tone="up">{t('Open')}</StateTag>;
      return flag ? (
        <span className="lt-lines">
          {tag}
          {flag}
        </span>
      ) : (
        tag
      );
    });
    const action: GridColumn<Entry> = {
      key: 'action',
      label: t('Action'),
      quietLabel: true,
      align: 'end',
      headMarks: { 'data-col': 'action' },
      cellMarks: () => ({ 'data-col': 'action', 'data-cell': 'action' }),
      cell: (entry) => {
        const { market } = entry;
        const text = pro ? t('Trade') : t('Buy');
        const aria = pro ? t('Trade {pair}', { pair: `${market.base}/${market.quote}` }) : t('Buy {asset}', { asset: market.base });
        const pair = `${market.base}/${market.quote}`;
        const wrap = (button: ReactNode) => (
          <span className="lt-actions">
            {button}
            {/* The kit's row link centres the word on the button's line; the word itself is a link's. */}
            <a className="lt-row-link" href={convertHref(market)} aria-label={t('Convert {pair}', { pair })}>
              {/* Pro's twelve columns leave the word no room: its mark stands in, with the same name and a tooltip. */}
              {pro ? (
                <span className="lt-link" title={t('Convert')}>
                  <ArrowLeftRight size={16} aria-hidden="true" />
                </span>
              ) : (
                <span className="lt-link">{t('Convert')}</span>
              )}
            </a>
          </span>
        );
        // Not a tradeable row: the button says why (its title for the pointer), stays reachable by keyboard, and links nowhere.
        const refused = (title: string, describedBy?: string) =>
          wrap(
            <Button aria-disabled="true" aria-label={aria} aria-describedby={describedBy} title={title}>
              {text}
            </Button>,
          );
        if (isAnnounced(market))
          // An upcoming or delisting listing is never a tradeable row, and nothing links to a desk.
          return refused(market.listing === 'upcoming' ? t('This market has not opened for trading') : t('This market is being delisted'));
        if (isSessionShut(statuses, market.symbol))
          // A shut session is never a tradeable row: an order now is refused and not queued (J-cex-spot-14 #6).
          return refused(t('This market is closed. Orders are not queued while it is closed'));
        if (isPaused(entry)) return refused(t('Orders are paused on this market'), pausedNote);
        return wrap(
          <a
            className="lt-button lt-button-secondary"
            role="button"
            href={marketTarget(market, mode, isHiddenPath, signedIn)}
            aria-label={aria}
          >
            {text}
          </a>,
        );
      },
    };
    const columns = pro
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
    return { columns, sorting };
    // `copy` changes only with the language.
  }, [pro, dense, mode, signedIn, favorite, timeZone, pausedNote, statuses, copy.renderedLocale]);

  const sorted = useMemo(() => sortRows(entries, sorting, sort), [entries, sorting, sort]);
  const shown = useMemo(() => sorted.slice(0, limit), [sorted, limit]);
  const sparklines = useSparklines(useMemo(() => shown.map((entry) => entry.market.symbol), [shown]));
  const more = Math.min(PAGE_SIZE, sorted.length - shown.length);

  return (
    <SparkContext.Provider value={sparklines.status === 'ready' ? sparklines.data : EMPTY}>
      <GridTable
        caption={label}
        columns={columns}
        rows={shown}
        rowKey={(entry) => entry.market.symbol}
        mode={mode}
        loadingRows={loading ? 8 : undefined}
        pinFirst
        empty={<div data-testid="mkt-empty">{empty}</div>}
        sort={sort}
        onSort={(next) =>
          onSortChange(sort && sort.columnId === next.columnId && sort.direction !== firstDirection(next.columnId) ? null : next)
        }
        onRowActivate={(entry) => {
          if (!isAnnounced(entry.market)) navigate(marketTarget(entry.market, mode, isHiddenPath, signedIn));
        }}
        rowMarks={(entry) => ({ 'data-testid': 'mkt-row', 'data-symbol': entry.market.symbol })}
        headMarks={{ 'data-testid': 'mkt-header' }}
      />
      <span id={pausedNote} className="lt-sr">
        {t('Orders are paused on this market')}
      </span>
      {more > 0 ? (
        <div className="lt-toolbar">
          <span className="lt-hint">{t('Showing {shown} of {total} markets', { shown: shown.length, total: sorted.length })}</span>
          <Button onClick={() => setLimit(limit + PAGE_SIZE)}>{t('Show {count} more markets', { count: more })}</Button>
        </div>
      ) : null}
    </SparkContext.Provider>
  );
}
