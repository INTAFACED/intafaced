import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Search } from 'lucide-react';
import './markets.css';
import { assetName, marketsCopy } from './copy';
import {
  Button,
  EmptyState,
  Input,
  refusalCopy,
  SegmentedControl,
  StateBlock,
  StatusChip,
  Tabs,
  TabsList,
  TabsTab,
  ToggleGroup,
  ToggleGroupItem,
  useFavorites,
  useMarkets,
  useTickers,
  type Loadable,
  type MarketData,
  type SortState,
  type TickerRow,
} from './deps';
import { isSeparateFromSpot, useListingStatus } from './listing-status';
import { MarketsList } from './MarketsList';
import type { FavoriteControl } from './MarketRow';
import { TopCards, TopCardsSkeleton } from './TopCards';
import { anyListed, entriesFor, isPaused, quotesOf, topCards, visibleEntries, type CardId, type Chip } from './select';
import {
  applyAddress,
  browserStorage,
  clearView,
  DEFAULT_VIEW,
  isDefaultView,
  isSortColumn,
  queryFromAddress,
  readView,
  viewKey,
  writeView,
  type Density,
  type ViewState,
} from './view-state';
import { ianaZone } from './window';
import { useSession } from '../../../features/session/session';
import { usePreferences } from '../../../shared/preferences';
import type { ScreenProps } from '../../../app/screen-types';

const CHIPS: readonly Chip[] = ['all', 'gainers', 'losers', 'new'];
/** Prices older than this read Stale (they are polled every 10 s). */
const STALE_AFTER_MS = 30_000;

export default function TradeMarketsScreen({ path, search }: ScreenProps) {
  const copy = marketsCopy.useCopy();
  const { t } = copy;
  const { layoutMode } = usePreferences();
  const { userId } = useSession();
  const { favorites, isFavorite, toggle } = useFavorites(userId);
  // Paused markets are the ones the service lists as not orderable, so the list asks for them too and filters here.
  const markets = useMarkets({ includeClosed: true });
  const tickers = useTickers();
  // Which listed markets are their own group (FX) and which are shut for the session; null if that read fails.
  const statuses = useListingStatus();

  const storageKey = viewKey(userId);
  const [view, setView] = useState<ViewState>(() => applyAddress(readView(browserStorage(), storageKey), search));
  const [query, setQuery] = useState(() => queryFromAddress(search));
  const tableTop = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);

  /** A change the person made: kept for next time. */
  const change = (patch: Partial<ViewState>) => {
    const next = { ...view, ...patch };
    setView(next);
    writeView(browserStorage(), storageKey, next);
  };

  // `/` jumps to the search box unless the person is already typing in a field.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
      event.preventDefault();
      searchInput.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const tickerMap = tickers.status === 'ready' ? tickers.data : undefined;
  const everyEntry = useMemo(
    () =>
      markets.status === 'ready'
        ? entriesFor(
            markets.data.filter((market) => !isSeparateFromSpot(statuses, market.symbol)),
            tickerMap,
            { includePaused: true },
          )
        : [],
    [markets, tickerMap, statuses],
  );
  const openEntries = useMemo(() => everyEntry.filter((entry) => !isPaused(entry)), [everyEntry]);
  const hasPaused = openEntries.length < everyEntry.length;
  const pool = view.status === 'open' ? openEntries : everyEntry;
  const quotes = useMemo(() => quotesOf(pool.map((entry) => entry.market)), [pool]);
  const showNew = useMemo(() => anyListed(pool), [pool]);

  // A saved choice the data no longer offers (a currency that left, no listing dates) is not applied.
  const quote = quotes.length > 1 && view.quote && quotes.includes(view.quote) ? view.quote : null;
  const chip: Chip = view.chip === 'new' && !showNew ? 'all' : view.chip;
  const density: Density = view.density ?? (layoutMode === 'pro' ? 'compact' : 'comfortable');
  const sort: SortState | null = view.sort;

  const rows = useMemo(
    () => visibleEntries(pool, { tab: view.tab, chip, quote, query, sort: null, favorites }, (base) => assetName(base, copy)),
    // `copy` changes only with the language.
    [pool, view.tab, chip, quote, query, favorites, copy.renderedLocale],
  );
  // Cards are all prices and changes: without prices they would be rows of dashes, so they wait for them.
  const cards = useMemo(() => (tickerMap ? topCards(openEntries) : []), [openEntries, tickerMap]);

  const signedIn = userId != null;
  const signIn = `/login?redirect=${encodeURIComponent(path + search)}`;
  const favorite = useCallback(
    (market: MarketData): FavoriteControl =>
      signedIn ? { on: isFavorite(market.symbol), onToggle: () => toggle(market.symbol) } : { signInHref: signIn },
    [signedIn, isFavorite, toggle, signIn],
  );

  const seeAll = (id: CardId) => {
    // Looking at a card's full list is not a saved choice.
    setView((current) => ({
      ...current,
      tab: 'spot',
      chip: id === 'new' ? 'new' : id === 'gainers' ? 'gainers' : 'all',
      quote: null,
      sort: id === 'popular' ? { columnId: 'volume', direction: 'desc' } : null,
    }));
    setQuery('');
    tableTop.current?.scrollIntoView({ block: 'start' });
  };
  const resetView = () => {
    clearView(browserStorage(), storageKey);
    setView({ ...DEFAULT_VIEW });
  };
  const changeSort = (next: SortState | null) =>
    change({ sort: next && isSortColumn(next.columnId) ? { columnId: next.columnId, direction: next.direction } : null });

  const meta = <Freshness tickers={tickers} />;
  const marketsLoading = markets.status === 'loading' || (markets.status === 'ready' && tickers.status === 'loading');

  if (markets.status === 'error')
    return (
      <Frame meta={meta}>
        <StateBlock kind="error" title={t('Couldn’t load markets')} onRetry={markets.retry} retryLabel={t('Try again')} />
      </Frame>
    );
  if (markets.status === 'refused') {
    const refused = refusalCopy(markets.code);
    return (
      <Frame meta={meta}>
        <EmptyState variant="refused" title={refused.title} reason={refused.body} code={markets.code} action={refused.action} size="page" />
      </Frame>
    );
  }
  if (markets.status === 'empty')
    return (
      <Frame meta={meta}>
        <EmptyState title={t('No markets are open right now.')} size="page" />
      </Frame>
    );

  const showPaused =
    hasPaused && view.status === 'open' ? { label: t('Include paused'), onClick: () => change({ status: 'all' }) } : undefined;
  const empty = (() => {
    if (view.tab === 'favorites' && favorites.length === 0)
      return signedIn ? (
        <EmptyState
          title={t('Star a market to keep it here.')}
          action={{ label: t('Browse markets'), onClick: () => change({ tab: 'spot' }) }}
        />
      ) : (
        <EmptyState title={t('Log in to keep your favorites here.')} action={{ label: t('Log in'), href: signIn }} />
      );
    if (query.trim())
      return (
        <EmptyState
          title={t('No markets match “{query}”.', { query: query.trim() })}
          action={{ label: t('Clear search'), onClick: () => setQuery('') }}
        />
      );
    if (chip === 'gainers') return <EmptyState title={t('Nothing is gaining right now.')} />;
    if (chip === 'losers') return <EmptyState title={t('Nothing is falling right now.')} />;
    if (chip === 'new') return <EmptyState title={t('No new listings.')} />;
    return (
      <EmptyState
        title={view.tab === 'favorites' ? t('Star a market to keep it here.') : t('No markets are open right now.')}
        action={showPaused}
      />
    );
  })();

  return (
    <Frame meta={meta}>
      {marketsLoading ? <TopCardsSkeleton /> : cards.length > 0 ? <TopCards cards={cards} mode={layoutMode} onSeeAll={seeAll} /> : null}

      <div data-testid="mkt-tabs" className="mkt-tabs" ref={tableTop}>
        <Tabs value={view.tab} onValueChange={(value) => change({ tab: value === 'favorites' ? 'favorites' : 'spot' })}>
          <TabsList className="mkt-tabs__list">
            <TabsTab value="favorites" className="mkt-tab">
              {t('Favorites')}
            </TabsTab>
            <TabsTab value="spot" className="mkt-tab">
              {t('Spot')}
            </TabsTab>
          </TabsList>
        </Tabs>
        <Input
          ref={searchInput}
          className="mkt-search"
          value={query}
          onValueChange={setQuery}
          placeholder={t('Search by coin or name')}
          aria-label={t('Search markets')}
          leading={<Search size={16} aria-hidden="true" />}
          onKeyDown={(event) => event.key === 'Escape' && setQuery('')}
        />
      </div>

      <div data-testid="mkt-chips" className="mkt-chips">
        <ToggleGroup
          value={chip}
          onValueChange={(value) => change({ chip: CHIPS.find((item) => item === value) ?? 'all' })}
          aria-label={t('Filter by change')}
        >
          {CHIPS.filter((value) => value !== 'new' || showNew).map((value) => (
            <ToggleGroupItem key={value} value={value}>
              {t(value === 'all' ? 'All' : value === 'gainers' ? 'Gainers' : value === 'losers' ? 'Losers' : 'New')}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {quotes.length > 1 ? (
          <>
            <span className="mkt-chips__divider" aria-hidden="true" />
            <ToggleGroup value={quote ?? ''} onValueChange={(value) => change({ quote: value })} aria-label={t('Filter by currency')}>
              {quotes.map((value) => (
                // Pressing the chosen currency again turns the filter off.
                <ToggleGroupItem key={value} value={value} onClick={() => quote === value && change({ quote: null })}>
                  {value}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </>
        ) : null}
        <div className="mkt-chips__end">
          {!isDefaultView(view, layoutMode === 'pro' ? 'compact' : 'comfortable') ? (
            <Button variant="ghost" size={28} onClick={resetView}>
              {t('Reset view')}
            </Button>
          ) : null}
          {hasPaused || view.status === 'all' ? (
            <SegmentedControl
              aria-label={t('Filter by status')}
              items={[
                { value: 'open', label: t('Open only') },
                { value: 'all', label: t('Include paused') },
              ]}
              value={view.status}
              onValueChange={(value) => change({ status: value === 'all' ? 'all' : 'open' })}
            />
          ) : null}
          <SegmentedControl
            aria-label={t('Row size')}
            items={[
              { value: 'comfortable', label: t('Comfortable') },
              { value: 'compact', label: t('Compact') },
            ]}
            value={density}
            onValueChange={(value) => change({ density: value === 'compact' ? 'compact' : 'comfortable' })}
          />
        </div>
      </div>

      {tickers.status === 'error' ? (
        <div data-testid="mkt-notice" className="mkt-notice" role="status">
          <span>{t('Couldn’t load prices')}</span>
          <Button variant="ghost" size={28} onClick={tickers.retry}>
            {t('Try again')}
          </Button>
        </div>
      ) : tickers.status === 'refused' ? (
        <div data-testid="mkt-notice" className="mkt-notice" role="status">
          <span>
            {t('Couldn’t load prices')} {refusalCopy(tickers.code).title}. {refusalCopy(tickers.code).body}{' '}
            <span className="mkt-muted">{tickers.code}</span>
          </span>
        </div>
      ) : null}

      <MarketsList
        label={t('Markets')}
        entries={rows}
        mode={layoutMode}
        density={density}
        sort={sort}
        onSortChange={changeSort}
        favorite={favorite}
        signedIn={signedIn}
        statuses={statuses}
        loading={marketsLoading}
        empty={empty}
      />
    </Frame>
  );
}

/** The freshness of the prices on screen, from the ticker read's own time (UI-SPEC TRD-0079). */
function Freshness({ tickers }: { tickers: Loadable<Record<string, TickerRow>> }) {
  const { t } = marketsCopy.useCopy();
  const { timeZone } = usePreferences();
  if (tickers.status === 'refused') return <StatusChip refused staleAfterMs={STALE_AFTER_MS} reason={refusalCopy(tickers.code).title} />;
  if (tickers.status === 'ready')
    return <StatusChip asOf={tickers.asOf} staleAfterMs={STALE_AFTER_MS} showAsOf asOfLabel={t('as of')} timeZone={ianaZone(timeZone)} />;
  return (
    <StatusChip
      asOf={null}
      staleAfterMs={STALE_AFTER_MS}
      reason={tickers.status === 'error' ? t('Prices could not be loaded') : t('Prices have not arrived')}
    />
  );
}

function Frame({ children, meta }: { children: ReactNode; meta: ReactNode }) {
  const { t } = marketsCopy.useCopy();
  return (
    <div data-testid="if-markets" className="if-markets">
      <header className="mkt-page__head">
        <h1>{t('Markets')}</h1>
        {meta}
      </header>
      {children}
    </div>
  );
}
