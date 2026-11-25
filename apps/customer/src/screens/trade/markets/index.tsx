// volt-room: /trade
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Search } from 'lucide-react';
import { Button, FreshnessTag, SearchField, Segmented, StatusNote, ToggleChips } from '@intafaced/ui/lit';
import { CatalogueTemplate, TabList, type SortState } from '@intafaced/ui/lit/templates';
import { assetName, marketsCopy } from './copy';
import {
  refusalCopy,
  useFavorites,
  useMarkets,
  useTickers,
  useVenueMarketStates,
  venueListingStatuses,
  venueMarketRow,
  isHiddenPath,
  type Loadable,
  type MarketData,
  type TickerRow,
} from './deps';
import { pickSource } from './source';
import { KitState } from '../kit-parts';
import { isSeparateFromSpot, useListingStatus } from './listing-status';
import { MarketsList } from './MarketsList';
import type { FavoriteControl } from './MarketRow';
import { Board, BoardSkeleton } from './Board';
import './markets.css';
import { TradeAccess } from './TradeAccess';
import { anyListed, entriesFor, isAnnounced, isPaused, quotesOf, visibleEntries, type Chip } from './select';
import {
  applyAddress,
  browserStorage,
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
  const ownMarkets = useMarkets({ includeClosed: true });
  const ownTickers = useTickers();
  // Where the venue door is on, the list is the venue's markets we show, each in the venue's own state with our listing
  // beside it (J-cex-spot-14 #1), and never our own book's; where it is off, today's read stands.
  const venueStates = useVenueMarketStates();
  const { markets, tickers } = useMemo(() => pickSource(venueStates, ownMarkets, ownTickers), [venueStates, ownMarkets, ownTickers]);
  // Which listed markets are their own group (FX) and which are shut for the session; null if that read fails.
  const ownStatuses = useListingStatus();
  const statuses = useMemo(
    () => (venueStates.status === 'ready' ? venueListingStatuses(venueStates.data) : ownStatuses),
    [venueStates, ownStatuses],
  );

  const storageKey = viewKey(userId);
  const [view, setView] = useState<ViewState>(() => applyAddress(readView(browserStorage(), storageKey), search));
  const [query, setQuery] = useState(() => queryFromAddress(search));
  const tableTop = useRef<HTMLDivElement>(null);
  const searchId = useId();

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
      document.getElementById(searchId)?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [searchId]);

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
  // Upcoming and delisting listings stay on the list with their state named (J-cex-spot-14 #1); they never trade.
  const openEntries = useMemo(() => everyEntry.filter((entry) => !isPaused(entry) || isAnnounced(entry.market)), [everyEntry]);
  const hasPaused = openEntries.length < everyEntry.length;
  // The venue's perpetuals, on their own tab (the Markets list's default tab stays spot only, J-cex-spot-14 #1).
  const perpEntries = useMemo(
    () =>
      venueStates.status === 'ready'
        ? entriesFor(venueStates.data.value.markets.filter((m) => m.kind === 'perpetual').map(venueMarketRow), undefined, {
            includePaused: true,
          })
        : [],
    [venueStates],
  );
  const tab = view.tab === 'perps' && perpEntries.length === 0 ? 'spot' : view.tab;
  const pool = tab === 'perps' ? perpEntries : view.status === 'open' ? openEntries : everyEntry;
  const quotes = useMemo(() => quotesOf(pool.map((entry) => entry.market)), [pool]);
  const showNew = useMemo(() => anyListed(pool), [pool]);

  // A saved choice the data no longer offers (a currency that left, no listing dates) is not applied.
  const quote = quotes.length > 1 && view.quote && quotes.includes(view.quote) ? view.quote : null;
  const chip: Chip = view.chip === 'new' && !showNew ? 'all' : view.chip;
  const density: Density = view.density ?? (layoutMode === 'pro' ? 'compact' : 'comfortable');
  const sort: SortState | null = view.sort;

  const rows = useMemo(
    () => visibleEntries(pool, { tab, chip, quote, query, sort: null, favorites }, (base) => assetName(base, copy)),
    // `copy` changes only with the language.
    [pool, tab, chip, quote, query, favorites, copy.renderedLocale],
  );
  const signedIn = userId != null;
  const signIn = `/login?redirect=${encodeURIComponent(path + search)}`;
  const favorite = useCallback(
    (market: MarketData): FavoriteControl =>
      signedIn ? { on: isFavorite(market.symbol), onToggle: () => toggle(market.symbol) } : { signInHref: signIn },
    [signedIn, isFavorite, toggle, signIn],
  );

  const changeSort = (next: SortState | null) =>
    change({ sort: next && isSortColumn(next.columnId) ? { columnId: next.columnId, direction: next.direction } : null });

  const meta = <Freshness tickers={tickers} />;
  const marketsLoading = markets.status === 'loading' || (markets.status === 'ready' && tickers.status === 'loading');

  if (markets.status === 'error')
    return (
      <Frame meta={meta}>
        <KitState kind="error" title={t('Couldn’t load markets')} onRetry={markets.retry} retryLabel={t('Try again')} />
      </Frame>
    );
  if (markets.status === 'refused') {
    const refused = refusalCopy(markets.code);
    return (
      <Frame meta={meta}>
        <KitState
          kind="refused"
          title={refused.title}
          body={refused.body}
          code={markets.code}
          action={refused.action ? { label: refused.action.label, href: refused.action.href } : undefined}
        />
      </Frame>
    );
  }
  if (markets.status === 'empty')
    return (
      <Frame meta={meta}>
        <KitState kind="empty" title={t('No markets are open right now.')} />
      </Frame>
    );

  const showPaused =
    hasPaused && view.status === 'open' ? { label: t('Include paused'), onClick: () => change({ status: 'all' }) } : undefined;
  const empty = (() => {
    if (view.tab === 'favorites' && favorites.length === 0)
      return signedIn ? (
        <KitState
          kind="empty"
          title={t('Star a market to keep it here.')}
          action={{ label: t('Browse markets'), onClick: () => change({ tab: 'spot' }) }}
        />
      ) : (
        <KitState kind="empty" title={t('Log in to keep your favorites here.')} action={{ label: t('Log in'), href: signIn }} />
      );
    if (query.trim())
      return (
        <KitState
          kind="empty"
          title={t('No markets match “{query}”.', { query: query.trim() })}
          action={{ label: t('Clear search'), onClick: () => setQuery('') }}
        />
      );
    if (chip === 'gainers') return <KitState kind="empty" title={t('Nothing is gaining right now.')} />;
    if (chip === 'losers') return <KitState kind="empty" title={t('Nothing is falling right now.')} />;
    if (chip === 'new') return <KitState kind="empty" title={t('No new listings.')} />;
    return (
      <KitState
        kind="empty"
        title={view.tab === 'favorites' ? t('Star a market to keep it here.') : t('No markets are open right now.')}
        action={showPaused}
      />
    );
  })();

  const featured = marketsLoading ? <BoardSkeleton /> : <Board entries={openEntries} mode={layoutMode} />;

  return (
    <Frame meta={meta} featured={featured}>
      <div className="lt-stack" ref={tableTop}>
        <div data-testid="mkt-tabs" className="mkt-toolbar">
          <TabList
            label={t('Markets')}
            items={[
              { value: 'favorites', label: t('Favorites') },
              { value: 'spot', label: t('Spot') },
              ...(perpEntries.length > 0 ? [{ value: 'perps', label: t('Perps') }] : []),
            ]}
            value={tab}
            onChange={(value) => change({ tab: value === 'favorites' ? 'favorites' : value === 'perps' ? 'perps' : 'spot' })}
          />
          <div data-testid="mkt-chips" className="mkt-toolbar__chips" hidden={tab === 'perps'}>
            <ToggleChips
              label={t('Filter by change')}
              options={CHIPS.filter((value) => value !== 'new' || showNew).map((value) => ({
                value,
                label: t(value === 'all' ? 'All' : value === 'gainers' ? 'Gainers' : value === 'losers' ? 'Losers' : 'New'),
              }))}
              value={chip}
              onChange={(value) => change({ chip: CHIPS.find((item) => item === value) ?? 'all' })}
            />
            {hasPaused || view.status === 'all' ? (
              <Segmented
                label={t('Filter by status')}
                options={[
                  { value: 'open', label: t('Open only') },
                  { value: 'all', label: t('Include paused') },
                ]}
                value={view.status}
                onChange={(value) => change({ status: value === 'all' ? 'all' : 'open' })}
              />
            ) : null}
          </div>
          <div className="mkt-toolbar__search">
            <SearchField
              id={searchId}
              label={t('Search markets')}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('Search by coin or name')}
              icon={<Search size={16} aria-hidden="true" />}
              onKeyDown={(event) => event.key === 'Escape' && setQuery('')}
            />
          </div>
        </div>

        {tickers.status === 'error' ? (
          <StatusNote
            data-testid="mkt-notice"
            tone="warn"
            title={t('Couldn’t load prices')}
            actions={
              <Button tone="quiet" onClick={tickers.retry}>
                {t('Try again')}
              </Button>
            }
          />
        ) : tickers.status === 'refused' ? (
          <StatusNote data-testid="mkt-notice" tone="warn" title={t('Couldn’t load prices')}>
            {refusalCopy(tickers.code).title}. {refusalCopy(tickers.code).body} <span className="lt-ref">{tickers.code}</span>
          </StatusNote>
        ) : null}

        {tab === 'perps' && perpEntries.every((entry) => entry.ticker === undefined) ? (
          <StatusNote data-testid="mkt-perps-note" tone="neutral" title={t('The venue publishes no perpetual prices to this list.')}>
            {t('Open one to trade it on the futures desk.')}
          </StatusNote>
        ) : null}
        <MarketsList
          label={t('Markets')}
          targetOf={tab === 'perps' ? perpTarget : undefined}
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
      </div>
      <NotOffered />
    </Frame>
  );
}

/**
 * What is not offered on spot, named with its blocker, never implied: tokenized equities wait on a licence
 * (SP-markets-data-03, `licence`), and the retail price improvement layer waits on the engine's priority class and the
 * owner's retail decision (SP-markets-data-04). No row here is tradeable, and none carries a price.
 */
function NotOffered() {
  const { t } = marketsCopy.useCopy();
  return (
    <section data-testid="mkt-not-offered" aria-labelledby="mkt-not-offered" className="lt-stack">
      <h2 id="mkt-not-offered" className="lt-sr">
        {t('Not offered here')}
      </h2>
      <ul className="mkt-footnote">
        <li data-testid="mkt-not-offered-equity">
          <strong>{t('Tokenized equities')}</strong> {t('Not available: licence not named')}
        </li>
        <li data-testid="mkt-not-offered-rpi">
          <strong>{t('Retail price improvement')}</strong> {t('Not available: priority class not specified')}
        </li>
      </ul>
    </section>
  );
}

/** A perpetual opens the futures desk on its contract; nowhere where the beta hides the desk. */
function perpTarget(market: MarketData): string | null {
  const path = `/trade/futures/${encodeURIComponent(market.symbol)}`;
  return isHiddenPath('/trade/futures') ? null : path;
}

/** The freshness of the prices on screen, from the ticker read's own time (UI-SPEC TRD-0079). */
function Freshness({ tickers }: { tickers: Loadable<Record<string, TickerRow>> }) {
  const { t } = marketsCopy.useCopy();
  const { timeZone } = usePreferences();
  const words = { live: t('Live'), stale: t('Stale'), unknown: t('Unknown'), refused: t('Refused') };
  if (tickers.status === 'refused')
    return (
      <FreshnessTag
        asOf={null}
        staleAfterMs={STALE_AFTER_MS}
        refused
        words={words}
        asOfLabel={t('as of')}
        reason={refusalCopy(tickers.code).title}
      />
    );
  if (tickers.status === 'ready')
    return (
      <FreshnessTag asOf={tickers.asOf} staleAfterMs={STALE_AFTER_MS} words={words} asOfLabel={t('as of')} timeZone={ianaZone(timeZone)} />
    );
  return (
    <FreshnessTag
      asOf={null}
      staleAfterMs={STALE_AFTER_MS}
      words={words}
      asOfLabel={t('as of')}
      reason={tickers.status === 'error' ? t('Prices could not be loaded') : t('Prices have not arrived')}
    />
  );
}

/**
 * The room on the catalogue template: the title with the prices' freshness, the person's trading access, the top cards
 * (Popular, New listings, Top gainers) and the list with its tabs, search and filters.
 */
function Frame({ children, meta, featured }: { children: ReactNode; meta: ReactNode; featured?: ReactNode }) {
  const { t } = marketsCopy.useCopy();
  return (
    <div data-testid="if-markets">
      <CatalogueTemplate
        title={t('Markets')}
        roomAction={meta}
        state={{ kind: 'ready' }}
        filters={<TradeAccess />}
        featured={featured}
        items={<div className="lt-stack">{children}</div>}
      />
    </div>
  );
}
