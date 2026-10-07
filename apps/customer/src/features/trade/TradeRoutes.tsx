import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { z } from 'zod';
import { useApi, useSession } from '../session/session';
import { usePreferences } from '../../shared/preferences';
import { useResource, type Resource } from '../../shared/resource';
import { Button, DataTable, Dialog, EmptyState, Failure, Field, Loading, Tabs } from '../../shared/ui';
import type { ApiResult } from '../../shared/api';
import { displayAmount, parseAmount, formatAmount } from '../../shared/money';
import {
  createTradeApi,
  type TradeApi,
  type Listing,
  type Draft,
  type Preview,
  type Order,
  draftSchema,
  exactValue,
  portionInLots,
} from './trade-api';
import { useLinkedBook, usePolled } from './hooks';
import { MarketChart } from './Chart';
import { TradingTools } from './TradingTools';
import './trade.css';

const modes = ['Spot', 'Margin', 'Futures', 'Options', 'Copy', 'Bots', 'Execution', 'Convert', 'Quote desk'];
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
  const [simulation, setSimulation] = useState(false),
    [picker, setPicker] = useState(false),
    [selected, setSelected] = useState<string | null>(null);
  const activeMode = path.startsWith('/otc')
    ? 'Quote desk'
    : path.startsWith('/execution')
      ? 'Execution'
      : (modes.find((mode) => mode !== 'Spot' && path.includes(`/trade/${mode.toLowerCase()}`)) ?? 'Spot');
  const query = new URLSearchParams(location.search),
    asset = query.get('asset')?.toUpperCase(),
    initialSide = query.get('side') === 'sell' ? 'sell' : 'buy';
  const routePair = path.startsWith('/exchange/') ? decodePair(path.slice('/exchange/'.length)) : null;
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
    try {
      localStorage.setItem(`trade-favorites:${userId ?? 'guest'}`, JSON.stringify(favorites));
    } catch {
      /* Favorites remain available in this tab. */
    }
  }, [favorites, userId]);
  useEffect(() => {
    setSelected(null);
  }, [path]);
  function choose(value: Listing) {
    setSelected(value.symbol);
    setPicker(false);
  }
  return (
    <div className="trade-root">
      <nav className="trade-modes" aria-label="Trading modes">
        {modes.map((mode) => (
          <a key={mode} aria-current={activeMode === mode ? 'page' : undefined} href={modeRoutes[mode]}>
            {mode}
          </a>
        ))}
        <label className="trade-simulation">
          <input
            type="checkbox"
            checked={simulation}
            onChange={(event) => {
              setSimulation(event.target.checked);
              setSelected(null);
            }}
          />
          Simulated
        </label>
      </nav>
      {activeMode !== 'Spot' ? (
        <TradingTools api={api} transport={transport} mode={activeMode} markets={visible} simulation={simulation} />
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
          {catalogue.resource.status === 'loading' ? (
            <Loading label="Loading published markets" />
          ) : catalogue.resource.status === 'failed' ? (
            <Failure result={catalogue.resource.failure} retry={catalogue.reload} />
          ) : market ? (
            <SpotDesk
              key={`${market.id}:${userId ?? 'guest'}`}
              market={market}
              api={api}
              initialTab={path.includes('history') ? 'History' : 'Open orders'}
              initialSide={initialSide}
            />
          ) : (
            <EmptyState
              title={
                simulation
                  ? 'No simulated spot market is published'
                  : routePair
                    ? 'This market is not available in this mode'
                    : 'No spot markets are published'
              }
            >
              {simulation
                ? 'Simulation uses only markets explicitly marked simulated by the service. It cannot fall back to a live market.'
                : 'Select a published spot market to open its chart, book, and order ticket.'}
            </EmptyState>
          )}
        </>
      )}
      {picker && <MarketPicker markets={visible} onSelect={choose} onClose={() => setPicker(false)} />}
    </div>
  );
}
function decodePair(value: string) {
  try {
    return decodeURIComponent(value).replace('_', '/').replace('-', '/').toUpperCase();
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
function MarketPicker({ markets, onSelect, onClose }: { markets: Listing[]; onSelect: (market: Listing) => void; onClose: () => void }) {
  const [query, setQuery] = useState('');
  return (
    <Dialog title="Choose market" onClose={onClose}>
      <Field label="Search markets" autoFocus value={query} onChange={(event) => setQuery(event.target.value)} />
      <div className="trade-picker">
        {markets
          .filter((market) => `${market.symbol} ${market.base} ${market.quote}`.toLowerCase().includes(query.toLowerCase()))
          .map((market) => (
            <button key={market.id} onClick={() => onSelect(market)}>
              <strong>{market.symbol}</strong>
              <span>{market.paper ? 'Simulated' : market.orderable && market.sessionOpen ? 'Published for trading' : 'Restricted'}</span>
            </button>
          ))}
        {!markets.length && <p>No matching published markets in this mode.</p>}
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
  kind: z.enum(['place', 'cancel', 'amend', 'convert', 'rfq', 'position', 'algo', 'copy']),
  symbol: z.string(),
  id: z.string(),
  orderId: z.string().optional(),
  startedAt: z.number(),
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
function SpotDesk({
  api,
  market,
  initialTab,
  initialSide,
}: {
  api: TradeApi;
  market: Listing;
  initialTab: string;
  initialSide: 'buy' | 'sell';
}) {
  const { userId } = useSession(),
    preferences = usePreferences();
  const accountKey = userId ?? 'signed-out';
  const book = useLinkedBook(api, market),
    balances = usePolled((signal) => api.balances(signal), accountKey, 20),
    open = usePolled((signal) => api.orders('open', undefined, 100, signal), accountKey, 10);
  const [staged, setStaged] = useState(''),
    [pending, setPending] = useState<Pending | null>(() => readPending(accountKey)),
    [status, setStatus] = useState(''),
    [checking, setChecking] = useState(false),
    [manage, setManage] = useState<{ order: Order; kind: 'cancel' | 'amend' } | null>(null);
  useEffect(() => {
    const update = () => setPending(readPending(accountKey));
    window.addEventListener('storage', update);
    return () => window.removeEventListener('storage', update);
  }, [accountKey]);
  const releaseLock = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      releaseLock.current?.();
    },
    [],
  );
  const setIntent = (value: Pending | null) => {
    if (value) {
      try {
        localStorage.setItem(pendingKey(accountKey), JSON.stringify(value));
      } catch {
        setStatus('Browser storage cannot preserve this request identity. Enable device storage before submitting.');
        return false;
      }
    } else {
      try {
        localStorage.removeItem(pendingKey(accountKey));
      } catch {
        /* Existing in-memory outcome remains authoritative. */
      }
    }
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
  function refresh() {
    balances.reload();
    open.reload();
  }
  async function reconcile() {
    if (!pending || checking) return;
    if (!['place', 'cancel', 'amend'].includes(pending.kind)) {
      setStatus(
        `This ${pending.kind} request must be checked in its original trading tool. Contact support with ${pending.id} if its outcome cannot be read.`,
      );
      return;
    }
    setChecking(true);
    const result = pending.orderId ? await api.order(pending.orderId) : await api.reconcile(pending.id, pending.symbol);
    if (result.ok) {
      const resolved =
        !result.data.recoveryRequired &&
        (pending.kind === 'place' ||
          (pending.kind === 'cancel' && result.data.status !== 'open') ||
          (pending.kind === 'amend' && result.data.status !== 'open'));
      if (resolved) {
        setIntent(null);
        setStatus(`Order ${result.data.id}: ${result.data.status}. Filled ${result.data.filled}; remaining ${result.data.remaining}.`);
      } else
        setStatus(
          `Order ${result.data.id} is still open. The ${pending.kind} outcome is unresolved; funds remain as reported by the ledger.`,
        );
    } else setStatus(result.message);
    refresh();
    setChecking(false);
  }
  const orders = open.resource.status === 'ready' ? open.resource.data : [];
  return (
    <>
      <div className="trade-workspace">
        <div className="trade-analysis">
          <div className="trade-analysis-top">
            <MarketChart api={api} market={market} orders={orders} onStagePrice={setStaged} accountKey={accountKey} />
            <BookAndTape api={api} market={market} book={book} onStagePrice={setStaged} />
          </div>
          <OrderBlotter
            api={api}
            initialTab={initialTab}
            open={open}
            market={market}
            onManage={(order, kind) => setManage({ order, kind })}
            locked={Boolean(pending)}
          />
        </div>
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
            onResolved={() => {
              setIntent(null);
              refresh();
            }}
            onStatus={setStatus}
          />
          <section className="trade-funds">
            <h3>Funds · Personal</h3>
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
            <a className="text-link" href="/money">
              Manage in Money ↗
            </a>
          </section>
        </aside>
      </div>
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
      {manage && (
        <ManageOrder
          api={api}
          selection={manage}
          onClose={() => setManage(null)}
          onIntent={reserveIntent}
          onResolved={() => {
            setIntent(null);
            refresh();
          }}
          onStatus={setStatus}
        />
      )}
    </>
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
      <Tabs items={['Order book', 'Trades']} value={tab} onChange={setTab} label="Market data panel" />
      {tab === 'Order book' ? (
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
  onResolved: () => void;
  onStatus: (value: string) => void;
}) {
  const { session } = useSession(),
    preferences = usePreferences();
  const [side, setSide] = useState<'buy' | 'sell'>(initialSide),
    [type, setType] = useState<'limit' | 'market'>('limit'),
    [price, setPrice] = useState(''),
    [amount, setAmount] = useState(''),
    [tif, setTif] = useState<'GTC' | 'IOC' | 'FOK'>('GTC'),
    [postOnly, setPostOnly] = useState(false),
    [review, setReview] = useState<{ draft: Draft; preview: Preview } | null>(null),
    [failure, setFailure] = useState<Extract<ApiResult<unknown>, { ok: false }> | null>(null),
    [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
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
  async function preview() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    const draft = {
      symbol: market.symbol,
      side,
      type,
      amount,
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
      if (result.ok) setReview({ draft: parsed.data, preview: result.data });
      else setFailure(result);
    }
    setBusy(false);
    busyRef.current = false;
  }
  async function send() {
    if (!review || busyRef.current || pending || !fresh) return;
    busyRef.current = true;
    setBusy(true);
    if (!(await onIntent({ kind: 'place', id: review.draft.clientOrderId, symbol: market.symbol, startedAt: Date.now() }))) {
      setBusy(false);
      busyRef.current = false;
      return;
    }
    const result = await api.place(review.draft, review.preview);
    if (result.ok) {
      onResolved();
      setReview(null);
      setAmount('');
      onStatus(
        `${market.paper ? 'Simulated order' : 'Order'} ${result.data.id} is ${result.data.status}; filled ${result.data.filled} ${market.base}, remaining ${result.data.remaining} ${market.base}.`,
      );
    } else if (result.reason === 'changed') {
      onResolved();
      setReview({ draft: review.draft, preview: result.preview });
      setFailure({ ok: false, reason: 'error', message: result.message });
    } else {
      setFailure(result);
      if (result.reason !== 'uncertain') onResolved();
    }
    setBusy(false);
    busyRef.current = false;
  }
  function size(percent: bigint) {
    if (available === undefined) return;
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
    if (value !== null) change(() => setAmount(value));
  }
  const blocked =
    !session || !market.orderable || !market.active || !market.sessionOpen || !fresh || Boolean(pending) || available === undefined;
  return (
    <section className="trade-ticket" aria-label="Spot order ticket">
      <div className="trade-panel-title">
        <h2>Trade</h2>
        <a href="/trade/bots">Tools ↗</a>
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
              if (value === 'Market') setPostOnly(false);
            })
          }
          label="Order type"
        />
        {review ? (
          <>
            <h3>Review {side}</h3>
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
              <div>
                <dt>Limit price</dt>
                <dd>
                  {displayAmount(review.preview.price)} {market.quote}
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
            <Button
              disabled={
                busy || blocked || !review.preview.orderable || review.preview.estimatedFee === null || review.preview.holdAmount === null
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
              label={`Amount (${market.base})`}
              hint={`Base quantity only. Lot ${market.precision.amount} ${market.base}.`}
              inputMode="decimal"
              autoComplete="off"
              value={amount}
              onChange={(event) => change(() => setAmount(event.target.value))}
            />
            <div className="trade-size-presets">
              {[25n, 50n, 75n, 100n].map((percent) => (
                <button
                  key={percent.toString()}
                  disabled={available === undefined || (side === 'buy' && type !== 'limit')}
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
          <a className="text-link" href={`/login?redirect=${encodeURIComponent(`/exchange/${market.symbol.replace('/', '_')}`)}`}>
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
}: {
  api: TradeApi;
  initialTab: string;
  open: ReturnType<typeof usePolled<Order[]>>;
  market: Listing;
  onManage: (order: Order, kind: 'cancel' | 'amend') => void;
  locked: boolean;
}) {
  const [tab, setTab] = useState(initialTab),
    [all, setAll] = useState(false),
    [limit, setLimit] = useState(100);
  const key = `${market.id}:${all}:${limit}`;
  const history = useResource((signal) => api.orders('closed', all ? undefined : market.symbol, limit, signal), key),
    fills = useResource((signal) => api.fills(all ? undefined : market.symbol, limit, signal), key);
  const data = tab === 'Open orders' ? open : history;
  return (
    <section className="trade-blotter">
      <div className="trade-blotter-toolbar">
        <Tabs items={['Open orders', 'History', 'Fills']} value={tab} onChange={setTab} label="Order management" />
        <label className="trade-inline">
          <input type="checkbox" checked={all} onChange={(event) => setAll(event.target.checked)} />
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
                      {displayAmount(row.price)} {row.symbol.split('/')[1]}
                    </td>
                    <td>
                      {displayAmount(row.amount)} {row.symbol.split('/')[0]}
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
            const scoped = all ? rows : rows.filter((row) => row.symbol === market.symbol);
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
                      {displayAmount(order.price)} {order.symbol.split('/')[1]}
                    </td>
                    <td>
                      {displayAmount(order.amount)} / {displayAmount(order.filled)} {order.symbol.split('/')[0]}
                    </td>
                    <td>
                      {displayAmount(order.remaining)} {order.symbol.split('/')[0]}
                    </td>
                    <td>{order.status}</td>
                    <td>
                      {order.status === 'open' && (
                        <div className="trade-row-actions">
                          <button disabled={locked} onClick={() => onManage(order, 'amend')}>
                            Reduce
                          </button>
                          <button disabled={locked} onClick={() => onManage(order, 'cancel')}>
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
        {tab === 'Open orders'
          ? 'First 100 working orders; refresh confirms current state.'
          : 'Newest records, up to 500 per service page. A page is not your complete history.'}
      </small>
    </section>
  );
}
function ManageOrder({
  api,
  selection,
  onClose,
  onIntent,
  onResolved,
  onStatus,
}: {
  api: TradeApi;
  selection: { order: Order; kind: 'cancel' | 'amend' };
  onClose: () => void;
  onIntent: (pending: Pending) => Promise<boolean>;
  onResolved: () => void;
  onStatus: (status: string) => void;
}) {
  const [amount, setAmount] = useState(selection.order.remaining),
    [busy, setBusy] = useState(false),
    [failure, setFailure] = useState<Extract<ApiResult<unknown>, { ok: false }> | null>(null),
    [current, setCurrent] = useState(selection.order);
  const busyRef = useRef(false);
  async function commit() {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setFailure(null);
    const latest = await api.order(current.id);
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
    if (latest.data.status !== 'open') {
      onStatus(`Order ${current.id} is already ${latest.data.status}; filled ${latest.data.filled}.`);
      onResolved();
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
            'Enter a positive remaining quantity below the current remainder. Price changes need cancel/replace, which has no authoritative review contract here.',
        });
        setBusy(false);
        busyRef.current = false;
        return;
      }
    }
    if (!(await onIntent({ kind: selection.kind, id: current.id, symbol: current.symbol, orderId: current.id, startedAt: Date.now() }))) {
      onClose();
      return;
    }
    const result = selection.kind === 'cancel' ? await api.cancel(current.id) : await api.amend(current.id, amount);
    if (result.ok) {
      if (
        ('reconciliationRequired' in result.data && result.data.reconciliationRequired) ||
        ('recoveryRequired' in result.data && result.data.recoveryRequired)
      ) {
        onStatus('Amendment outcome is unknown. Check the original order before any further action.');
      } else {
        onResolved();
        const order = 'order' in result.data ? result.data.order : result.data;
        onStatus(
          `Order ${order.id}: ${order.status}. Filled ${order.filled}, remaining ${order.remaining}.${'priority' in result.data ? ` Queue priority: ${result.data.priority}.` : ''}`,
        );
      }
      onClose();
    } else {
      setFailure(result);
      if (result.reason !== 'uncertain') onResolved();
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
            {displayAmount(current.filled)} {current.symbol.split('/')[0]}
          </dd>
        </div>
        <div>
          <dt>Remaining</dt>
          <dd>
            {displayAmount(current.remaining)} {current.symbol.split('/')[0]}
          </dd>
        </div>
        <div>
          <dt>Limit price</dt>
          <dd>
            {displayAmount(current.price)} {current.symbol.split('/')[1]}
          </dd>
        </div>
      </dl>
      {selection.kind === 'amend' && (
        <Field
          label={`New remaining quantity (${current.symbol.split('/')[0]})`}
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
