import { createContext, useContext, useId, useMemo, useState, type ReactNode } from 'react';
import { Star } from 'lucide-react';
import { AssetIcon, Button, GridTable, Tag, type GridColumn } from '@intafaced/ui/lit';
import { sortRows, Sparkline, type SortState } from '@intafaced/ui/lit/templates';
import { assetName, marketsCopy } from './copy';
import { direction, isHiddenPath, navigate, useSparklines, type Decimal, type MarketData } from './deps';
import { Pct } from './parts';
import {
  displayName,
  entryTarget,
  interestText,
  isAnnounced,
  isPaused,
  isPerp,
  leverageText,
  priceText,
  spreadRatio,
  spreadText,
  volumeText,
  type Entry,
  type Mode,
} from './select';
import { isSessionShut, opensLabel, rowStatus, type ListingStatusMap } from './listing-status';
import { maintenanceWhen, type MaintenanceWindowSoon } from '../../../shared/market-maintenance';
import { ianaZone, partialWindowStart, sinceLabel } from './window';
import { usePreferences } from '../../../shared/preferences';
import type { Density } from './view-state';
import type { FavoriteControl } from './MarketRow';

/** Rows drawn at first, and added by each "Show more"; sparklines are read for the rows drawn only. */
const PAGE_SIZE = 50;

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

/** The row's day as a line; with no history, an empty cell the column keeps its width for, named for a screen reader. */
function SparkCell({ symbol, label, trend }: { symbol: string; label: string; trend: Tone }) {
  const { t } = marketsCopy.useCopy();
  const values = useContext(SparkContext)[symbol] ?? [];
  if (values.length < 2) return <span className="lt-sr">{t('No price history')}</span>;
  return <Sparkline label={label} values={values} tone={trend} size="row" />;
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
  // Funding and open interest are a perpetual's figures: their columns show where a perpetual is listed.
  const withPerps = useMemo(() => entries.some(isPerp), [entries]);
  const dense = density === 'compact';
  // A perpetual opens the futures desk and is traded, never bought; a spot market opens its desk or coin page.
  const targetOf = (entry: Entry) => entryTarget(entry, mode, isHiddenPath, signedIn);

  const { columns, sorting } = useMemo(() => {
    const targetOf = (entry: Entry) => entryTarget(entry, mode, isHiddenPath, signedIn);
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
    const unsortedColumn = (key: string, header: string, cell: (entry: Entry) => ReactNode): GridColumn<Entry> => ({
      key,
      label: header,
      headMarks: { 'data-col': key },
      cellMarks: () => ({ 'data-col': key, 'data-cell': key }),
      cell,
    });
    // Two figures of one kind in one column, one over the other (bid over ask, high over low), so Pro's columns fit a
    // laptop's width without scrolling. The column sorts by its upper figure.
    const pricePair = (
      key: string,
      header: string,
      upper: { field: 'bid' | 'high24h'; label: string },
      lower: { field: 'ask' | 'low24h'; label: string },
    ) =>
      figure(
        key,
        header,
        ({ ticker }) => ticker?.[upper.field] ?? null,
        ({ market, ticker }) => (
          <span className="lt-lines">
            <span className="lt-num" dir="ltr" data-slot={upper.field}>
              <span className="lt-sr">{upper.label} </span>
              {priceText(market, ticker?.[upper.field])}
            </span>
            <span className="lt-num lt-muted" dir="ltr" data-slot={lower.field}>
              <span className="lt-sr">{lower.label} </span>
              {priceText(market, ticker?.[lower.field])}
            </span>
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

    sorting.push({ id: 'name', sortType: 'text', value: displayName });
    const name: GridColumn<Entry> = {
      key: 'name',
      label: t('Market'),
      sortType: 'text',
      sortLabel: t('Sort by {column}', { column: t('Market') }),
      headMarks: { 'data-col': 'name' },
      cellMarks: () => ({ 'data-col': 'name', 'data-cell': 'name' }),
      cell: (entry) => {
        const { market } = entry;
        const target = targetOf(entry);
        const full = assetName(market.base, copy);
        const perp = isPerp(entry);
        const pair = (
          <>
            <span className="lt-market-name">
              <span data-testid="mkt-name__ticker">
                {market.base}
                <span data-testid="mkt-name__quote" className="lt-muted">
                  {perp ? '-PERP' : `/${market.quote}`}
                </span>
              </span>
              {/* Spot or the contract's leverage, as the pick; a perpetual whose maximum is not published says Perp. */}
              <Tag tone="neutral" data-testid="mkt-kind">
                {perp ? (leverageText(entry.perp) ?? t('Perp')) : t('Spot')}
              </Tag>
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
              {/* An announced listing never trades, and a row with nowhere shown to go (the beta's build without the desk) opens
                  nothing, so its name is plain words; every other row's name is its link. */}
              {isAnnounced(market) || target === null ? (
                <span className="lt-lines">{pair}</span>
              ) : (
                <a className="lt-row-link" data-row-link="" href={target}>
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
      t('Price'),
      ({ ticker }) => ticker?.last ?? null,
      ({ market, ticker }) => (
        <span data-slot="price" className="lt-num" dir="ltr">
          {priceText(market, ticker?.last)}
        </span>
      ),
    );
    const change = figure(
      'change',
      t('24h'),
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
      t('Volume 24h'),
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
    // A perpetual's funding and open interest; a spot row has neither and reads "—".
    const funding = figure(
      'funding',
      t('Funding 1h'),
      ({ perp }) => perp?.funding1h ?? null,
      ({ perp }) => <Pct value={perp?.funding1h} places={4} />,
    );
    const interest = figure(
      'interest',
      t('Open interest'),
      ({ perp }) => perp?.openInterest ?? null,
      ({ market, perp }) => (
        <span className="lt-num" dir="ltr">
          {interestText(market, perp)}
        </span>
      ),
    );
    const chart = unsortedColumn('chart', t('Last 24h'), (entry) => (
      <SparkCell
        symbol={entry.market.symbol}
        label={`${displayName(entry)} ${t('Last 24h')}`}
        trend={(direction(entry.ticker?.changePct24h) ?? 'flat') === 'flat' ? 'neutral' : (direction(entry.ticker?.changePct24h) as Tone)}
      />
    ));
    const status = unsortedColumn('status', t('Status'), (entry) => {
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
        const perp = isPerp(entry);
        const text = pro || perp ? t('Trade') : t('Buy');
        const aria = perp
          ? t('Trade {pair}', { pair: displayName(entry) })
          : pro
            ? t('Trade {pair}', { pair: `${market.base}/${market.quote}` })
            : t('Buy {asset}', { asset: market.base });
        const wrap = (button: ReactNode) => <span className="lt-actions">{button}</span>;
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
        const target = targetOf(entry);
        if (target === null) return wrap(null);
        return wrap(
          <a className="lt-button lt-button-secondary" role="button" href={target} aria-label={aria}>
            {text}
          </a>,
        );
      },
    };
    const perpColumns = withPerps ? [funding, interest] : [];
    const columns = pro
      ? [
          name,
          last,
          change,
          pricePair('bid', t('Bid / Ask'), { field: 'bid', label: t('Bid') }, { field: 'ask', label: t('Ask') }),
          spread,
          pricePair('high', t('24h high / low'), { field: 'high24h', label: t('24h high') }, { field: 'low24h', label: t('24h low') }),
          volume,
          ...perpColumns,
          chart,
          status,
          action,
        ]
      : [name, last, change, chart, volume, ...perpColumns, action];
    // On a phone a market is one tappable line: its name, then its price over its 24h move; the row itself opens it.
    // On a computer the row's action shows on the row pointed at, as landing's markets panel.
    const PHONE: Record<string, GridColumn<Entry>['phone']> = {
      name: 'name',
      last: 'top',
      change: 'bottom',
      chart: 'hide',
      volume: 'hide',
      action: 'hide',
    };
    const placed = columns.map((column) => ({ ...column, phone: PHONE[column.key], reveal: column.key === 'action' || undefined }));
    return { columns: placed, sorting };
    // `copy` changes only with the language.
  }, [pro, withPerps, dense, mode, signedIn, favorite, timeZone, pausedNote, statuses, copy.renderedLocale]);

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
          const target = isAnnounced(entry.market) ? null : targetOf(entry);
          if (target !== null) navigate(target);
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
