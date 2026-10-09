import { TradeOriginalMessage, tradeError, tradeFailureFrom, TradeMessage, tradeRefusal, tradeCopy as copy, CopyText, tradeLabels, choiceText, choiceNode, choiceLanguage, tradeDate, TradeFailure as Failure } from './copy';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { z } from 'zod';
import { useApi, useSession } from '../session/session';
import { usePreferences } from '../../shared/preferences';
import { navigate } from '../../app/location';
import { useResource, type Resource } from '../../shared/resource';
import { Button, DataTable, Dialog, EmptyState, Field, Loading, Tabs } from '../../shared/ui';
import { unavailable, type ApiResult } from '../../shared/api';
import { decimalSchema, displayAmount, parseAmount, formatAmount } from '../../shared/money';
import {
  createTradeApi,
  type TradeApi,
  type Listing,
  type Draft,
  type Preview,
  type Order,
  draftSchema,
  exactValue,
  baseQuantityForValue,
  portionInLots,
  isTerminalOrder,
} from './trade-api';
import { useLinkedBook, usePolled } from './hooks';
import { MarketChart } from './Chart';
import { TradingTools } from './TradingTools';
import { ReplaceOrder } from './ReplaceOrder';
import { DeskFrame, UnavailableDesk } from './Workspace';
import './trade.css';

const modes = ['Spot', 'Margin', 'Futures', 'Options', 'Copy', 'Bots', 'Execution', 'Quote desk'];
const modeRoutes: Record<string, string> = {
  Spot: '/exchange',
  Margin: '/trade/margin',
  Futures: '/trade/futures',
  Options: '/trade/options',
  Copy: '/trade/copy',
  Bots: '/trade/bots',
  Execution: '/execution',
  Convert: '/trade/convert',
  'Quote desk': '/otc',
};
export function TradeRoutes({ path }: { path: string }) {
  const route = new URL(path, location.origin),
    pathname = route.pathname;
  const preferences = usePreferences();
  const { languageFor } = copy.forLocale(preferences.language);
  const transport = useApi(),
    api = useMemo(() => createTradeApi(transport), [transport]),
    { userId } = useSession();
  const catalogue = useResource((signal) => api.markets(signal), 'trade-catalogue');
  const [favorites, setFavorites] = useState<string[]>(() => {
    try {
      const value: unknown = JSON.parse(localStorage.getItem(`trade-favorites:${userId ?? 'guest'}`) ?? '[]');
      return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
    } catch {
      return [];
    }
  });
  const [favoritesKey, setFavoritesKey] = useState(`trade-favorites:${userId ?? 'guest'}`);
  useEffect(() => {
    const key = `trade-favorites:${userId ?? 'guest'}`;
    try {
      const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
      setFavorites(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
    } catch {
      setFavorites([]);
    }
    setFavoritesKey(key);
  }, [userId]);
  const [simulation, setSimulation] = useState(() => route.searchParams.get('simulated') === 'true'),
    [picker, setPicker] = useState(false),
    [selected, setSelected] = useState<string | null>(null);
  const activeMode = pathname.startsWith('/trade/convert')
    ? 'Convert'
    : pathname.startsWith('/otc')
      ? 'Quote desk'
      : pathname.startsWith('/execution')
        ? 'Execution'
        : (modes.find((mode) => mode !== 'Spot' && pathname.includes(`/trade/${mode.toLowerCase()}`)) ?? 'Spot');
  const query = route.searchParams,
    asset = query.get('asset')?.toUpperCase(),
    initialSide = query.get('side') === 'sell' ? 'sell' : 'buy';
  const routePair = pathname.startsWith('/exchange/') ? decodePair(pathname.slice('/exchange/'.length)) : null;
  const markets = catalogue.resource.status === 'ready' ? catalogue.resource.data : [];
  const visible = markets.filter(
    (market) =>
      market.paper === simulation &&
      (activeMode === 'Futures' ? market.swap || market.future : activeMode === 'Options' ? market.option : market.spot),
  );
  const assetSymbol = asset ? visible.find((value) => value.base === asset)?.symbol : null;
  const requested = selected ?? routePair ?? assetSymbol;
  const market = visible.find((value) => value.symbol === requested) ?? ((routePair || asset) && !selected ? undefined : visible[0]);
  useEffect(() => {
    if (favoritesKey !== `trade-favorites:${userId ?? 'guest'}`) return;
    try {
      localStorage.setItem(`trade-favorites:${userId ?? 'guest'}`, JSON.stringify(favorites));
    } catch {
      /* Favorites remain available in this tab. */
    }
  }, [favorites, userId, favoritesKey]);
  useEffect(() => {
    setSelected(null);
    setSimulation(route.searchParams.get('simulated') === 'true');
  }, [path]);
  function choose(value: Listing) {
    setSelected(value.symbol);
    setPicker(false);
  }
  return (
    <div className={`trade-root ${activeMode === 'Spot' ? 'trade-root--spot' : ''}`} lang={preferences.language}>
      <nav className="trade-modes" aria-label={copy.t('tradingModes')} lang={languageFor('tradingModes')}>
        {activeMode === 'Spot' ? (
          <details className="trade-mode-menu">
            <summary>
              <CopyText k="tradingModes" /> <span aria-hidden="true">⌄</span>
            </summary>
            <div className="trade-mode-links">
              {modes.map((mode) => (
                <a
                  key={mode}
                  aria-current={activeMode === mode ? 'page' : undefined}
                  href={`${modeRoutes[mode]}${simulation ? '?simulated=true' : ''}`}
                >
                  {choiceNode(mode)}
                </a>
              ))}
            </div>
          </details>
        ) : (
          <div className="trade-mode-links">
            {modes.map((mode) => (
              <a
                key={mode}
                aria-current={activeMode === mode ? 'page' : undefined}
                href={`${modeRoutes[mode]}${simulation ? '?simulated=true' : ''}`}
              >
                {choiceNode(mode)}
              </a>
            ))}
          </div>
        )}
        <label className="trade-simulation">
          <input
            type="checkbox"
            checked={simulation}
            onChange={(event) => {
              setSimulation(event.target.checked);
              setSelected(null);
              const target = new URL(location.href);
              if (event.target.checked) target.searchParams.set('simulated', 'true');
              else target.searchParams.delete('simulated');
              navigate(`${target.pathname}${target.search}${target.hash}`, true);
            }}
          />
          <CopyText k="simulated" />
        </label>
      </nav>
      {activeMode !== 'Spot' ? (
        <TradingTools
          key={`${activeMode}:${simulation}:${userId ?? 'guest'}`}
          api={api}
          transport={transport}
          mode={activeMode}
          markets={visible}
          simulation={simulation}
        />
      ) : (
        <>
          <header className="trade-market">
            <button
              className="trade-market-select"
              onClick={() => setPicker(true)}
              aria-label={copy.t('chooseTradingMarket')}
              lang={languageFor('chooseTradingMarket')}
            >
              <strong>{market?.symbol ?? <CopyText k={'chooseMarket'} />}</strong>
              <span>⌄</span>
            </button>
            <span className="trade-badge">{simulation ? <CopyText k={'simulated31d66d'} /> : <CopyText k={'spot'} />}</span>
            {market ? (
              <MarketFacts api={api} market={market} />
            ) : (
              <span className="muted">
                <CopyText k="marketInformationUnavailable" />
              </span>
            )}
            <a className="text-link" href="/money">
              <CopyText k="accountFunds" />
            </a>
          </header>
          <div className={`trade-favorites ${preferences.favoritesView === 'cards' ? 'trade-favorites--cards' : ''}`}>
            <span className="muted">
              <CopyText k="favorites" />
            </span>
            {market && (
              <button
                aria-label={favorites.includes(market.symbol) ? copy.t('removeMarketFromFavorites') : copy.t('addMarketToFavorites')}
                onClick={() =>
                  setFavorites((current) =>
                    current.includes(market.symbol) ? current.filter((value) => value !== market.symbol) : [...current, market.symbol],
                  )
                }
              >
                {favorites.includes(market.symbol) ? '★' : '☆'}
              </button>
            )}
            {visible
              .filter((value) => favorites.includes(value.symbol))
              .map((value) => (
                <button key={value.id} aria-pressed={value.id === market?.id} onClick={() => choose(value)}>
                  {value.symbol}
                </button>
              ))}
            <button onClick={() => setPicker(true)}>
              <CopyText k="allMarkets" />
            </button>
          </div>
          {catalogue.resource.status === 'ready' && market ? (
            <SpotDesk
              key={`${market.id}:${userId ?? 'guest'}:${initialSide}`}
              market={market}
              api={api}
              initialTab={pathname === '/uc/entrust/history' ? 'History' : 'Open orders'}
              initialSide={initialSide}
              markets={visible}
            />
          ) : (
            <UnavailableDesk
              resource={catalogue.resource}
              retry={catalogue.reload}
              simulation={simulation}
              management={
                <AccountOrders
                  key={`${userId ?? 'guest'}:${simulation}`}
                  api={api}
                  initialTab={pathname === '/uc/entrust/history' ? 'History' : 'Open orders'}
                  simulation={simulation}
                />
              }
              title={
                simulation ? (
                  <CopyText k={'noSimulatedSpotMarketIsPublished'} />
                ) : routePair ? (
                  <CopyText k={'thisMarketIsNotAvailableInThisMode'} />
                ) : (
                  <CopyText k={'noSpotMarketsArePublished'} />
                )
              }
            />
          )}
        </>
      )}
      {picker && (
        <MarketPicker
          markets={visible}
          resource={catalogue.resource}
          retry={catalogue.reload}
          favorites={favorites}
          currentMarketId={market?.id}
          onSelect={choose}
          onClose={() => setPicker(false)}
        />
      )}
    </div>
  );
}
function decodePair(value: string) {
  try {
    const decoded = decodeURIComponent(value).toUpperCase();
    return decoded.includes('/') ? decoded : decoded.replace('_', '/').replace('-', '/');
  } catch {
    return null;
  }
}
function ResourceView<T>({
  resource,
  retry,
  children,
  empty,
}: {
  resource: Resource<T>;
  retry?: () => void;
  children: (value: T) => ReactNode;
  empty?: string;
}) {
  return resource.status === 'loading' ? (
    <Loading />
  ) : resource.status === 'failed' ? (
    <Failure result={resource.failure} retry={retry} />
  ) : (
    (children(resource.data) ?? <EmptyState title={empty ?? <CopyText k={'noRecords'} />} />)
  );
}
function MarketPicker({
  markets,
  resource,
  retry,
  favorites,
  currentMarketId,
  onSelect,
  onClose,
}: {
  markets: Listing[];
  resource: Resource<Listing[]>;
  retry: () => void;
  favorites: readonly string[];
  currentMarketId: string | undefined;
  onSelect: (market: Listing) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const search = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // The child dialog opens in its effect; React autoFocus runs before showModal.
    search.current?.querySelector('input')?.focus({ preventScroll: true });
  }, []);
  const [collection, setCollection] = useState<'all' | 'favorites'>('all');
  const [quote, setQuote] = useState<string | null>(null);
  const quotes = [...new Set(markets.map((market) => market.quote))].sort();
  const hasFavorites = markets.some((market) => favorites.includes(market.symbol));
  const matching = markets.filter(
    (market) =>
      (collection === 'all' || favorites.includes(market.symbol)) &&
      (quote === null || market.quote === quote) &&
      `${market.symbol} ${market.base} ${market.quote}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  function resetFilters() {
    setCollection('all');
    setQuote(null);
    setQuery('');
  }
  return (
    <Dialog title={<CopyText k={'chooseMarket'} />} onClose={onClose}>
      <div ref={search}>
        <Field label={<CopyText k={'searchMarkets'} />} value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>
      {resource.status === 'ready' && markets.length > 0 && (
        <div className="trade-picker-filters">
          <Tabs
            items={['all', 'favorites']}
            value={collection}
            onChange={(value) => setCollection(value === 'favorites' ? 'favorites' : 'all')}
            labels={{ all: <CopyText k="allMarkets" />, favorites: <CopyText k="favorites" /> }}
            label={copy.t('marketCollections')}
          />
          {quotes.length > 1 && (
            <select
              aria-label={copy.t('quoteAsset')}
              value={quote === null ? 'all' : `quote:${quote}`}
              onChange={(event) => setQuote(event.target.value === 'all' ? null : event.target.value.slice('quote:'.length))}
            >
              <option value="all">{copy.t('allQuoteAssets')}</option>
              {quotes.map((asset) => (
                <option key={asset} value={`quote:${asset}`}>
                  {asset}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
      <div className="trade-picker">
        {resource.status === 'loading' && <Loading label={<CopyText k={'loadingPublishedMarkets'} />} />}
        {resource.status === 'failed' && <Failure result={resource.failure} retry={retry} />}
        {matching.map((market) => (
          <button key={market.id} aria-pressed={market.id === currentMarketId} onClick={() => onSelect(market)}>
            <span className="trade-picker-name">
              <strong>{market.symbol}</strong>
              {market.id === currentMarketId && (
                <small className="trade-picker-current">
                  <CopyText k="currentMarket" />
                </small>
              )}
            </span>
            <span className="trade-picker-admission">
              {market.paper && (
                <>
                  <CopyText k="simulated31fe29" /> ·{' '}
                </>
              )}
              <CopyText
                k={
                  !market.active
                    ? 'inactive'
                    : !market.sessionOpen
                      ? 'sessionClosed'
                      : !market.orderable
                        ? 'entryRestricted'
                        : 'publishedForTrading'
                }
              />
            </span>
          </button>
        ))}
        {resource.status === 'ready' && !matching.length && (
          <div className="trade-picker-empty">
            <EmptyState
              title={<CopyText k={collection === 'favorites' && !hasFavorites ? 'noFavoriteMarkets' : 'noMatchingMarketFilters'} />}
              action={
                (collection !== 'all' || quote !== null || query.trim()) && (
                  <Button variant="secondary" onClick={resetFilters}>
                    <CopyText k="showAllMarkets" />
                  </Button>
                )
              }
            >
              {collection === 'favorites' && !hasFavorites && <CopyText k="saveMarketWithStar" />}
            </EmptyState>
          </div>
        )}
      </div>
    </Dialog>
  );
}
function MarketFacts({ api, market }: { api: TradeApi; market: Listing }) {
  const ticker = usePolled((signal) => api.ticker(market.symbol, signal), market.id);
  return (
    <div className="trade-market-facts">
      <div>
        <span>
          <CopyText k="lastPrice" />
          {market.quote}
        </span>
        <strong className="numeric">{ticker.resource.status === 'ready' ? displayAmount(ticker.resource.data.last) : '—'}</strong>
      </div>
      <div>
        <span>
          <CopyText k="hChange" />
        </span>
        <strong>{ticker.resource.status === 'ready' ? displayAmount(ticker.resource.data.percentage) : '—'}</strong>
      </div>
      <div>
        <span>
          <CopyText k="marketStatus" />
        </span>
        <strong>
          {!market.active ? (
            <CopyText k={'inactive'} />
          ) : !market.sessionOpen ? (
            <CopyText k={'sessionClosed'} />
          ) : !market.orderable ? (
            <CopyText k={'entryRestricted'} />
          ) : (
            <CopyText k={'published'} />
          )}
        </strong>
      </div>
      {ticker.resource.status === 'failed' && (
        <span role="status">
          <CopyText k="priceUnavailable" />
        </span>
      )}
    </div>
  );
}

const pendingSchema = z.object({
  kind: z.enum(['place', 'cancel', 'amend', 'replace', 'convert', 'rfq', 'position', 'algo', 'copy']),
  symbol: z.string(),
  id: z.string(),
  orderId: z.string().optional(),
  startedAt: z.number(),
  expectedAmount: decimalSchema.optional(),
  originalAmount: decimalSchema.optional(),
});
type Pending = z.infer<typeof pendingSchema>;
function pendingKey(userId: string) {
  return `trade-pending:${userId}`;
}
function readPending(userId: string): Pending | null {
  try {
    const parsed = pendingSchema.safeParse(JSON.parse(localStorage.getItem(pendingKey(userId)) ?? 'null'));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
function CancelReplaceNotice({ original, replacement }: { original: ApiResult<Order>; replacement: ApiResult<Order> }) {
  const { t, requestedLocale } = copy.useCopy();
  // Segment only the authored template. Provider messages never enter this
  // interpolation or get scanned for keys; their explicit provenance renderer
  // preserves the original language and response context.
  const template = t('cancelReplaceIsUnresolvedNoNewRequestHasBeenSent', {
    originalOkOriginalMessage: '{originalOkOriginalMessage}',
    replacementOkReplacementMessage: '{replacementOkReplacementMessage}',
  });
  return <span lang={requestedLocale} data-i18n="trade.cancelReplaceIsUnresolvedNoNewRequestHasBeenSent">
    {template.split(/(\{originalOkOriginalMessage\}|\{replacementOkReplacementMessage\})/).map((part, index) =>
      part === '{originalOkOriginalMessage}'
        ? original.ok
          ? <CopyText key={index} k="originalOrderStatus" params={{ status: original.data.status }} />
          : <TradeOriginalMessage key={index} source={original} />
        : part === '{replacementOkReplacementMessage}'
          ? replacement.ok
            ? <CopyText key={index} k="replacementOrderStatus" params={{ status: replacement.data.status }} />
            : <TradeOriginalMessage key={index} source={replacement} />
          : part,
    )}
  </span>;
}
function useTradeRequests(api: TradeApi, accountKey: string, refresh: () => void, accountWide = false) {
  const [pending, setPending] = useState<Pending | null>(() => readPending(accountKey)),
    [status, setStatus] = useState<ReactNode>(''),
    [checking, setChecking] = useState(false);
  useEffect(() => {
    const update = () => setPending(readPending(accountKey));
    window.addEventListener('storage', update);
    window.addEventListener('trade-pending-change', update);
    return () => {
      window.removeEventListener('storage', update);
      window.removeEventListener('trade-pending-change', update);
    };
  }, [accountKey]);
  const releaseLock = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      releaseLock.current?.();
    },
    [],
  );
  const setIntent = (value: Pending | null, expected?: Pending) => {
    if (value) {
      try {
        localStorage.setItem(pendingKey(accountKey), JSON.stringify(value));
      } catch {
        setStatus(<CopyText k={'browserStorageCannotPreserveThisRequestIdentityEnableDeviceStorageBefore'} />);
        return false;
      }
    } else {
      try {
        const stored = readPending(accountKey);
        if (
          localStorage.getItem(pendingKey(accountKey)) &&
          (!stored ||
            !expected ||
            stored.id !== expected.id ||
            stored.kind !== expected.kind ||
            stored.startedAt !== expected.startedAt ||
            stored.orderId !== expected.orderId)
        ) {
          setPending(stored);
          setStatus(<CopyText k={'theActiveTradingRequestChangedThisOlderResultCannotClearIts'} />);
          return false;
        }
        localStorage.removeItem(pendingKey(accountKey));
      } catch {
        setStatus(<CopyText k={'theOutcomeIsConfirmedButItsDeviceMarkerCouldNotBe'} />);
        return false;
      }
    }
    window.dispatchEvent(new Event('trade-pending-change'));
    setPending(value);
    if (!value) {
      releaseLock.current?.();
      releaseLock.current = null;
    }
    return true;
  };
  const reserveIntent = async (value: Pending): Promise<boolean> => {
    if (!navigator.locks) {
      setStatus(<CopyText k={'thisBrowserCannotCoordinateTradingRequestsAcrossTabsUseABrowser'} />);
      return false;
    }
    return new Promise<boolean>((resolve) => {
      void navigator.locks.request(`trade-account:${accountKey}`, { ifAvailable: true }, async (lock) => {
        if (!lock) {
          setStatus(<CopyText k={'anotherTabIsProcessingATradingRequest'} />);
          resolve(false);
          return;
        }
        const existing = readPending(accountKey);
        if (existing) {
          setPending(existing);
          resolve(false);
          return;
        }
        try {
          if (localStorage.getItem(pendingKey(accountKey))) {
            setStatus(<CopyText k={'theSavedTradingRequestCannotBeReadPreserveDeviceStorageAnd'} />);
            resolve(false);
            return;
          }
        } catch {
          setStatus(<CopyText k={'deviceStorageIsUnavailableTradingCannotPreserveARequestIdentity'} />);
          resolve(false);
          return;
        }
        if (!setIntent(value)) {
          resolve(false);
          return;
        }
        resolve(true);
        await new Promise<void>((release) => {
          releaseLock.current = release;
        });
      });
    });
  };
  async function reconcile() {
    if (!pending || checking) return;
    if (!['place', 'cancel', 'amend', 'replace'].includes(pending.kind)) {
      setStatus(
        <CopyText k={'thisRequestMustBeCheckedInItsOriginalTradingToolContact'} params={{
          pendingKind: String(pending.kind),
          pendingId: String(pending.id),
        }} />,
      );
      return;
    }
    setChecking(true);
    if (pending.kind === 'replace' && pending.orderId) {
      const [original, replacement] = await Promise.all([
        api.order({ id: pending.orderId, symbol: pending.symbol }),
        api.reconcile(pending.id, pending.symbol, accountWide),
      ]);
      if (
        original.ok &&
        replacement.ok &&
        isTerminalOrder(original.data) &&
        original.data.symbol === pending.symbol &&
        !original.data.recoveryRequired &&
        !replacement.data.recoveryRequired
      ) {
        setIntent(null, pending);
        setStatus(
          <CopyText k={'originalReplacementRemaining'} params={{
            originalDataId: String(original.data.id),
            originalDataStatus: String(original.data.status),
            replacementDataId: String(replacement.data.id),
            replacementDataStatus: String(replacement.data.status),
            replacementDataRemaining: String(replacement.data.remaining),
          }} />,
        );
      } else
        setStatus(
          <CancelReplaceNotice original={original} replacement={replacement} />,
        );
      refresh();
      setChecking(false);
      return;
    }
    const result = pending.orderId
      ? await api.order({ id: pending.orderId, symbol: pending.symbol })
      : await api.reconcile(pending.id, pending.symbol, accountWide);
    if (result.ok) {
      const resolved =
        !result.data.recoveryRequired &&
        result.data.symbol === pending.symbol &&
        (pending.kind === 'place' ||
          (pending.kind === 'cancel' && isTerminalOrder(result.data)) ||
          (pending.kind === 'amend' &&
            (isTerminalOrder(result.data) ||
              Boolean(
                pending.expectedAmount &&
                pending.originalAmount &&
                parseAmount(result.data.amount) < parseAmount(pending.originalAmount) &&
                parseAmount(result.data.remaining) <= parseAmount(pending.expectedAmount),
              ))));
      if (resolved) {
        setIntent(null, pending);
        setStatus(
          <CopyText k={'orderFilledRemaining'} params={{
            resultDataId: String(result.data.id),
            resultDataStatus: String(result.data.status),
            resultDataFilled: String(result.data.filled),
            resultDataRemaining: String(result.data.remaining),
          }} />,
        );
      } else
        setStatus(
          <CopyText k={'orderIsStillOpenTheOutcomeIsUnresolvedFundsRemainAs'} params={{
            resultDataId: String(result.data.id),
            pendingKind: String(pending.kind),
          }} />,
        );
    } else setStatus(<TradeOriginalMessage source={result} />);
    refresh();
    setChecking(false);
  }
  return { pending, status, checking, setIntent, reserveIntent, reconcile, setStatus };
}
function SpotDesk({
  api,
  market,
  initialTab,
  initialSide,
  markets,
}: {
  api: TradeApi;
  market: Listing;
  initialTab: string;
  initialSide: 'buy' | 'sell';
  markets: Listing[];
}) {
  const { userId } = useSession(),
    preferences = usePreferences();
  const accountKey = userId ?? 'signed-out';
  const [openLimit, setOpenLimit] = useState(100);
  const book = useLinkedBook(api, market),
    balances = usePolled(
      (signal) =>
        market.paper ? Promise.resolve(unavailable(copy.t('aSimulatedBalanceContractIsNotMountedPaperOrdersDoNot'))) : api.balances(signal),
      accountKey,
      20,
    ),
    open = usePolled(
      (signal) => api.orders('open', market.paper ? market.symbol : undefined, openLimit, signal),
      `${accountKey}:${market.id}:open:${openLimit}`,
      10,
    );
  const [staged, setStaged] = useState(''),
    [manage, setManage] = useState<{ order: Order; kind: 'cancel' | 'amend' | 'replace'; price?: string } | null>(null);
  const { pending, status, checking, setIntent, reserveIntent, reconcile, setStatus } = useTradeRequests(api, accountKey, refresh);
  function refresh() {
    balances.reload();
    open.reload();
  }
  const orders = open.resource.status === 'ready' ? open.resource.data : [];
  return (
    <>
      <DeskFrame
        api={api}
        market={market}
        markets={markets}
        chart={(view, revision, onViewChange) => (
          <MarketChart
            key={revision}
            api={api}
            market={market}
            orders={orders}
            onStagePrice={setStaged}
            accountKey={accountKey}
            initialView={view}
            onViewChange={onViewChange}
            onStageAmend={(order, price) => {
              if (!pending) setManage({ order, kind: 'replace', price });
            }}
          />
        )}
        book={<BookAndTape api={api} market={market} book={book} onStagePrice={setStaged} />}
        management={
          <OrderBlotter
            api={api}
            initialTab={initialTab}
            open={open}
            openLimit={openLimit}
            onOpenLimitChange={setOpenLimit}
            market={market}
            onManage={(order, kind) => setManage({ order, kind })}
            locked={Boolean(pending)}
          />
        }
        ticket={
          <aside className="trade-ticket-column">
            <OrderTicket
              api={api}
              market={market}
              initialSide={initialSide}
              staged={staged}
              fresh={book.book.fresh}
              balances={balances.resource}
              pending={pending}
              onIntent={reserveIntent}
              onResolved={(identity) => {
                setIntent(null, identity);
                refresh();
              }}
              onStatus={setStatus}
            />
            <section className="trade-funds">
              <h3>{copy.t(market.paper ? 'simulationFundsHeading' : 'personalFundsHeading')}</h3>
              {market.paper ? (
                <p className="muted">
                  <CopyText k="paperOrdersUseTheServiceSIsolatedPaperPathAndZero" />
                </p>
              ) : (
                <ResourceView resource={balances.resource} retry={balances.reload}>
                  {(data) => (
                    <dl>
                      {[market.quote, market.base].map((asset) => (
                        <div key={asset}>
                          <dt>
                            <CopyText k="available" />
                            {asset}
                          </dt>
                          <dd className="numeric">{preferences.hideBalances ? '••••' : displayAmount(data.balances[asset]?.free)}</dd>
                          <dt>
                            <CopyText k="held" />
                            {asset}
                          </dt>
                          <dd className="numeric">{preferences.hideBalances ? '••••' : displayAmount(data.balances[asset]?.used)}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </ResourceView>
              )}
              {!market.paper && (
                <a className="text-link" href="/money">
                  <CopyText k="manageInMoney" />
                </a>
              )}
            </section>
          </aside>
        }
      />
      {pending && (
        <div className="trade-uncertain" role="alert">
          <strong>
            <CopyText k="outcomeNotConfirmed" />
            {pending.kind}
          </strong>
          <p>
            {pending.symbol} <CopyText k="request" />
            {pending.id}
            <CopyText k="newOrdersRemainLockedWhileThisRequestIsUnresolvedNoFunds" />
          </p>
          <Button variant="secondary" disabled={checking} onClick={reconcile}>
            {checking ? <CopyText k={'checkingStatus'} /> : <CopyText k={'checkOriginalRequestStatus'} />}
          </Button>
          <a className="text-link" href="/support">
            <CopyText k="contactSupport" />
          </a>
        </div>
      )}
      {status && (
        <p className="trade-status" role="status" lang="und">
          {status}
        </p>
      )}
      {manage?.kind === 'replace' && (
        <ReplaceOrder
          api={api}
          order={manage.order}
          initialPrice={manage.price}
          onClose={() => setManage(null)}
          onIntent={reserveIntent}
          onResolved={(identity) => {
            setIntent(null, identity);
            refresh();
          }}
          onStatus={setStatus}
        />
      )}
      {manage && manage.kind !== 'replace' && (
        <ManageOrder
          api={api}
          market={markets.find((row) => row.symbol === manage.order.symbol)}
          canDispatch={() => (new URLSearchParams(location.search).get('simulated') === 'true') === market.paper}
          selection={{ order: manage.order, kind: manage.kind }}
          onClose={() => setManage(null)}
          onIntent={reserveIntent}
          onResolved={(identity) => {
            setIntent(null, identity);
            refresh();
          }}
          onStatus={setStatus}
        />
      )}
    </>
  );
}
function AccountOrders({ api, initialTab, simulation }: { api: TradeApi; initialTab: string; simulation: boolean }) {
  const { userId } = useSession();
  const accountKey = userId ?? 'signed-out';
  const [openLimit, setOpenLimit] = useState(100);
  const open = usePolled(
    (signal) =>
      simulation
        ? Promise.resolve(unavailable<Order[]>(copy.t('accountWideSimulationHistoryCannotBeVerifiedWithoutAPublishedPaper')))
        : api.orders('open', undefined, openLimit, signal),
    `${accountKey}:account-orders:${simulation}:${openLimit}`,
    10,
  );
  const [manage, setManage] = useState<Order | null>(null);
  const { pending, status, checking, reserveIntent, setIntent, reconcile, setStatus } = useTradeRequests(
    api,
    accountKey,
    open.reload,
    true,
  );
  return (
    <section aria-label={copy.t('accountOrderManagement')}>
      <OrderBlotter
        api={api}
        initialTab={initialTab}
        open={open}
        openLimit={openLimit}
        onOpenLimitChange={setOpenLimit}
        locked={Boolean(pending)}
        accountWideAllowed={!simulation}
        allowCancel={!simulation}
        onManage={(order, kind) => {
          if (kind === 'cancel') setManage(order);
        }}
      />
      {pending && (
        <div className="trade-uncertain" role="alert">
          <strong>
            <CopyText k="outcomeNotConfirmed" />
            {pending.kind}
          </strong>
          <p>
            {pending.symbol} <CopyText k="request" />
            {pending.id}
            <CopyText k="resolveThisOriginalRequestBeforeAnotherTradingActionNoFundsHave" />
          </p>
          <Button variant="secondary" disabled={checking} onClick={reconcile}>
            {checking ? <CopyText k={'checkingStatus'} /> : <CopyText k={'checkOriginalRequestStatus'} />}
          </Button>
          <a className="text-link" href="/support">
            <CopyText k="contactSupport" />
          </a>
        </div>
      )}
      {status && (
        <p className="trade-status" role="status" lang="und">
          {status}
        </p>
      )}
      {manage && (
        <ManageOrder
          api={api}
          canDispatch={() => !simulation && new URLSearchParams(location.search).get('simulated') !== 'true'}
          selection={{ order: manage, kind: 'cancel' }}
          onClose={() => setManage(null)}
          onIntent={reserveIntent}
          onResolved={(identity) => {
            setIntent(null, identity);
            open.reload();
          }}
          onStatus={setStatus}
        />
      )}
    </section>
  );
}
function BookAndTape({
  api,
  market,
  book,
  onStagePrice,
}: {
  api: TradeApi;
  market: Listing;
  book: ReturnType<typeof useLinkedBook>;
  onStagePrice: (price: string) => void;
}) {
  const [tab, setTab] = useState('Order book'),
    [sides, setSides] = useState('Both');
  const tape = usePolled((signal) => api.tape(market.symbol, signal), market.id, 10);
  function rows(levels: [string, string][], side: string) {
    let cumulative = 0n;
    return levels.slice(0, 12).map(([price, quantity]) => {
      cumulative += parseAmount(quantity);
      return (
        <button
          className={`trade-book-row ${side}`}
          key={price}
          onClick={() => onStagePrice(price)}
          aria-label={copy.t('useLimitPrice', { price: String(price), marketQuote: String(market.quote) })}
        >
          <span>{displayAmount(price)}</span>
          <span>{displayAmount(quantity)}</span>
          <span>{displayAmount(formatAmount(cumulative))}</span>
        </button>
      );
    });
  }
  return (
    <section className="trade-book" aria-label={copy.t('linkedOrderBookAndPublicTrades')}>
      <Tabs
        labels={tradeLabels}
        items={['Order book', 'Depth', 'Trades']}
        value={tab}
        onChange={setTab}
        label={copy.t('marketDataPanel')}
      />
      {tab === 'Depth' ? (
        <>
          <p className="trade-note">
            {book.book.fresh ? book.status : <CopyText k={'depthStaleOrLoading'} />} <CopyText k="publishedLevelsUpToPerSide" />
          </p>
          {book.failure ? <Failure result={book.failure} /> : <DepthPlot market={market} book={book.book} onStagePrice={onStagePrice} />}
        </>
      ) : tab === 'Order book' ? (
        <>
          <div className="trade-book-controls">
            <select aria-label={copy.t('bookSide')} value={sides} onChange={(event) => setSides(event.target.value)}>
              {['Both', 'Bids', 'Asks'].map((value) => (
                <option key={value} value={value} lang={choiceLanguage(value)}>
                  {choiceText(value)}
                </option>
              ))}
            </select>
            <span className={book.book.fresh ? 'positive' : 'muted'}>
              {book.book.fresh ? book.status : <CopyText k={'depthStaleOrLoading'} />}
            </span>
          </div>
          <div className="trade-book-head">
            <span>
              <CopyText k="price" />
              {market.quote})
            </span>
            <span>
              <CopyText k="size" />
              {market.base})
            </span>
            <span>
              <CopyText k="total" />
              {market.base})
            </span>
          </div>
          {book.failure ? (
            <Failure result={book.failure} />
          ) : (
            <>
              {sides !== 'Bids' && <div className="trade-asks">{rows(book.book.asks, 'negative')}</div>}
              <div className="trade-book-mid">
                {book.book.asks[0]?.[0] && book.book.bids[0]?.[0] ? (
                  <CopyText
                    k={'spread'}
                    params={{
                      displayAmountFormatAmountParseAmountBook: String(
                        displayAmount(formatAmount(parseAmount(book.book.asks[0][0]) - parseAmount(book.book.bids[0][0]))),
                      ),
                      marketQuote: String(market.quote),
                    }}
                  />
                ) : (
                  <CopyText k={'noTwoSidedBook'} />
                )}
              </div>
              {sides !== 'Asks' && rows(book.book.bids, 'positive')}
              {book.book.sequence >= 0 && !book.book.bids.length && !book.book.asks.length && (
                <EmptyState title={<CopyText k={'noRestingOrders'} />} />
              )}
            </>
          )}
          <small className="trade-note">
            <CopyText k="sequence" />
            {book.book.sequence < 0 ? '—' : book.book.sequence} <CopyText k="selectAPriceToStageALimitOrder" />
          </small>
        </>
      ) : (
        <ResourceView resource={tape.resource} retry={tape.reload}>
          {(data) =>
            data.length ? (
              <>
                <div className="trade-book-head">
                  <span>
                    <CopyText k="price" />
                    {market.quote})
                  </span>
                  <span>
                    <CopyText k="size" />
                    {market.base})
                  </span>
                  <span>
                    <CopyText k="time" />
                  </span>
                </div>
                {data.map((row) => (
                  <div className={`trade-book-row ${row.side === 'buy' ? 'positive' : 'negative'}`} key={row.id}>
                    <span>{displayAmount(row.price)}</span>
                    <span>{displayAmount(row.amount)}</span>
                    <span>{tradeDate(row.timestamp, 'time')}</span>
                  </div>
                ))}
              </>
            ) : (
              <EmptyState title={<CopyText k={'noRecentPublicTrades'} />}>
                <CopyText k="yourPrivateFillsAppearInTheFillsTabBelow" />
              </EmptyState>
            )
          }
        </ResourceView>
      )}
    </section>
  );
}
function DepthPlot({
  market,
  book,
  onStagePrice,
}: {
  market: Listing;
  book: { bids: [string, string][]; asks: [string, string][] };
  onStagePrice: (price: string) => void;
}) {
  const rows = (levels: [string, string][]) => {
    let total = 0n;
    return levels.map(([price, quantity]) => {
      total += parseAmount(quantity);
      return { price, total: formatAmount(total) };
    });
  };
  const bids = rows(book.bids),
    asks = rows(book.asks),
    all = [...bids, ...asks];
  if (!all.length) return <EmptyState title={<CopyText k={'noPublishedDepth'} />} />;
  // Numeric conversion is confined to SVG coordinates; staging retains the original exact price string.
  const minimum = Math.min(...all.map((row) => Number(row.price))),
    maximum = Math.max(...all.map((row) => Number(row.price))),
    size = Math.max(...all.map((row) => Number(row.total))),
    width = maximum - minimum || 1;
  const x = (price: string) => 12 + ((Number(price) - minimum) / width) * 256,
    y = (total: string) => 240 - (Number(total) / (size || 1)) * 210;
  if (![minimum, maximum, size].every(Number.isFinite))
    return (
      <p className="trade-refusal">
        <CopyText k="publishedDepthExceedsChartRenderingLimitsExactLevelsRemainAvailableIn" />
      </p>
    );
  return (
    <>
      <svg
        className="trade-depth-plot"
        viewBox="0 0 280 260"
        role="img"
        aria-label={copy.t('actualCumulativeDepth', { marketSymbol: String(market.symbol) })}
      >
        {[
          { rows: bids, color: 'var(--chart-up, var(--color-positive))' },
          { rows: asks, color: 'var(--chart-down, var(--color-negative))' },
        ].map((side) => (
          <g key={side.color}>
            <polyline
              fill="none"
              stroke={side.color}
              strokeWidth="2"
              points={side.rows.map((row) => `${x(row.price)},${y(row.total)}`).join(' ')}
            />
            {side.rows.map((row) => (
              <circle key={row.price} cx={x(row.price)} cy={y(row.total)} r="4" fill={side.color} onClick={() => onStagePrice(row.price)}>
                <title>
                  {row.price} {market.quote} <CopyText k="cumulative" />
                  {row.total} {market.base}
                </title>
              </circle>
            ))}
          </g>
        ))}
      </svg>
      <p className="trade-note">
        <CopyText k="xPriceIn" />
        {market.quote} <CopyText k="yCumulativeSizeIn" />
        {market.base}
        <CopyText k="selectADepthPointToStageItsExactLimitPrice" />
      </p>
      <div className="trade-depth-ladder">
        {[...bids.slice(0, 3), ...asks.slice(0, 3)].map((row) => (
          <button key={row.price} onClick={() => onStagePrice(row.price)}>
            {displayAmount(row.price)} {market.quote}
          </button>
        ))}
      </div>
    </>
  );
}
function OrderTicket({
  api,
  market,
  initialSide,
  staged,
  fresh,
  balances,
  pending,
  onIntent,
  onResolved,
  onStatus,
}: {
  api: TradeApi;
  market: Listing;
  initialSide: 'buy' | 'sell';
  staged: string;
  fresh: boolean;
  balances:
    | Resource<Awaited<ReturnType<TradeApi['balances']>> extends { ok: true; data: infer T } ? T : never>
    | Resource<import('@intafaced/exchange-contract/schemas').Balances>;
  pending: Pending | null;
  onIntent: (value: Pending) => Promise<boolean>;
  onResolved: (identity: Pending) => void;
  onStatus: (value: ReactNode) => void;
}) {
  const { session, userId } = useSession(),
    preferences = usePreferences();
  const choiceKey = `trade-ticket-choices:${userId ?? 'guest'}:${market.id}`;
  const [choices] = useState(() => {
    const schema = z.object({ type: z.enum(['limit', 'market']), tif: z.enum(['GTC', 'IOC', 'FOK']), postOnly: z.boolean() });
    try {
      const parsed = schema.safeParse(JSON.parse(localStorage.getItem(choiceKey) ?? 'null'));
      return parsed.success ? parsed.data : { type: 'limit' as const, tif: 'GTC' as const, postOnly: false };
    } catch {
      return { type: 'limit' as const, tif: 'GTC' as const, postOnly: false };
    }
  });
  const [side, setSide] = useState<'buy' | 'sell'>(initialSide),
    [type, setType] = useState<'limit' | 'market'>(choices.type),
    [price, setPrice] = useState(''),
    [amount, setAmount] = useState(''),
    [sizeUnit, setSizeUnit] = useState<'base' | 'quote'>('base'),
    [tif, setTif] = useState<'GTC' | 'IOC' | 'FOK'>(choices.tif),
    [postOnly, setPostOnly] = useState(choices.postOnly && choices.type === 'limit' && choices.tif === 'GTC'),
    [review, setReview] = useState<{ draft: Draft; preview: Preview } | null>(null),
    [failure, setFailure] = useState<Extract<ApiResult<unknown>, { ok: false }> | null>(null),
    [busy, setBusy] = useState(false);
  const busyRef = useRef(false),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(choiceKey, JSON.stringify({ type, tif, postOnly }));
    } catch {
      /* Ticket choices remain available in this tab. */
    }
  }, [choiceKey, type, tif, postOnly]);
  useEffect(() => {
    if (staged) {
      setType('limit');
      setPrice(staged);
      setReview(null);
    }
  }, [staged]);
  const available = balances.status === 'ready' ? balances.data.balances[side === 'buy' ? market.quote : market.base]?.free : undefined;
  function change(action: () => void) {
    if (busyRef.current) return;
    action();
    setReview(null);
    setFailure(null);
  }
  function previewMatchesMode(value: Preview) {
    return value.holdAmount !== null && (market.paper ? parseAmount(value.holdAmount) === 0n : parseAmount(value.holdAmount) > 0n);
  }
  async function preview() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    let baseAmount = amount;
    if (sizeUnit === 'quote') {
      try {
        if (type !== 'limit') throw tradeError('quoteValueEntryRequiresAKnownLimitPriceMarketQuoteBudget');
        baseAmount = baseQuantityForValue(amount, price, market.precision.amount);
      } catch (error) {
        setFailure(error instanceof Error ? tradeFailureFrom(error, 'error') : tradeRefusal('quoteValueConversionFailure', { reason: 'error' }));
        setBusy(false);
        busyRef.current = false;
        return;
      }
    }
    const draft = {
      symbol: market.symbol,
      side,
      type,
      amount: baseAmount,
      ...(type === 'limit' ? { price } : {}),
      timeInForce: tif,
      postOnly,
      clientOrderId: `desk:${crypto.randomUUID()}`,
    };
    const parsed = draftSchema.safeParse(draft);
    if (!parsed.success) {
      setFailure({ ok: false, reason: 'error', message: parsed.error.issues.map((row) => row.message).join(' ') });
    } else {
      const result = await api.preview(parsed.data);
      if (result.ok && (!result.data.orderable || result.data.refusals.length > 0 || previewMatchesMode(result.data)))
        setReview({ draft: parsed.data, preview: result.data });
      else if (result.ok)
        setFailure(tradeRefusal('theReservationDoesNotMatchThisMarketSLiveOrSimulated', { reason: 'invalid_response' }));
      else setFailure(result);
    }
    setBusy(false);
    busyRef.current = false;
  }
  async function send() {
    if (!review || busyRef.current || pending || !fresh) return;
    busyRef.current = true;
    setBusy(true);
    const identity: Pending = { kind: 'place', id: review.draft.clientOrderId, symbol: market.symbol, startedAt: Date.now() };
    if (!(await onIntent(identity))) {
      setBusy(false);
      busyRef.current = false;
      return;
    }
    const result = await api.place(review.draft, review.preview, (refreshed) => mounted.current && previewMatchesMode(refreshed));
    if (result.ok) {
      onResolved(identity);
      setReview(null);
      setAmount('');
      onStatus(
        <TradeMessage k={'orderPlacedOutcome'} params={() => ({
          orderLabel: copy.t(market.paper ? 'simulatedOrderLabel' : 'orderLabel'),
          id: result.data.id,
          status: result.data.status,
          filled: result.data.filled,
          remaining: result.data.remaining,
          base: market.base,
        })} />,
      );
    } else if (result.reason === 'changed') {
      onResolved(identity);
      if (previewMatchesMode(result.preview)) {
        setReview({ draft: review.draft, preview: result.preview });
        setFailure(tradeFailureFrom(result, 'error'));
      } else {
        setReview(null);
        setFailure(tradeRefusal('theRefreshedReservationDoesNotMatchThisLiveOrSimulatedMarket', { reason: 'invalid_response' }));
      }
    } else {
      setFailure(result);
      if (result.reason !== 'uncertain') onResolved(identity);
    }
    setBusy(false);
    busyRef.current = false;
  }
  function size(percent: bigint) {
    if (available === undefined) return;
    if (sizeUnit === 'quote') {
      try {
        if (type !== 'limit' || parseAmount(price) <= 0n) return;
      } catch {
        return;
      }
    }
    let base = available;
    if (side === 'buy') {
      if (type !== 'limit' || !price) return;
      try {
        const p = parseAmount(price);
        if (p <= 0n) return;
        base = formatAmount((parseAmount(available) * parseAmount('1')) / p);
      } catch {
        return;
      }
    }
    const value = portionInLots(base, percent, market.precision.amount);
    if (value !== null) change(() => setAmount(sizeUnit === 'quote' ? exactValue(price, value) : value));
  }
  const blocked =
    !session ||
    !market.orderable ||
    !market.active ||
    !market.sessionOpen ||
    !fresh ||
    Boolean(pending) ||
    (available === undefined && !market.paper);
  const knownLimitPrice = (() => {
    try {
      return type === 'limit' && parseAmount(price) > 0n;
    } catch {
      return false;
    }
  })();
  const draftOrderValue = (() => {
    if (type !== 'limit') return null;
    try {
      const baseAmount = sizeUnit === 'quote' ? baseQuantityForValue(amount, price, market.precision.amount) : amount;
      const priceAmount = parseAmount(price),
        quantity = parseAmount(baseAmount),
        scale = parseAmount('1');
      if (priceAmount <= 0n || quantity <= 0n || (priceAmount * quantity) % scale !== 0n) return null;
      const value = exactValue(price, baseAmount);
      parseAmount(value); // Refuse an out-of-range value rather than crashing its display.
      return value;
    } catch {
      return null;
    }
  })();
  return (
    <section
      className="trade-ticket"
      aria-label={copy.t('spotOrderTicket')}
      onKeyDown={(event) => {
        if (
          event.key === 'Enter' &&
          (event.ctrlKey || event.metaKey) &&
          matchMedia('(pointer: fine)').matches &&
          !blocked &&
          !busyRef.current
        ) {
          event.preventDefault();
          if (review) void send();
          else void preview();
        }
      }}
    >
      <div className="trade-panel-title">
        <h2>
          <CopyText k="trade" />
        </h2>
        <a href={`/trade/bots${market.paper ? '?simulated=true' : ''}`}>
          <CopyText k="tools" />
        </a>
      </div>
      <div className="trade-ticket-body">
        <div className="trade-ticket-context">
          <CopyText k="personal" />
          {market.symbol}
          <span>{market.paper ? <CopyText k={'simulatedSpot'} /> : <CopyText k={'spot74f809'} />}</span>
        </div>
        <Tabs
          labels={tradeLabels}
          items={['Buy', 'Sell']}
          value={side === 'buy' ? 'Buy' : 'Sell'}
          onChange={(value) => change(() => setSide(value === 'Buy' ? 'buy' : 'sell'))}
          label={copy.t('orderSide')}
        />
        <Tabs
          labels={tradeLabels}
          items={['Limit', 'Market']}
          value={type === 'limit' ? 'Limit' : 'Market'}
          onChange={(value) =>
            change(() => {
              setType(value === 'Limit' ? 'limit' : 'market');
              if (value === 'Market') {
                setPostOnly(false);
                if (sizeUnit === 'quote') {
                  setSizeUnit('base');
                  setAmount('');
                }
              }
            })
          }
          label={copy.t('orderType')}
        />
        {review ? (
          <>
            <h3>
              <CopyText k={side === 'buy' ? 'reviewBuy' : 'reviewSell'} />
            </h3>
            {preferences.confirmSend && (
              <p className="trade-refusal">
                <CopyText k="ordersCanFillBeforeYouCanCancelConfirmTheMarketSide" />
              </p>
            )}
            <dl className="trade-review">
              <div>
                <dt>
                  <CopyText k="market" />
                </dt>
                <dd>{review.draft.symbol}</dd>
              </div>
              <div>
                <dt>
                  <CopyText k="baseQuantity" />
                </dt>
                <dd>
                  {displayAmount(review.draft.amount)} {market.base}
                </dd>
              </div>
              {sizeUnit === 'quote' && (
                <div>
                  <dt>
                    <CopyText k="requestedOrderValue" />
                  </dt>
                  <dd>
                    {displayAmount(amount)} {market.quote} <CopyText k="beforeFeesRoundedDownToWholeLots" />
                  </dd>
                </div>
              )}
              <div>
                <dt>
                  <CopyText k="limitPrice" />
                </dt>
                <dd>
                  {displayAmount(review.preview.price)} {market.quote}
                </dd>
              </div>
              <div>
                <dt>{review.preview.price ? <CopyText k={'limitOrderValue'} /> : <CopyText k={'protectedMaximumValue'} />}</dt>
                <dd>
                  {review.preview.price || review.preview.protectionPrice ? (
                    displayAmount(exactValue(review.preview.price ?? review.preview.protectionPrice ?? '0', review.draft.amount))
                  ) : (
                    <CopyText k={'unavailable'} />
                  )}{' '}
                  {market.quote}
                </dd>
              </div>
              <div>
                <dt>
                  <CopyText k="conditions" />
                </dt>
                <dd>{review.preview.timeInForce}</dd>
              </div>
              <div>
                <dt>
                  <CopyText k="protectionPrice" />
                </dt>
                <dd>
                  {displayAmount(review.preview.protectionPrice)} {market.quote}
                </dd>
              </div>
              <div>
                <dt>
                  <CopyText k="estimatedFee" />
                </dt>
                <dd>
                  {displayAmount(review.preview.estimatedFee)} {review.preview.feeAsset ?? ''}
                </dd>
              </div>
              <div>
                <dt>
                  <CopyText k="expectedReservation" />
                </dt>
                <dd>
                  {displayAmount(review.preview.holdAmount)} {review.preview.holdAsset ?? ''}
                </dd>
              </div>
            </dl>
            {review.preview.refusals.map((row) => (
              <p className="trade-refusal" lang="und" key={`${row.code}:${row.field}`}>
                {row.message}
              </p>
            ))}
            <small>
              <CopyText k="feesAndReservationRefreshBeforeConfirmationTheFinalFillMayDiffer" />
            </small>
            {(review.preview.estimatedFee === null ||
              review.preview.feeAsset === null ||
              review.preview.holdAmount === null ||
              review.preview.holdAsset === null) && (
              <p className="trade-refusal">
                <CopyText k="theServiceHasNotSuppliedACompleteFeeAndReservationSending" />
              </p>
            )}
            <Button
              disabled={
                busy ||
                blocked ||
                !review.preview.orderable ||
                review.preview.estimatedFee === null ||
                review.preview.feeAsset === null ||
                review.preview.holdAsset === null ||
                !previewMatchesMode(review.preview)
              }
              onClick={send}
            >
              {busy ? (
                <CopyText k={'checkingAndPlacing'} />
              ) : (
                <CopyText
                  k={'place'}
                  params={{
                    marketPaperSimulated: market.paper ? copy.t('simulatedPrefix') : '',
                    side: choiceText(side === 'buy' ? 'Buy' : 'Sell').toLocaleLowerCase(preferences.language),
                  }}
                />
              )}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => setReview(null)}>
              <CopyText k="backToEdit" />
            </Button>
          </>
        ) : (
          <>
            {type === 'limit' && (
              <Field
                label={<CopyText k={'pricePer'} params={{ marketQuote: String(market.quote), marketBase: String(market.base) }} />}
                inputMode="decimal"
                autoComplete="off"
                value={price}
                onChange={(event) => change(() => setPrice(event.target.value))}
              />
            )}
            <Field
              label={
                sizeUnit === 'base' ? (
                  <CopyText k={'amount'} params={{ marketBase: String(market.base) }} />
                ) : (
                  <CopyText k={'orderValue'} params={{ marketQuote: String(market.quote) }} />
                )
              }
              hint={
                sizeUnit === 'base' ? (
                  <CopyText
                    k={'baseQuantityLot'}
                    params={{ marketPrecisionAmount: String(market.precision.amount), marketBase: String(market.base) }}
                  />
                ) : (
                  <CopyText
                    k={'beforeFeesConvertsAtYourLimitPriceRoundedDownToLots'}
                    params={{ marketPrecisionAmount: String(market.precision.amount), marketBase: String(market.base) }}
                  />
                )
              }
              inputMode="decimal"
              autoComplete="off"
              value={amount}
              onChange={(event) => change(() => setAmount(event.target.value))}
            />
            <div className="trade-draft-value" role="group" aria-label={copy.t('draftOrderValue')}>
              <div>
                <CopyText k="orderValuefa10dc" />
                <strong className="numeric">{draftOrderValue === null ? '—' : `${displayAmount(draftOrderValue)} ${market.quote}`}</strong>
              </div>
              <small>
                <CopyText
                  k={
                    type === 'market'
                      ? 'marketValueConfirmedInReview'
                      : draftOrderValue === null
                        ? 'draftValueNeedsInputs'
                        : 'draftValueBeforeFees'
                  }
                />
              </small>
            </div>
            <label className="trade-inline">
              <CopyText k="sizeUnits" />
              <select
                aria-label={copy.t('sizeUnits7a869e')}
                value={sizeUnit}
                onChange={(event) =>
                  change(() => {
                    setSizeUnit(event.target.value as 'base' | 'quote');
                    setAmount('');
                  })
                }
              >
                <option value="base">
                  {market.base} {copy.t('quantity')}
                </option>
                <option value="quote" disabled={type !== 'limit'}>
                  {market.quote} {copy.t('limitOrderValuebbc0ce')}
                </option>
              </select>
            </label>
            {type === 'market' && (
              <small className="muted">
                <CopyText k="marketOrdersUseBaseQuantityQuoteBudgetExecutionHasNoMounted" />
              </small>
            )}
            <div className="trade-size-presets">
              {[25n, 50n, 75n, 100n].map((percent) => (
                <button
                  key={percent.toString()}
                  disabled={available === undefined || ((side === 'buy' || sizeUnit === 'quote') && !knownLimitPrice)}
                  onClick={() => size(percent)}
                >
                  {percent.toString()}%
                </button>
              ))}
            </div>
            <dl className="trade-review">
              <div>
                <dt>
                  <CopyText k="available" />
                  {side === 'buy' ? market.quote : market.base}
                </dt>
                <dd>{preferences.hideBalances ? '••••' : displayAmount(available)}</dd>
              </div>
              <div>
                <dt>
                  <CopyText k="minimumQuantity" />
                </dt>
                <dd>
                  {displayAmount(market.limits.amount.min)} {market.base}
                </dd>
              </div>
              <div>
                <dt>
                  <CopyText k="minimumValue" />
                </dt>
                <dd>
                  {displayAmount(market.limits.cost.min)} {market.quote}
                </dd>
              </div>
            </dl>
            <label className="trade-inline">
              <CopyText k="timeInForce" />
              <select value={tif} onChange={(event) => change(() => setTif(event.target.value as typeof tif))}>
                {['GTC', 'IOC', 'FOK'].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
            </label>
            <label className="trade-inline">
              <input
                type="checkbox"
                checked={postOnly}
                disabled={type === 'market' || tif !== 'GTC'}
                onChange={(event) => change(() => setPostOnly(event.target.checked))}
              />
              <CopyText k="postOnly" />
            </label>
            <Button disabled={blocked || busy} onClick={preview}>
              {busy ? <CopyText k={'checkingOrder'} /> : <CopyText k={side === 'buy' ? 'reviewBuy' : 'reviewSell'} />}
            </Button>
            <a
              className="text-link"
              href={`/trade/convert?asset=${encodeURIComponent(market.base)}${market.paper ? '&simulated=true' : ''}`}
            >
              <CopyText k="convert" />
              {market.base} ↗
            </a>
            <small className="muted">
              <CopyText k="ctrlEnterReviewsFromAReviewedTicketItSendsOrderType" />
            </small>
            <details>
              <summary>
                <CopyText k="advancedOrderCapability" />
              </summary>
              <p>
                <CopyText k="stopsAndStopLimitOrdersRequireTriggerTimeFundingAdmissionThat" />
              </p>
            </details>
          </>
        )}
        {!session ? (
          <a
            className="text-link"
            href={`/login?redirect=${encodeURIComponent(`/exchange/${encodeURIComponent(market.symbol)}${market.paper ? '?simulated=true' : ''}`)}`}
          >
            <CopyText k="signInToTrade" />
          </a>
        ) : (
          blocked && (
            <p className="trade-note" role="status">
              {pending ? (
                <CopyText k={'resolveTheOriginalRequestBeforeANewEntry'} />
              ) : !fresh ? (
                <CopyText k={'waitingForAVerifiedCurrentOrderBook'} />
              ) : available === undefined ? (
                <CopyText k={'availableFundsAreUnavailable'} />
              ) : !market.sessionOpen ? (
                <CopyText k={'theTradingSessionIsClosed'} />
              ) : (
                <CopyText k={'thisListingIsNotEnabledForNewOrders'} />
              )}
            </p>
          )
        )}
        {failure && <Failure result={failure} />}
      </div>
    </section>
  );
}
function OrderBlotter({
  api,
  initialTab,
  open,
  openLimit,
  onOpenLimitChange,
  market,
  onManage,
  locked,
  accountWideAllowed = true,
  allowCancel = true,
}: {
  api: TradeApi;
  initialTab: string;
  open: ReturnType<typeof usePolled<Order[]>>;
  openLimit: number;
  onOpenLimitChange: (limit: number) => void;
  market?: Listing;
  onManage: (order: Order, kind: 'cancel' | 'amend' | 'replace') => void;
  locked: boolean;
  accountWideAllowed?: boolean;
  allowCancel?: boolean;
}) {
  const [tab, setTab] = useState(initialTab),
    [all, setAll] = useState(!market),
    [limit, setLimit] = useState(100);
  useEffect(() => setTab(initialTab), [initialTab]);
  const { userId } = useSession();
  const key = `${userId}:${market?.id ?? 'account'}:${all}:${limit}:${accountWideAllowed}`;
  const scope = all || !market ? undefined : market.symbol;
  const unavailableHistory = copy.t('unavailableSimulationHistory');
  const history = useResource(
      (signal) =>
        !market && !accountWideAllowed
          ? Promise.resolve(unavailable<Order[]>(unavailableHistory))
          : api.orders('closed', scope, limit, signal),
      key,
    ),
    fills = useResource(
      (signal) => (!market && !accountWideAllowed ? Promise.resolve(unavailable(unavailableHistory)) : api.fills(scope, limit, signal)),
      key,
    );
  const data = tab === 'Open orders' ? open : history;
  return (
    <section className="trade-blotter">
      <div className="trade-blotter-toolbar">
        <Tabs
          labels={tradeLabels}
          items={['Open orders', 'History', 'Fills']}
          value={tab}
          onChange={setTab}
          label={copy.t('orderManagement')}
        />
        <label className="trade-inline">
          <input
            type="checkbox"
            checked={all}
            disabled={!market || market.paper}
            title={market?.paper ? copy.t('simulatedHistoryIsScopedToThisPublishedPaperMarketTheOrder') : undefined}
            onChange={(event) => setAll(event.target.checked)}
          />
          <CopyText k="allMarkets6034a2" />
        </label>
        <button
          onClick={() => {
            open.reload();
            history.reload();
            fills.reload();
          }}
        >
          <CopyText k="refresh" />
        </button>
      </div>
      {tab === 'Fills' ? (
        <ResourceView resource={fills.resource} retry={fills.reload}>
          {(rows) =>
            rows.length ? (
              <DataTable
                label={copy.t('privateFills')}
                headers={[
                  <CopyText k={'time'} />,
                  <CopyText k={'market'} />,
                  <CopyText k={'side'} />,
                  <CopyText k={'price93c91c'} />,
                  <CopyText k={'quantity822bab'} />,
                  <CopyText k={'value'} />,
                  <CopyText k={'fee'} />,
                ]}
              >
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>{tradeDate(row.timestamp)}</td>
                    <td lang="zxx">{row.symbol}</td>
                    <td lang="zxx">{row.side}</td>
                    <td>
                      {displayAmount(row.price)} {market?.symbol === row.symbol ? market.quote : ''}
                    </td>
                    <td>
                      {displayAmount(row.amount)} {market?.symbol === row.symbol ? market.base : ''}
                    </td>
                    <td>{displayAmount(row.cost)}</td>
                    <td>{row.fee ? `${displayAmount(row.fee.cost)} ${row.fee.currency}` : <CopyText k={'unavailable'} />}</td>
                  </tr>
                ))}
              </DataTable>
            ) : (
              <EmptyState title={<CopyText k={'noFillsInThisPage'} />} />
            )
          }
        </ResourceView>
      ) : (
        <ResourceView resource={data.resource} retry={data.reload}>
          {(rows) => {
            const scoped = all || !market ? rows : rows.filter((row) => row.symbol === market.symbol);
            return scoped.length ? (
              <DataTable
                label={tab}
                headers={[
                  <CopyText k={'time'} />,
                  <CopyText k={'market'} />,
                  <CopyText k={'sideType'} />,
                  <CopyText k={'price93c91c'} />,
                  <CopyText k={'quantityFilled'} />,
                  <CopyText k={'remaining'} />,
                  <CopyText k={'status'} />,
                  <CopyText k={'actions'} />,
                ]}
              >
                {scoped.map((order) => (
                  <tr key={order.id}>
                    <td>{tradeDate(order.timestamp, 'time')}</td>
                    <td lang="zxx">{order.symbol}</td>
                    <td>
                      {order.side} · {order.type}
                    </td>
                    <td>
                      {displayAmount(order.price)} {market?.symbol === order.symbol ? market.quote : ''}
                    </td>
                    <td>
                      {displayAmount(order.amount)} / {displayAmount(order.filled)} {market?.symbol === order.symbol ? market.base : ''}
                    </td>
                    <td>
                      {displayAmount(order.remaining)} {market?.symbol === order.symbol ? market.base : ''}
                    </td>
                    <td lang="zxx">{order.status}</td>
                    <td>
                      {order.status === 'open' && (
                        <div className="trade-row-actions">
                          <button
                            disabled={locked || !market || market.paper || order.symbol !== market.symbol}
                            title={
                              !market || order.symbol !== market.symbol
                                ? copy.t('quantityChangesRequireThisOrderSPublishedMarketRules')
                                : market.paper
                                  ? copy.t('nativeAmendmentRequiresTheLiveSpotMatchingPath')
                                  : undefined
                            }
                            onClick={() => onManage(order, 'amend')}
                          >
                            <CopyText k="reduce" />
                          </button>
                          <button
                            disabled={
                              locked ||
                              !market ||
                              order.type !== 'limit' ||
                              parseAmount(order.filled) > 0n ||
                              market.paper ||
                              order.symbol !== market.symbol
                            }
                            title={copy.t('cancelReplaceIsAvailableForUnfilledLimitOrdersInTheSelected')}
                            onClick={() => onManage(order, 'replace')}
                          >
                            <CopyText k="changePrice" />
                          </button>
                          <button disabled={locked || !allowCancel || order.recoveryRequired} onClick={() => onManage(order, 'cancel')}>
                            <CopyText k="cancel" />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </DataTable>
            ) : (
              <EmptyState title={<CopyText k={'noInThisPage'} params={{ tabToLowerCase: choiceText(tab).toLocaleLowerCase() }} />} />
            );
          }}
        </ResourceView>
      )}
      {tab === 'Open orders' && open.resource.status === 'ready' && open.resource.data.length >= openLimit && (
        <Button variant="ghost" disabled={openLimit === 500} onClick={() => onOpenLimitChange(Math.min(500, openLimit + 100))}>
          {openLimit === 500 ? <CopyText k={'rowPageLimitReached'} /> : <CopyText k={'loadMoreRecords'} />}
        </Button>
      )}
      {(tab === 'Fills'
        ? fills.resource.status === 'ready' && fills.resource.data.length >= limit
        : tab === 'History' && history.resource.status === 'ready' && history.resource.data.length >= limit) && (
        <Button variant="ghost" disabled={limit === 500} onClick={() => setLimit(Math.min(500, limit + 100))}>
          {limit === 500 ? <CopyText k={'rowPageLimitReached'} /> : <CopyText k={'loadMoreRecords'} />}
        </Button>
      )}
      <small className="trade-note">
        {!market && <CopyText k={'accountWideRecordsUnitLabelsAndQuantityPriceChangesRequirePublished'} />}
        {tab === 'Open orders' ? (
          <CopyText k={'workingOrderWindowRefreshConfirmsCurrentState'} params={{ limit: String(openLimit) }} />
        ) : (
          <CopyText k={'newestRecordsUpToPerServicePageAPageIsNot'} />
        )}
      </small>
    </section>
  );
}
function ManageOrder({
  api,
  market,
  selection,
  onClose,
  onIntent,
  onResolved,
  onStatus,
  canDispatch,
}: {
  api: TradeApi;
  market?: Listing;
  selection: { order: Order; kind: 'cancel' | 'amend' };
  onClose: () => void;
  onIntent: (pending: Pending) => Promise<boolean>;
  onResolved: (identity: Pending) => void;
  onStatus: (status: ReactNode) => void;
  canDispatch: () => boolean;
}) {
  const preferences = usePreferences();
  const [amount, setAmount] = useState(selection.order.remaining),
    [busy, setBusy] = useState(false),
    [failure, setFailure] = useState<Extract<ApiResult<unknown>, { ok: false }> | null>(null),
    [current, setCurrent] = useState(selection.order);
  const busyRef = useRef(false),
    mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (selection.kind === 'cancel' && !preferences.confirmCancel) void commit();
  }, []);
  async function commit() {
    if (busyRef.current || !mounted.current || !canDispatch()) return;
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    const latest = await api.order(current);
    if (!mounted.current || !canDispatch()) return;
    if (latest.ok && latest.data.recoveryRequired) {
      setFailure(tradeRefusal('thisOrderIsRecoveringResolveItsOriginalOutcomeBeforeAnotherAction', { reason: 'uncertain' }));
      setBusy(false);
      busyRef.current = false;
      return;
    }
    if (!latest.ok) {
      setFailure(latest);
      setBusy(false);
      busyRef.current = false;
      return;
    }
    if (latest.data.symbol !== current.symbol) {
      setFailure(tradeRefusal('theOriginalOrderSMarketCouldNotBeVerifiedNoNew', { reason: 'invalid_response' }));
      setBusy(false);
      busyRef.current = false;
      return;
    }
    if (latest.data.status !== 'open') {
      onStatus(<CopyText k={'orderAlreadyOutcome'} params={{ id: current.id, status: latest.data.status, filled: latest.data.filled }} />);
      onClose();
      return;
    }
    if (latest.data.filled !== current.filled || latest.data.remaining !== current.remaining) {
      setCurrent(latest.data);
      setFailure(tradeRefusal('thisOrderFilledWhileYouWereReviewingReviewItsRefreshedRemainder', { reason: 'error' }));
      setBusy(false);
      busyRef.current = false;
      return;
    }
    if (selection.kind === 'amend') {
      try {
        if (parseAmount(amount) <= 0n || parseAmount(amount) >= parseAmount(current.remaining)) throw new Error();
      } catch {
        setFailure(tradeRefusal('enterAPositiveRemainingQuantityBelowTheCurrentRemainderUseChange', { reason: 'error' }));
        setBusy(false);
        busyRef.current = false;
        return;
      }
    }
    if (!mounted.current || !canDispatch()) return;
    const identity: Pending = {
      kind: selection.kind,
      id: current.id,
      symbol: current.symbol,
      orderId: current.id,
      startedAt: Date.now(),
      ...(selection.kind === 'amend' ? { expectedAmount: amount, originalAmount: current.amount } : {}),
    };
    if (!(await onIntent(identity))) {
      onClose();
      return;
    }
    if (!mounted.current || !canDispatch()) {
      onResolved(identity);
      return;
    }
    const result = selection.kind === 'cancel' ? await api.cancel(current) : await api.amend(current, amount);
    if (result.ok) {
      if (
        ('reconciliationRequired' in result.data && result.data.reconciliationRequired) ||
        ('recoveryRequired' in result.data && result.data.recoveryRequired)
      ) {
        onStatus(<CopyText k={selection.kind === 'cancel' ? 'cancellationUnknown' : 'amendmentUnknown'} />);
      } else {
        onResolved(identity);
        const order = 'order' in result.data ? result.data.order : result.data;
        onStatus(
          <TradeMessage k={'managedOrderOutcome'} params={() => ({
            amendment:
              'accepted' in result.data
                ? copy.t('amendmentOutcome', {
                    accepted: copy.t(result.data.accepted ? 'amendmentAccepted' : 'amendmentRefused'),
                    code: result.data.code,
                  })
                : '',
            id: order.id,
            status: order.status,
            filled: order.filled,
            remaining: order.remaining,
            priority:
              'priority' in result.data && result.data.priority ? copy.t('queuePriorityOutcome', { priority: result.data.priority }) : '',
          })} />,
        );
      }
      onClose();
    } else {
      setFailure(result);
      if (result.reason !== 'uncertain') onResolved(identity);
      else onClose();
    }
    setBusy(false);
    busyRef.current = false;
  }
  return (
    <Dialog
      title={selection.kind === 'cancel' ? <CopyText k={'cancelWorkingOrder'} /> : <CopyText k={'reduceWorkingOrderQuantity'} />}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p>
        {current.symbol} · {current.side} {current.type} · {current.id}
      </p>
      <dl className="trade-review">
        <div>
          <dt>
            <CopyText k="filled" />
          </dt>
          <dd>
            {displayAmount(current.filled)} {market?.symbol === current.symbol ? market.base : ''}
          </dd>
        </div>
        <div>
          <dt>
            <CopyText k="remaining" />
          </dt>
          <dd>
            {displayAmount(current.remaining)} {market?.symbol === current.symbol ? market.base : ''}
          </dd>
        </div>
        <div>
          <dt>
            <CopyText k="limitPrice" />
          </dt>
          <dd>
            {displayAmount(current.price)} {market?.symbol === current.symbol ? market.quote : ''}
          </dd>
        </div>
      </dl>
      {selection.kind === 'amend' && (
        <Field
          label={
            <CopyText
              k={'newRemainingQuantity'}
              params={{ marketSymbolCurrentSymbol: String(market?.symbol === current.symbol ? ` (${market.base})` : '') }}
            />
          }
          value={amount}
          inputMode="decimal"
          onChange={(event) => setAmount(event.target.value)}
        />
      )}
      <p className="muted">
        {selection.kind === 'cancel' ? (
          <CopyText k={'aFillMayWinTheCancellationRaceFundsRefreshFromThe'} />
        ) : (
          <CopyText k={'quantityReductionAtTheSamePriceUsesNativeAmendmentTheService'} />
        )}
      </p>
      {failure && <Failure result={failure} />}
      <div className="actions">
        <Button variant="secondary" disabled={busy} onClick={onClose}>
          <CopyText k="keepOrder" />
        </Button>
        <Button variant={selection.kind === 'cancel' ? 'danger' : 'primary'} disabled={busy} onClick={commit}>
          {busy ? (
            <CopyText k={'checkingOrder'} />
          ) : selection.kind === 'cancel' ? (
            <CopyText k={'confirmCancellation'} />
          ) : (
            <CopyText k={'confirmReduction'} />
          )}
        </Button>
      </div>
    </Dialog>
  );
}
