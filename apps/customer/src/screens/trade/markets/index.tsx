import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { Search, X } from 'lucide-react';
import './markets.css';
import { assetName, marketsCopy } from './copy';
import {
  Button,
  refusalCopy,
  StateBlock,
  Tabs,
  TabsList,
  TabsTab,
  ToggleGroup,
  ToggleGroupItem,
  useFavorites,
  useMarkets,
  useSparklines,
  useTickers,
  type MarketData,
} from './deps';
import { MarketsTable } from './MarketsTable';
import type { FavoriteControl } from './MarketRow';
import { TopCards, TopCardsSkeleton } from './TopCards';
import {
  anyListed,
  entriesFor,
  quotesOf,
  topCards,
  visibleEntries,
  type CardId,
  type Chip,
  type FilterState,
  type Sort,
  type Tab,
} from './select';
import { useSession } from '../../../features/session/session';
import { usePreferences } from '../../../shared/preferences';
import type { ScreenProps } from '../../../app/screen-types';

const CHIPS: readonly Chip[] = ['all', 'gainers', 'losers', 'new'];

/** Start state from the address, so a link such as `/trade?tab=favorites` or `/trade?filter=gainers` lands where it says. */
function initialState(search: string): Pick<FilterState, 'tab' | 'chip' | 'quote' | 'query'> {
  const params = new URLSearchParams(search);
  const filter = params.get('filter');
  return {
    tab: params.get('tab') === 'favorites' ? 'favorites' : 'spot',
    chip: CHIPS.includes(filter as Chip) ? (filter as Chip) : 'all',
    quote: params.get('quote')?.toUpperCase() || null,
    query: params.get('q') ?? '',
  };
}

export default function TradeMarketsScreen({ path, search }: ScreenProps) {
  const copy = marketsCopy.useCopy();
  const { t } = copy;
  const { layoutMode } = usePreferences();
  const { userId } = useSession();
  const { favorites, isFavorite, toggle } = useFavorites(userId);
  const markets = useMarkets();
  const tickers = useTickers();

  const start = useMemo(() => initialState(search), [search]);
  const [tab, setTab] = useState<Tab>(start.tab);
  const [chip, setChip] = useState<Chip>(start.chip);
  const [quote, setQuote] = useState<string | null>(start.quote);
  const [query, setQuery] = useState(start.query);
  const [searching, setSearching] = useState(start.query !== '');
  const [sort, setSort] = useState<Sort | null>(null);
  const [onScreen, setOnScreen] = useState<readonly string[]>([]);
  const tableTop = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);

  const tickerMap = tickers.status === 'ready' ? tickers.data : undefined;
  const entries = useMemo(() => (markets.status === 'ready' ? entriesFor(markets.data, tickerMap) : []), [markets, tickerMap]);
  const quotes = useMemo(() => quotesOf(entries.map((entry) => entry.market)), [entries]);
  const showNew = useMemo(() => anyListed(entries), [entries]);
  const rows = useMemo(
    () => visibleEntries(entries, { tab, chip, quote, query, sort, favorites }, (base) => assetName(base, copy)),
    // `copy` changes only with the language.
    [entries, tab, chip, quote, query, sort, favorites, copy.renderedLocale],
  );
  // Cards are all prices and changes: without prices they would be rows of dashes, so they wait for them.
  const cards = useMemo(() => (tickerMap ? topCards(entries) : []), [entries, tickerMap]);
  const sparklines = useSparklines(onScreen);

  const signedIn = userId != null;
  const signIn = `/login?redirect=${encodeURIComponent(path + search)}`;
  const favorite = useCallback(
    (market: MarketData): FavoriteControl =>
      signedIn ? { on: isFavorite(market.symbol), onToggle: () => toggle(market.symbol) } : { signInHref: signIn },
    [signedIn, isFavorite, toggle, signIn],
  );

  const showAll = () => {
    setTab('spot');
    setChip('all');
    setQuote(null);
    setQuery('');
    setSort(null);
  };
  const seeAll = (id: CardId) => {
    showAll();
    if (id === 'popular') setSort({ key: 'volume', dir: 'desc' });
    else setChip(id === 'new' ? 'new' : 'gainers');
    tableTop.current?.scrollIntoView({ block: 'start' });
  };
  const closeSearch = () => {
    setSearching(false);
    setQuery('');
  };

  const marketsLoading = markets.status === 'loading' || (markets.status === 'ready' && tickers.status === 'loading');
  const noMarkets = markets.status === 'empty';

  if (markets.status === 'error')
    return (
      <Frame>
        <StateBlock kind="error" title={t('Couldn’t load markets')} onRetry={markets.retry} retryLabel={t('Try again')} />
      </Frame>
    );
  if (markets.status === 'refused') {
    const refused = refusalCopy(markets.code);
    return (
      <Frame>
        <StateBlock kind="refused" title={refused.title} body={refused.body} code={refused.reference} action={refused.action} />
      </Frame>
    );
  }
  if (noMarkets)
    return (
      <Frame>
        <StateBlock kind="empty" title={t('No markets are open right now.')} />
      </Frame>
    );

  const empty = (() => {
    if (tab === 'favorites' && favorites.length === 0)
      return signedIn ? (
        <StateBlock
          kind="empty"
          title={t('Star a market to keep it here.')}
          action={{ label: t('Browse markets'), onClick: () => setTab('spot') }}
        />
      ) : (
        <StateBlock kind="empty" title={t('Log in to keep your favorites here.')} action={{ label: t('Log in'), href: signIn }} />
      );
    if (query.trim())
      return (
        <StateBlock
          kind="empty"
          title={t('No markets match “{query}”.', { query: query.trim() })}
          action={{ label: t('Clear search'), onClick: closeSearch }}
        />
      );
    if (chip === 'gainers') return <StateBlock kind="empty" title={t('Nothing is gaining right now.')} />;
    if (chip === 'losers') return <StateBlock kind="empty" title={t('Nothing is falling right now.')} />;
    if (chip === 'new') return <StateBlock kind="empty" title={t('No new listings.')} />;
    return (
      <StateBlock kind="empty" title={tab === 'favorites' ? t('Star a market to keep it here.') : t('No markets are open right now.')} />
    );
  })();

  return (
    <Frame>
      {marketsLoading ? <TopCardsSkeleton /> : cards.length > 0 ? <TopCards cards={cards} mode={layoutMode} onSeeAll={seeAll} /> : null}

      <div className="mkt-tabs" ref={tableTop}>
        <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)}>
          <TabsList className="mkt-tabs__list">
            <TabsTab value="favorites" className="mkt-tab">
              {t('Favorites')}
            </TabsTab>
            <TabsTab value="spot" className="mkt-tab">
              {t('Spot')}
            </TabsTab>
          </TabsList>
        </Tabs>
        <div className="mkt-search">
          {searching ? (
            <div className="mkt-search__field">
              <Search size={16} aria-hidden="true" />
              <input
                ref={searchInput}
                autoFocus
                type="text"
                value={query}
                placeholder={t('Search by coin or name')}
                aria-label={t('Search markets')}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => event.key === 'Escape' && closeSearch()}
              />
              <button type="button" className="mkt-iconbtn" aria-label={t('Close search')} onClick={closeSearch}>
                <X size={16} aria-hidden="true" />
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="mkt-iconbtn mkt-iconbtn--lg"
              aria-label={t('Search markets')}
              onClick={() => setSearching(true)}
            >
              <Search size={20} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      <div className="mkt-chips">
        <ToggleGroup value={chip} onValueChange={(value) => setChip(value as Chip)} aria-label={t('Filter by change')}>
          {CHIPS.filter((value) => value !== 'new' || showNew).map((value) => (
            <ToggleGroupItem key={value} value={value}>
              {t(value === 'all' ? 'All' : value === 'gainers' ? 'Gainers' : value === 'losers' ? 'Losers' : 'New')}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {quotes.length > 1 ? (
          <>
            <span className="mkt-chips__divider" aria-hidden="true" />
            <ToggleGroup value={quote ?? ''} onValueChange={setQuote} aria-label={t('Filter by currency')}>
              {quotes.map((value) => (
                // Pressing the chosen currency again turns the filter off.
                <ToggleGroupItem key={value} value={value} onClick={() => quote === value && setQuote(null)}>
                  {value}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </>
        ) : null}
      </div>

      {tickers.status === 'error' ? (
        <div className="mkt-notice" role="status">
          <span>{t('Couldn’t load prices')}</span>
          <Button variant="ghost" size={28} onClick={tickers.retry}>
            {t('Try again')}
          </Button>
        </div>
      ) : null}

      <MarketsTable
        label={t('Markets')}
        entries={rows}
        sparklines={sparklines.status === 'ready' ? sparklines.data : undefined}
        mode={layoutMode}
        sort={sort}
        onSortChange={setSort}
        favorite={favorite}
        loading={marketsLoading}
        onVisibleSymbolsChange={setOnScreen}
        empty={empty}
      />
    </Frame>
  );
}

function Frame({ children }: { children: ReactNode }) {
  const { t } = marketsCopy.useCopy();
  return (
    <div className="if-markets">
      <h1 className="if-sr">{t('Markets')}</h1>
      {children}
    </div>
  );
}
