import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { z } from 'zod';
import { useApi, useSession } from '../session/session';
import { usePreferences } from '../../shared/preferences';
import { navigate } from '../../app/location';
import { useResource, type Resource } from '../../shared/resource';
import { Button, DataTable, Dialog, EmptyState, Failure, Field, Loading, Tabs } from '../../shared/ui';
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
    <div className="trade-root">
      <nav className="trade-modes" aria-label="Trading modes">
        <div className="trade-mode-links">
          {modes.map((mode) => (
            <a
              key={mode}
              aria-current={activeMode === mode ? 'page' : undefined}
              href={`${modeRoutes[mode]}${simulation ? '?simulated=true' : ''}`}
            >
              {mode}
            </a>
          ))}
        </div>
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
          Simulated
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
            <button className="trade-market-select" onClick={() => setPicker(true)} aria-label="Choose trading market">
              <strong>{market?.symbol ?? 'Choose market'}</strong>
              <span>⌄</span>
            </button>
            <span className="trade-badge">{simulation ? 'SIMULATED' : 'SPOT'}</span>
            {market ? <MarketFacts api={api} market={market} /> : <span className="muted">Market information unavailable</span>}
            <a className="text-link" href="/money">
              Account funds ↗
            </a>
          </header>
          <div className={`trade-favorites ${preferences.favoritesView === 'cards' ? 'trade-favorites--cards' : ''}`}>
            <span className="muted">Favorites</span>
            {market && (
              <button
                aria-label={favorites.includes(market.symbol) ? 'Remove market from favorites' : 'Add market to favorites'}
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
            <button onClick={() => setPicker(true)}>All markets</button>
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
                simulation
                  ? 'No simulated spot market is published'
                  : routePair
                    ? 'This market is not available in this mode'
                    : 'No spot markets are published'
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
    (children(resource.data) ?? <EmptyState title={empty ?? 'No records'} />)
  );
}
function MarketPicker({
  markets,
  resource,
  retry,
  onSelect,
  onClose,
}: {
  markets: Listing[];
  resource: Resource<Listing[]>;
  retry: () => void;
  onSelect: (market: Listing) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  return (
    <Dialog title="Choose market" onClose={onClose}>
      <Field label="Search markets" autoFocus value={query} onChange={(event) => setQuery(event.target.value)} />
      <div className="trade-picker">
        {resource.status === 'loading' && <Loading label="Loading published markets" />}
        {resource.status === 'failed' && <Failure result={resource.failure} retry={retry} />}
        {markets
          .filter((market) => `${market.symbol} ${market.base} ${market.quote}`.toLowerCase().includes(query.toLowerCase()))
          .map((market) => (
            <button key={market.id} onClick={() => onSelect(market)}>
              <strong>{market.symbol}</strong>
              <span>{market.paper ? 'Simulated' : market.orderable && market.sessionOpen ? 'Published for trading' : 'Restricted'}</span>
            </button>
          ))}
        {resource.status === 'ready' &&
          !markets.some((market) => `${market.symbol} ${market.base} ${market.quote}`.toLowerCase().includes(query.toLowerCase())) && (
            <p>No matching published markets in this mode.</p>
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
        <span>Last price · {market.quote}</span>
        <strong className="numeric">{ticker.resource.status === 'ready' ? displayAmount(ticker.resource.data.last) : '—'}</strong>
      </div>
      <div>
        <span>24h change</span>
        <strong>{ticker.resource.status === 'ready' ? displayAmount(ticker.resource.data.percentage) : '—'}</strong>
      </div>
      <div>
        <span>Market status</span>
        <strong>
          {!market.active ? 'Inactive' : !market.sessionOpen ? 'Session closed' : !market.orderable ? 'Entry restricted' : 'Published'}
        </strong>
      </div>
      {ticker.resource.status === 'failed' && <span role="status">Price unavailable</span>}
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
function useTradeRequests(api: TradeApi, accountKey: string, refresh: () => void, accountWide = false) {
  const [pending, setPending] = useState<Pending | null>(() => readPending(accountKey)),
    [status, setStatus] = useState(''),
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
        setStatus('Browser storage cannot preserve this request identity. Enable device storage before submitting.');
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
          setStatus('The active trading request changed. This older result cannot clear its recovery marker.');
          return false;
        }
        localStorage.removeItem(pendingKey(accountKey));
      } catch {
        setStatus('The outcome is confirmed, but its device marker could not be cleared. Restore storage access before another action.');
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
      setStatus('This browser cannot coordinate trading requests across tabs. Use a browser with Web Locks before submitting.');
      return false;
    }
    return new Promise<boolean>((resolve) => {
      void navigator.locks.request(`trade-account:${accountKey}`, { ifAvailable: true }, async (lock) => {
        if (!lock) {
          setStatus('Another tab is processing a trading request.');
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
            setStatus('The saved trading request cannot be read. Preserve device storage and contact support before another action.');
            resolve(false);
            return;
          }
        } catch {
          setStatus('Device storage is unavailable. Trading cannot preserve a request identity.');
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
        `This ${pending.kind} request must be checked in its original trading tool. Contact support with ${pending.id} if its outcome cannot be read.`,
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
          `Original ${original.data.id}: ${original.data.status}. Replacement ${replacement.data.id}: ${replacement.data.status}, remaining ${replacement.data.remaining}.`,
        );
      } else
        setStatus(
          `Cancel/replace is unresolved. ${!original.ok ? original.message : `Original ${original.data.status}.`} ${!replacement.ok ? replacement.message : `Replacement ${replacement.data.status}.`} No new request has been sent.`,
        );
      refresh();
      setChecking(false);
      return;
    }
    const result = pending.orderId ? await api.order({ id: pending.orderId, symbol: pending.symbol }) : await api.reconcile(pending.id, pending.symbol, accountWide);
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
        setStatus(`Order ${result.data.id}: ${result.data.status}. Filled ${result.data.filled}; remaining ${result.data.remaining}.`);
      } else
        setStatus(
          `Order ${result.data.id} is still open. The ${pending.kind} outcome is unresolved; funds remain as reported by the ledger.`,
        );
    } else setStatus(result.message);
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
  const book = useLinkedBook(api, market),
    balances = usePolled(
      (signal) =>
        market.paper
          ? Promise.resolve(unavailable('A simulated balance contract is not mounted. Paper orders do not use live ledger funds.'))
          : api.balances(signal),
      accountKey,
      20,
    ),
    open = usePolled((signal) => api.orders('open', market.paper ? market.symbol : undefined, 100, signal), accountKey, 10);
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
              <h3>{market.paper ? 'Simulation · no live funds' : 'Funds · Personal'}</h3>
              {market.paper ? (
                <p className="muted">
                  Paper orders use the service’s isolated paper path and zero ledger reservation. A simulated balance history is not
                  published; live balances are not read here.
                </p>
              ) : (
                <ResourceView resource={balances.resource} retry={balances.reload}>
                  {(data) => (
                    <dl>
                      {[market.quote, market.base].map((asset) => (
                        <div key={asset}>
                          <dt>Available {asset}</dt>
                          <dd className="numeric">{preferences.hideBalances ? '••••' : displayAmount(data.balances[asset]?.free)}</dd>
                          <dt>Held {asset}</dt>
                          <dd className="numeric">{preferences.hideBalances ? '••••' : displayAmount(data.balances[asset]?.used)}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </ResourceView>
              )}
              {!market.paper && (
                <a className="text-link" href="/money">
                  Manage in Money ↗
                </a>
              )}
            </section>
          </aside>
        }
      />
      {pending && (
        <div className="trade-uncertain" role="alert">
          <strong>Outcome not confirmed · {pending.kind}</strong>
          <p>
            {pending.symbol} · Request {pending.id}. New orders remain locked while this request is unresolved. No funds have been assumed
            released.
          </p>
          <Button variant="secondary" disabled={checking} onClick={reconcile}>
            {checking ? 'Checking status…' : 'Check original request status'}
          </Button>
          <a className="text-link" href="/support">
            Contact support
          </a>
        </div>
      )}
      {status && (
        <p className="trade-status" role="status">
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
  const open = usePolled(
    (signal) =>
      simulation
        ? Promise.resolve(unavailable<Order[]>('Account-wide simulation history cannot be verified without a published paper market.'))
        : api.orders('open', undefined, 100, signal),
    `${accountKey}:account-orders:${simulation}`,
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
    <section aria-label="Account order management">
      <OrderBlotter
        api={api}
        initialTab={initialTab}
        open={open}
        locked={Boolean(pending)}
        accountWideAllowed={!simulation}
        allowCancel={!simulation}
        onManage={(order, kind) => {
          if (kind === 'cancel') setManage(order);
        }}
      />
      {pending && (
        <div className="trade-uncertain" role="alert">
          <strong>Outcome not confirmed · {pending.kind}</strong>
          <p>
            {pending.symbol} · Request {pending.id}. Resolve this original request before another trading action. No funds have been assumed
            released.
          </p>
          <Button variant="secondary" disabled={checking} onClick={reconcile}>
            {checking ? 'Checking status…' : 'Check original request status'}
          </Button>
          <a className="text-link" href="/support">
            Contact support
          </a>
        </div>
      )}
      {status && (
        <p className="trade-status" role="status">
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
          aria-label={`Use ${price} ${market.quote} limit price`}
        >
          <span>{displayAmount(price)}</span>
          <span>{displayAmount(quantity)}</span>
          <span>{displayAmount(formatAmount(cumulative))}</span>
        </button>
      );
    });
  }
  return (
    <section className="trade-book" aria-label="Linked order book and public trades">
      <Tabs items={['Order book', 'Depth', 'Trades']} value={tab} onChange={setTab} label="Market data panel" />
      {tab === 'Depth' ? (
        <>
          <p className="trade-note">{book.book.fresh ? book.status : 'Depth stale or loading'} · Published levels, up to 200 per side.</p>
          {book.failure ? <Failure result={book.failure} /> : <DepthPlot market={market} book={book.book} onStagePrice={onStagePrice} />}
        </>
      ) : tab === 'Order book' ? (
        <>
          <div className="trade-book-controls">
            <select aria-label="Book side" value={sides} onChange={(event) => setSides(event.target.value)}>
              {['Both', 'Bids', 'Asks'].map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
            <span className={book.book.fresh ? 'positive' : 'muted'}>{book.book.fresh ? book.status : 'Depth stale or loading'}</span>
          </div>
          <div className="trade-book-head">
            <span>Price ({market.quote})</span>
            <span>Size ({market.base})</span>
            <span>Total ({market.base})</span>
          </div>
          {book.failure ? (
            <Failure result={book.failure} />
          ) : (
            <>
              {sides !== 'Bids' && <div className="trade-asks">{rows(book.book.asks, 'negative')}</div>}
              <div className="trade-book-mid">
                {book.book.asks[0]?.[0] && book.book.bids[0]?.[0]
                  ? `Spread ${displayAmount(formatAmount(parseAmount(book.book.asks[0][0]) - parseAmount(book.book.bids[0][0])))} ${market.quote}`
                  : 'No two-sided book'}
              </div>
              {sides !== 'Asks' && rows(book.book.bids, 'positive')}
              {book.book.sequence >= 0 && !book.book.bids.length && !book.book.asks.length && <EmptyState title="No resting orders" />}
            </>
          )}
          <small className="trade-note">
            Sequence {book.book.sequence < 0 ? '—' : book.book.sequence} · Select a price to stage a limit order.
          </small>
        </>
      ) : (
        <ResourceView resource={tape.resource} retry={tape.reload}>
          {(data) =>
            data.length ? (
              <>
                <div className="trade-book-head">
                  <span>Price ({market.quote})</span>
                  <span>Size ({market.base})</span>
                  <span>Time</span>
                </div>
                {data.map((row) => (
                  <div className={`trade-book-row ${row.side === 'buy' ? 'positive' : 'negative'}`} key={row.id}>
                    <span>{displayAmount(row.price)}</span>
                    <span>{displayAmount(row.amount)}</span>
                    <span>{new Date(row.timestamp).toLocaleTimeString()}</span>
                  </div>
                ))}
              </>
            ) : (
              <EmptyState title="No recent public trades">Your private fills appear in the Fills tab below.</EmptyState>
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
  if (!all.length) return <EmptyState title="No published depth" />;
  // Numeric conversion is confined to SVG coordinates; staging retains the original exact price string.
  const minimum = Math.min(...all.map((row) => Number(row.price))),
    maximum = Math.max(...all.map((row) => Number(row.price))),
    size = Math.max(...all.map((row) => Number(row.total))),
    width = maximum - minimum || 1;
  const x = (price: string) => 12 + ((Number(price) - minimum) / width) * 256,
    y = (total: string) => 240 - (Number(total) / (size || 1)) * 210;
  if (![minimum, maximum, size].every(Number.isFinite))
    return (
      <p className="trade-refusal">Published depth exceeds chart rendering limits. Exact levels remain available in the order book.</p>
    );
  return (
    <>
      <svg className="trade-depth-plot" viewBox="0 0 280 260" role="img" aria-label={`Actual cumulative ${market.symbol} depth`}>
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
                  {row.price} {market.quote} · cumulative {row.total} {market.base}
                </title>
              </circle>
            ))}
          </g>
        ))}
      </svg>
      <p className="trade-note">
        X: price in {market.quote} · Y: cumulative size in {market.base}. Select a depth point to stage its exact limit price.
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
  onStatus: (value: string) => void;
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
        if (type !== 'limit')
          throw new Error('Quote-value entry requires a known limit price. Market quote-budget admission is not mounted.');
        baseAmount = baseQuantityForValue(amount, price, market.precision.amount);
      } catch (error) {
        setFailure({
          ok: false,
          reason: 'error',
          message: error instanceof Error ? error.message : 'This quote value could not be converted into a base quantity.',
        });
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
        setFailure({
          ok: false,
          reason: 'invalid_response',
          message: 'The reservation does not match this market’s live or simulated funding mode. No order was sent.',
        });
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
        `${market.paper ? 'Simulated order' : 'Order'} ${result.data.id} is ${result.data.status}; filled ${result.data.filled} ${market.base}, remaining ${result.data.remaining} ${market.base}.`,
      );
    } else if (result.reason === 'changed') {
      onResolved(identity);
      if (previewMatchesMode(result.preview)) {
        setReview({ draft: review.draft, preview: result.preview });
        setFailure({ ok: false, reason: 'error', message: result.message });
      } else {
        setReview(null);
        setFailure({
          ok: false,
          reason: 'invalid_response',
          message: 'The refreshed reservation does not match this live or simulated market. No order was sent.',
        });
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
  return (
    <section
      className="trade-ticket"
      aria-label="Spot order ticket"
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
        <h2>Trade</h2>
        <a href={`/trade/bots${market.paper ? '?simulated=true' : ''}`}>Tools ↗</a>
      </div>
      <div className="trade-ticket-body">
        <div className="trade-ticket-context">
          Personal · {market.symbol}
          <span>{market.paper ? 'Simulated spot' : 'Spot'}</span>
        </div>
        <Tabs
          items={['Buy', 'Sell']}
          value={side === 'buy' ? 'Buy' : 'Sell'}
          onChange={(value) => change(() => setSide(value === 'Buy' ? 'buy' : 'sell'))}
          label="Order side"
        />
        <Tabs
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
          label="Order type"
        />
        {review ? (
          <>
            <h3>Review {side}</h3>
            {preferences.confirmSend && (
              <p className="trade-refusal">Orders can fill before you can cancel. Confirm the market, side, and quantity before sending.</p>
            )}
            <dl className="trade-review">
              <div>
                <dt>Market</dt>
                <dd>{review.draft.symbol}</dd>
              </div>
              <div>
                <dt>Base quantity</dt>
                <dd>
                  {displayAmount(review.draft.amount)} {market.base}
                </dd>
              </div>
              {sizeUnit === 'quote' && (
                <div>
                  <dt>Requested order value</dt>
                  <dd>
                    {displayAmount(amount)} {market.quote} before fees · rounded down to whole lots
                  </dd>
                </div>
              )}
              <div>
                <dt>Limit price</dt>
                <dd>
                  {displayAmount(review.preview.price)} {market.quote}
                </dd>
              </div>
              <div>
                <dt>{review.preview.price ? 'Limit order value' : 'Protected maximum value'}</dt>
                <dd>
                  {review.preview.price || review.preview.protectionPrice
                    ? displayAmount(exactValue(review.preview.price ?? review.preview.protectionPrice ?? '0', review.draft.amount))
                    : 'Unavailable'}{' '}
                  {market.quote}
                </dd>
              </div>
              <div>
                <dt>Conditions</dt>
                <dd>{review.preview.timeInForce}</dd>
              </div>
              <div>
                <dt>Protection price</dt>
                <dd>
                  {displayAmount(review.preview.protectionPrice)} {market.quote}
                </dd>
              </div>
              <div>
                <dt>Estimated fee</dt>
                <dd>
                  {displayAmount(review.preview.estimatedFee)} {review.preview.feeAsset ?? ''}
                </dd>
              </div>
              <div>
                <dt>Expected reservation</dt>
                <dd>
                  {displayAmount(review.preview.holdAmount)} {review.preview.holdAsset ?? ''}
                </dd>
              </div>
            </dl>
            {review.preview.refusals.map((row) => (
              <p className="trade-refusal" key={`${row.code}:${row.field}`}>
                {row.message}
              </p>
            ))}
            <small>Fees and reservation refresh before confirmation. The final fill may differ.</small>
            {(review.preview.estimatedFee === null ||
              review.preview.feeAsset === null ||
              review.preview.holdAmount === null ||
              review.preview.holdAsset === null) && (
              <p className="trade-refusal">
                The service has not supplied a complete fee and reservation. Sending remains disabled until those values are available.
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
              {busy ? 'Checking and placing…' : `Place ${market.paper ? 'simulated ' : ''}${side}`}
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => setReview(null)}>
              Back to edit
            </Button>
          </>
        ) : (
          <>
            {type === 'limit' && (
              <Field
                label={`Price (${market.quote} per ${market.base})`}
                inputMode="decimal"
                autoComplete="off"
                value={price}
                onChange={(event) => change(() => setPrice(event.target.value))}
              />
            )}
            <Field
              label={sizeUnit === 'base' ? `Amount (${market.base})` : `Order value (${market.quote})`}
              hint={
                sizeUnit === 'base'
                  ? `Base quantity. Lot ${market.precision.amount} ${market.base}.`
                  : `Before fees. Converts at your limit price, rounded down to ${market.precision.amount} ${market.base} lots.`
              }
              inputMode="decimal"
              autoComplete="off"
              value={amount}
              onChange={(event) => change(() => setAmount(event.target.value))}
            />
            <label className="trade-inline">
              Size units
              <select
                aria-label="Size units"
                value={sizeUnit}
                onChange={(event) =>
                  change(() => {
                    setSizeUnit(event.target.value as 'base' | 'quote');
                    setAmount('');
                  })
                }
              >
                <option value="base">{market.base} quantity</option>
                <option value="quote" disabled={type !== 'limit'}>
                  {market.quote} limit order value
                </option>
              </select>
            </label>
            {type === 'market' && (
              <small className="muted">
                Market orders use base quantity. Quote-budget execution has no mounted preview/admission contract.
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
                <dt>Available {side === 'buy' ? market.quote : market.base}</dt>
                <dd>{preferences.hideBalances ? '••••' : displayAmount(available)}</dd>
              </div>
              <div>
                <dt>Minimum quantity</dt>
                <dd>
                  {displayAmount(market.limits.amount.min)} {market.base}
                </dd>
              </div>
              <div>
                <dt>Minimum value</dt>
                <dd>
                  {displayAmount(market.limits.cost.min)} {market.quote}
                </dd>
              </div>
            </dl>
            <label className="trade-inline">
              Time in force
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
              Post only
            </label>
            <Button disabled={blocked || busy} onClick={preview}>
              {busy ? 'Checking order…' : `Review ${side}`}
            </Button>
            <a
              className="text-link"
              href={`/trade/convert?asset=${encodeURIComponent(market.base)}${market.paper ? '&simulated=true' : ''}`}
            >
              Convert {market.base} ↗
            </a>
            <small className="muted">
              Ctrl/⌘ Enter reviews; from a reviewed ticket it sends. Order type and timing stay on this device.
            </small>
            <details>
              <summary>Advanced order capability</summary>
              <p>
                Stops and stop-limit orders require trigger-time funding admission that the spot preview and placement paths do not support.
                Brackets, reduce only, trailing, and GTD cannot be submitted through this ticket. TWAP is in Bots.
              </p>
            </details>
          </>
        )}
        {!session ? (
          <a
            className="text-link"
            href={`/login?redirect=${encodeURIComponent(`/exchange/${encodeURIComponent(market.symbol)}${market.paper ? '?simulated=true' : ''}`)}`}
          >
            Sign in to trade
          </a>
        ) : (
          blocked && (
            <p className="trade-note" role="status">
              {pending
                ? 'Resolve the original request before a new entry.'
                : !fresh
                  ? 'Waiting for a verified current order book.'
                  : available === undefined
                    ? 'Available funds are unavailable.'
                    : !market.sessionOpen
                      ? 'The trading session is closed.'
                      : 'This listing is not enabled for new orders.'}
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
  market,
  onManage,
  locked,
  accountWideAllowed = true,
  allowCancel = true,
}: {
  api: TradeApi;
  initialTab: string;
  open: ReturnType<typeof usePolled<Order[]>>;
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
  const unavailableHistory = 'Account-wide simulation history cannot be verified without a published paper market.';
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
        <Tabs items={['Open orders', 'History', 'Fills']} value={tab} onChange={setTab} label="Order management" />
        <label className="trade-inline">
          <input
            type="checkbox"
            checked={all}
            disabled={!market || market.paper}
            title={
              market?.paper
                ? 'Simulated history is scoped to this published paper market; the order wire has no account simulation discriminator.'
                : undefined
            }
            onChange={(event) => setAll(event.target.checked)}
          />
          All markets
        </label>
        <button
          onClick={() => {
            open.reload();
            history.reload();
            fills.reload();
          }}
        >
          Refresh
        </button>
      </div>
      {tab === 'Fills' ? (
        <ResourceView resource={fills.resource} retry={fills.reload}>
          {(rows) =>
            rows.length ? (
              <DataTable label="Private fills" headers={['Time', 'Market', 'Side', 'Price', 'Quantity', 'Value', 'Fee']}>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td>{new Date(row.timestamp).toLocaleString()}</td>
                    <td>{row.symbol}</td>
                    <td>{row.side}</td>
                    <td>
                      {displayAmount(row.price)} {market?.symbol === row.symbol ? market.quote : ''}
                    </td>
                    <td>
                      {displayAmount(row.amount)} {market?.symbol === row.symbol ? market.base : ''}
                    </td>
                    <td>{displayAmount(row.cost)}</td>
                    <td>{row.fee ? `${displayAmount(row.fee.cost)} ${row.fee.currency}` : 'Unavailable'}</td>
                  </tr>
                ))}
              </DataTable>
            ) : (
              <EmptyState title="No fills in this page" />
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
                headers={['Time', 'Market', 'Side / type', 'Price', 'Quantity / filled', 'Remaining', 'Status', 'Actions']}
              >
                {scoped.map((order) => (
                  <tr key={order.id}>
                    <td>{new Date(order.timestamp).toLocaleTimeString()}</td>
                    <td>{order.symbol}</td>
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
                    <td>{order.status}</td>
                    <td>
                      {order.status === 'open' && (
                        <div className="trade-row-actions">
                          <button
                            disabled={locked || !market || market.paper || order.symbol !== market.symbol}
                            title={
                              !market || order.symbol !== market.symbol
                                ? 'Quantity changes require this order’s published market rules.'
                                : market.paper
                                  ? 'Native amendment requires the live spot matching path.'
                                  : undefined
                            }
                            onClick={() => onManage(order, 'amend')}
                          >
                            Reduce
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
                            title="Cancel/replace is available for unfilled limit orders in the selected live spot market."
                            onClick={() => onManage(order, 'replace')}
                          >
                            Change price
                          </button>
                          <button disabled={locked || !allowCancel || order.recoveryRequired} onClick={() => onManage(order, 'cancel')}>
                            Cancel
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </DataTable>
            ) : (
              <EmptyState title={`No ${tab.toLowerCase()} in this page`} />
            );
          }}
        </ResourceView>
      )}
      {(tab === 'Fills'
        ? fills.resource.status === 'ready' && fills.resource.data.length >= limit
        : tab === 'History' && history.resource.status === 'ready' && history.resource.data.length >= limit) && (
        <Button variant="ghost" disabled={limit === 500} onClick={() => setLimit(Math.min(500, limit + 100))}>
          {limit === 500 ? '500-row page limit reached' : 'Load more records'}
        </Button>
      )}
      <small className="trade-note">
        {!market && 'Account-wide records. Unit labels and quantity/price changes require published market rules. '}
        {tab === 'Open orders'
          ? 'First 100 working orders; refresh confirms current state.'
          : 'Newest records, up to 500 per service page. A page is not your complete history.'}
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
  onStatus: (status: string) => void;
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
      setFailure({
        ok: false,
        reason: 'uncertain',
        message: 'This order is recovering. Resolve its original outcome before another action.',
      });
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
      setFailure({
        ok: false,
        reason: 'invalid_response',
        message: 'The original order’s market could not be verified. No new action was sent.',
      });
      setBusy(false);
      busyRef.current = false;
      return;
    }
    if (latest.data.status !== 'open') {
      onStatus(`Order ${current.id} is already ${latest.data.status}; filled ${latest.data.filled}.`);
      onClose();
      return;
    }
    if (latest.data.filled !== current.filled || latest.data.remaining !== current.remaining) {
      setCurrent(latest.data);
      setFailure({
        ok: false,
        reason: 'error',
        message: 'This order filled while you were reviewing. Review its refreshed remainder before continuing.',
      });
      setBusy(false);
      busyRef.current = false;
      return;
    }
    if (selection.kind === 'amend') {
      try {
        if (parseAmount(amount) <= 0n || parseAmount(amount) >= parseAmount(current.remaining)) throw new Error();
      } catch {
        setFailure({
          ok: false,
          reason: 'error',
          message:
            'Enter a positive remaining quantity below the current remainder. Use Change price for a separately reviewed cancel/replace.',
        });
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
        onStatus(
          `${selection.kind === 'cancel' ? 'Cancellation' : 'Amendment'} outcome is unknown. Check the original order before any further action.`,
        );
      } else {
        onResolved(identity);
        const order = 'order' in result.data ? result.data.order : result.data;
        onStatus(
          `${'accepted' in result.data ? `Amendment ${result.data.accepted ? 'accepted' : 'refused'}: ${result.data.code}. ` : ''}Order ${order.id}: ${order.status}. Filled ${order.filled}, remaining ${order.remaining}.${'priority' in result.data && result.data.priority ? ` Queue priority: ${result.data.priority}.` : ''}`,
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
      title={selection.kind === 'cancel' ? 'Cancel working order' : 'Reduce working order quantity'}
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <p>
        {current.symbol} · {current.side} {current.type} · {current.id}
      </p>
      <dl className="trade-review">
        <div>
          <dt>Filled</dt>
          <dd>
            {displayAmount(current.filled)} {market?.symbol === current.symbol ? market.base : ''}
          </dd>
        </div>
        <div>
          <dt>Remaining</dt>
          <dd>
            {displayAmount(current.remaining)} {market?.symbol === current.symbol ? market.base : ''}
          </dd>
        </div>
        <div>
          <dt>Limit price</dt>
          <dd>
            {displayAmount(current.price)} {market?.symbol === current.symbol ? market.quote : ''}
          </dd>
        </div>
      </dl>
      {selection.kind === 'amend' && (
        <Field
          label={`New remaining quantity${market?.symbol === current.symbol ? ` (${market.base})` : ''}`}
          value={amount}
          inputMode="decimal"
          onChange={(event) => setAmount(event.target.value)}
        />
      )}
      <p className="muted">
        {selection.kind === 'cancel'
          ? 'A fill may win the cancellation race. Funds refresh from the ledger after the service confirms the outcome.'
          : 'Quantity reduction at the same price uses native amendment. The service reports whether queue priority is kept; no funds are released optimistically.'}
      </p>
      {failure && <Failure result={failure} />}
      <div className="actions">
        <Button variant="secondary" disabled={busy} onClick={onClose}>
          Keep order
        </Button>
        <Button variant={selection.kind === 'cancel' ? 'danger' : 'primary'} disabled={busy} onClick={commit}>
          {busy ? 'Checking order…' : selection.kind === 'cancel' ? 'Confirm cancellation' : 'Confirm reduction'}
        </Button>
      </div>
    </Dialog>
  );
}
