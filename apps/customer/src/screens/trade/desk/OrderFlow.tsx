/**
 * The DOM (J-charts-desk-14, C-trade-dom-01): a depth-of-market ladder, time and sales and a depth chart, opened from the
 * chart and bound to the chart's symbol. It reads the book and the tape the desk already reads: the ladder and the depth
 * chart draw the SAME book snapshot (its engine sequence is on both), and nothing here holds a balance or sends an order.
 * A click on a ladder cell asks the desk's own ticket for a draft at that price; the ticket reviews it (OrderForm).
 */
import { memo, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { OrderBook, Trade } from '@intafaced/exchange-contract/schemas';
import type { Order } from '../../../features/trade/trade-api';
import type { Preferences } from '../../../shared/preferences';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Button,
  fmtAmount,
  fmtPrice,
  refusalCopy,
  StateBlock,
  Skeleton,
  type Loadable,
} from './deps';
import { useDeskApi, useRefreshPrivate, useTape } from './data';
import { useDataEnv } from '../../../data/hooks';
import { useNow } from './hooks';
import type { DeskMarket } from './market';
import { STALE_BOOK_MS } from './OrderBook';
import { flowCopy } from './order-flow-copy';
import { percentOf, useQueuePositions, windowWords } from './queue-position';
import {
  bucketOf,
  buildLadder,
  depthCurve,
  LADDER_STEPS,
  stepOf,
  tapeView,
  type DomSetting,
  type LadderColumns,
  type LadderStep,
  type TapeUnits,
} from './order-flow';
import { scaled } from './order-math';
import { placesOf } from './text';
import { depthGeometry } from '../chart/depth-geometry';
import { clockSeconds } from './time';
import './order-flow.css';

export interface LadderPick {
  side: 'buy' | 'sell';
  price: string;
}

interface Props {
  market: DeskMarket;
  book: Loadable<OrderBook>;
  openOrders: Loadable<Order[]>;
  zone: Preferences['timeZone'];
  setting: DomSetting;
  onSetting: (next: DomSetting) => void;
  onPick: (pick: LadderPick) => void;
  onClose: () => void;
  /** Instant placement is on: a cancel from the ladder acts at once, with no review. */
  instant: boolean;
}

/**
 * One-click cancel from the ladder (J-charts-desk-14 #7): every open order of mine in the row's bucket. Reviewed, it asks
 * first and lists them; instant, it cancels at once. Either way one DELETE goes per order, once: nothing retries it.
 */
function useLadderCancel(instant: boolean) {
  const { t } = flowCopy.useCopy();
  const api = useDeskApi();
  const env = useDataEnv();
  const refresh = useRefreshPrivate();
  const busy = useRef(false);
  const [asking, setAsking] = useState<{ price: string; orders: Order[] } | null>(null);
  const [note, setNote] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null);
  const run = async (price: string, orders: readonly Order[], tickSize: string) => {
    if (busy.current || orders.length === 0) return;
    busy.current = true;
    setAsking(null);
    let done = 0;
    let refused: string | null = null;
    let unsure = false;
    for (const order of orders) {
      env.poller.recordExternalRequest();
      const result = await api.cancel(order);
      if (result.ok) done += 1;
      else if (result.reason === 'uncertain') unsure = true;
      else refused = result.message ?? refusalCopy(result.code ?? '').title;
    }
    busy.current = false;
    refresh();
    const at = fmtPrice(price, tickSize);
    if (unsure) setNote({ tone: 'bad', text: t('Cancel unsure') });
    else if (refused !== null) setNote({ tone: 'bad', text: t('Cancel refused', { reason: refused }) });
    else setNote({ tone: 'good', text: t('Cancel done', { n: done, price: at }) });
  };
  const ask = (price: string, orders: Order[], tickSize: string) => {
    setNote(null);
    if (instant) void run(price, orders, tickSize);
    else setAsking({ price, orders });
  };
  return { ask, asking, setAsking, run, note };
}

function Ladder({
  market,
  data,
  mine,
  columns,
  stepTicks,
  onPick,
  onCancel,
}: {
  market: DeskMarket;
  data: OrderBook;
  mine: readonly Order[];
  columns: LadderColumns;
  stepTicks: LadderStep;
  onPick: (pick: LadderPick) => void;
  onCancel: (price: string, orders: Order[]) => void;
}) {
  const { t } = flowCopy.useCopy();
  const step = stepOf(market.tickSize, stepTicks) ?? market.tickSize;
  const ladder = useMemo(() => buildLadder(data, step, mine), [data, step, mine]);
  const amountPlaces = placesOf(market.lotSize);
  const size = (value: string) => (value === '' ? '' : fmtAmount(value, { places: amountPlaces, fixed: true }));
  const double = columns === 'double';
  const ordersAt = (price: string) => mine.filter((order) => order.price && bucketOf(order.price, order.side, step) === price);
  const cancelButton = (price: string, shown: string) => {
    const orders = ordersAt(price);
    if (orders.length === 0) return shown;
    return (
      <button
        type="button"
        className="of-cancel"
        data-testid="of-cancel"
        aria-label={t('Cancel at', { price: fmtPrice(price, market.tickSize) })}
        onClick={() => onCancel(price, orders)}
      >
        {shown} ×
      </button>
    );
  };
  if (ladder.rows.length === 0)
    return (
      <p className="of-note" data-testid="of-ladder-empty">
        {t('Ladder empty')}
      </p>
    );
  return (
    <div
      className="of-ladder"
      role="grid"
      aria-label={t('Depth of market')}
      data-testid="of-ladder"
      data-columns={columns}
      data-step={step}
      data-best-bid={ladder.bestBid ?? ''}
      data-best-ask={ladder.bestAsk ?? ''}
      data-bid-total={ladder.bidTotal}
      data-ask-total={ladder.askTotal}
    >
      <div className="of-row of-row--head" role="row" data-columns={columns}>
        {double ? <span role="columnheader">{t('Ladder my bids')}</span> : null}
        <span role="columnheader">{t('Ladder bid', { asset: market.base })}</span>
        <span role="columnheader">{t('Ladder price', { asset: market.quote })}</span>
        <span role="columnheader">{t('Ladder ask', { asset: market.base })}</span>
        <span role="columnheader">{double ? t('Ladder my asks') : t('Ladder mine')}</span>
      </div>
      <div className="of-rows" role="rowgroup">
        {ladder.rows.map((row) => {
          const highlight = row.best ? `best-${row.best}` : row.myBid || row.myAsk ? 'mine' : undefined;
          const price = fmtPrice(row.price, market.tickSize);
          return (
            <div
              key={row.price}
              role="row"
              className="of-row"
              data-testid="of-ladder-row"
              data-columns={columns}
              data-price={row.price}
              data-bid={row.bid}
              data-ask={row.ask}
              data-my-bid={row.myBid}
              data-my-ask={row.myAsk}
              data-highlight={highlight}
              aria-label={row.best === 'bid' ? t('Ladder best bid') : row.best === 'ask' ? t('Ladder best ask') : undefined}
            >
              {double ? (
                <span role="gridcell" className="of-mine" data-testid="of-my-bid">
                  {row.myBid ? cancelButton(row.price, size(row.myBid)) : ''}
                </span>
              ) : null}
              <span role="gridcell" className="of-cell of-cell--bid">
                <button
                  type="button"
                  data-testid="of-bid-cell"
                  aria-label={t('Ladder sell at', { price })}
                  onClick={() => onPick({ side: 'sell', price: row.price })}
                >
                  {size(row.bid)}
                </button>
              </span>
              <span role="gridcell" className="of-price" data-testid="of-price">
                {price}
              </span>
              <span role="gridcell" className="of-cell of-cell--ask">
                <button
                  type="button"
                  data-testid="of-ask-cell"
                  aria-label={t('Ladder buy at', { price })}
                  onClick={() => onPick({ side: 'buy', price: row.price })}
                >
                  {size(row.ask)}
                </button>
              </span>
              <span role="gridcell" className="of-mine" data-testid={double ? 'of-my-ask' : 'of-mine'}>
                {double
                  ? row.myAsk
                    ? cancelButton(row.price, size(row.myAsk))
                    : ''
                  : row.myBid || row.myAsk
                    ? cancelButton(
                        row.price,
                        [row.myBid && `+${size(row.myBid)}`, row.myAsk && `−${size(row.myAsk)}`].filter(Boolean).join(' '),
                      )
                    : ''}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TimeAndSales({
  market,
  zone,
  setting,
  onSetting,
}: {
  market: DeskMarket;
  zone: Preferences['timeZone'];
  setting: DomSetting;
  onSetting: (next: DomSetting) => void;
}) {
  const { t } = flowCopy.useCopy();
  const tape = useTape(market.symbol, true);
  const [typed, setTyped] = useState(setting.minAmount);
  const invalid = typed.trim() !== '' && (scaled(typed.trim()) === null || (scaled(typed.trim()) ?? 0n) < 0n);
  const amountPlaces = placesOf(market.lotSize);
  const trades: readonly Trade[] = tape.status === 'ready' ? tape.data : [];
  const view = useMemo(
    () => tapeView(trades, { minAmount: setting.minAmount, units: setting.units, accumulate: setting.accumulate }),
    [trades, setting.minAmount, setting.units, setting.accumulate],
  );
  const unitAsset = setting.units === 'base' ? market.base : market.quote;

  let body: React.ReactNode;
  if (tape.status === 'loading') body = <Skeleton height={160} className="bg-field" />;
  else if (tape.status === 'error')
    body = <StateBlock kind="error" title={t('Couldn’t load trades')} onRetry={tape.retry} retryLabel={t('Try again')} />;
  else if (tape.status === 'refused') {
    const words = refusalCopy(tape.code);
    body = <StateBlock kind="refused" title={words.title} body={words.body} action={words.action} />;
  } else if (view.total === 0) body = <p className="of-note">{t('Tape empty')}</p>;
  else
    body = (
      <>
        <p className="of-note" role="status" data-testid="of-tape-hidden" data-hidden={view.hidden} data-total={view.total}>
          {view.hidden > 0 ? t('Tape hidden', { n: view.hidden, total: view.total }) : t('Tape none hidden', { total: view.total })}
        </p>
        {view.rows.length === 0 ? (
          <p className="of-note">{t('Tape all hidden')}</p>
        ) : (
          <div className="of-tape" role="grid" aria-label={t('Time and sales')}>
            <div className="of-tape-row of-row--head" role="row">
              <span role="columnheader">{t('Tape time')}</span>
              <span role="columnheader">{t('Tape price', { asset: market.quote })}</span>
              <span role="columnheader">{t('Tape amount', { asset: unitAsset })}</span>
            </div>
            {view.rows.map((row) => (
              <div
                key={row.id}
                role="row"
                className="of-tape-row"
                data-testid="of-tape-row"
                data-side={row.side}
                data-price={row.price}
                data-amount={row.amount}
                data-value={row.value}
                data-prints={row.prints}
                style={{ '--of-bar': row.bar } as React.CSSProperties}
              >
                <span className="of-tape-bar" aria-hidden="true" />
                <span role="gridcell">{clockSeconds(row.timestamp, zone)}</span>
                <span role="gridcell" className="of-tape-price" data-side={row.side}>
                  {fmtPrice(row.price, market.tickSize)}
                </span>
                <span role="gridcell">
                  {setting.units === 'base'
                    ? fmtAmount(row.amount, { places: amountPlaces, fixed: true })
                    : fmtAmount(row.value, { places: placesOf(market.tickSize) })}
                  {row.prints > 1 ? <span className="of-prints"> · {t('Tape prints', { n: row.prints })}</span> : null}
                </span>
              </div>
            ))}
          </div>
        )}
      </>
    );

  return (
    <section className="of-section" aria-label={t('Time and sales')} data-testid="of-tape">
      <h3 className="of-title">{t('Time and sales')}</h3>
      <div className="of-tools">
        <label className="of-field">
          <span>{t('Minimum amount')}</span>
          <input
            type="text"
            inputMode="decimal"
            autoComplete="off"
            value={typed}
            aria-invalid={invalid}
            aria-describedby={invalid ? 'of-min-invalid' : undefined}
            onChange={(event) => {
              const next = event.target.value;
              setTyped(next);
              const valid = next.trim() === '' || ((scaled(next.trim()) ?? -1n) >= 0n && scaled(next.trim()) !== null);
              if (valid) onSetting({ ...setting, minAmount: next.trim() });
            }}
          />
        </label>
        <label className="of-field">
          <span>{t('Units')}</span>
          <select value={setting.units} onChange={(event) => onSetting({ ...setting, units: event.target.value as TapeUnits })}>
            <option value="base">{market.base}</option>
            <option value="quote">{market.quote}</option>
          </select>
        </label>
        <label className="of-check">
          <input
            type="checkbox"
            checked={setting.accumulate}
            onChange={(event) => onSetting({ ...setting, accumulate: event.target.checked })}
          />
          <span>{t('Accumulate at price')}</span>
        </label>
      </div>
      {invalid ? (
        <p id="of-min-invalid" className="of-note of-note--bad">
          {t('Minimum invalid')}
        </p>
      ) : null}
      {body}
    </section>
  );
}

const W = 320;
const H = 140;

function DepthChart({ market, data }: { market: DeskMarket; data: OrderBook }) {
  const { t } = flowCopy.useCopy();
  const [units, setUnits] = useState<TapeUnits>('base');
  const [hover, setHover] = useState<{ x: number; price: string; amount: string } | null>(null);
  const curve = useMemo(() => depthCurve(data), [data]);
  const empty = curve.bids.length === 0 && curve.asks.length === 0;
  const unitAsset = units === 'base' ? market.base : market.quote;
  const amountOf = (p: { cumulative: string; cumulativeValue: string }) => (units === 'base' ? p.cumulative : p.cumulativeValue);
  const geometry = useMemo(
    () =>
      depthGeometry(
        curve.bids.map((p) => ({ price: p.price, amount: amountOf(p) })),
        curve.asks.map((p) => ({ price: p.price, amount: amountOf(p) })),
        W,
        H,
      ),
    [curve, units], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const onMove = (event: ReactPointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const point = geometry.nearest(((event.clientX - box.left) / box.width) * W);
    if (point) setHover({ x: point.x, price: point.price, amount: point.amount });
  };
  const fmt = (amount: string) =>
    units === 'base' ? fmtAmount(amount, { places: placesOf(market.lotSize) }) : fmtAmount(amount, { places: placesOf(market.tickSize) });

  return (
    <section className="of-section" aria-label={t('Depth chart')} data-testid="of-depth">
      <div className="of-title-bar">
        <h3 className="of-title">{t('Depth chart')}</h3>
        <label className="of-field">
          <span>{t('Depth units')}</span>
          <select value={units} onChange={(event) => setUnits(event.target.value as TapeUnits)}>
            <option value="base">{market.base}</option>
            <option value="quote">{market.quote}</option>
          </select>
        </label>
      </div>
      {empty ? (
        <p className="of-note" data-testid="of-depth-empty">
          {t('Depth empty')}
        </p>
      ) : (
        <>
          <svg
            className="of-depth"
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={t('Depth chart of', { pair: market.symbol, bids: curve.bidTotal, asks: curve.askTotal, asset: market.base })}
            data-testid="of-depth-chart"
            data-book-nonce={data.nonce}
            data-bid-total={curve.bidTotal}
            data-ask-total={curve.askTotal}
            data-bid-points={curve.bids.map((p) => `${p.price}:${p.cumulative}`).join(' ')}
            data-ask-points={curve.asks.map((p) => `${p.price}:${p.cumulative}`).join(' ')}
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
          >
            <path className="of-depth-bid" d={geometry.bidPath} />
            <path className="of-depth-ask" d={geometry.askPath} />
            {hover ? <line className="of-depth-cursor" x1={hover.x} x2={hover.x} y1={0} y2={H} /> : null}
          </svg>
          <p
            className="of-note"
            role="status"
            data-testid="of-depth-readout"
            data-price={hover?.price ?? ''}
            data-amount={hover?.amount ?? ''}
          >
            {hover
              ? t('Depth at', { amount: fmt(hover.amount), asset: unitAsset, price: fmtPrice(hover.price, market.tickSize) })
              : t('Depth hover')}
          </p>
        </>
      )}
    </section>
  );
}

/** My resting limit orders on this market with their place in the queue and the estimated chance (J-charts-desk-14 #8). */
function QueuePanel({ market, mine }: { market: DeskMarket; mine: readonly Order[] }) {
  const { t } = flowCopy.useCopy();
  const resting = useMemo(() => mine.filter((order) => order.type === 'limit' && order.price), [mine]);
  const ids = useMemo(() => resting.map((order) => order.id), [resting]);
  const reads = useQueuePositions(ids, true);
  const amountPlaces = placesOf(market.lotSize);
  return (
    <section className="of-section" aria-label={t('Queue title')} data-testid="of-queue">
      <h3 className="of-title">{t('Queue title')}</h3>
      {resting.length === 0 ? (
        <p className="of-note">{t('Queue none', { pair: market.symbol })}</p>
      ) : (
        <ul className="of-queue">
          {resting.map((order) => {
            const read = reads.status === 'ready' ? reads.data.find((row) => row.orderId === order.id) : undefined;
            const view = read?.ok ? read.view : null;
            const percent = view?.fillProbability ? percentOf(view.fillProbability) : null;
            const window = view?.windowSeconds ? windowWords(view.windowSeconds) : null;
            return (
              <li
                key={order.id}
                data-testid="of-queue-row"
                data-order-id={order.id}
                data-orders-ahead={view?.ordersAhead ?? ''}
                data-size-ahead={view?.sizeAhead ?? ''}
                data-fill-probability={view?.fillProbability ?? ''}
                data-window-seconds={view?.windowSeconds ?? ''}
                data-source={view?.source ?? ''}
              >
                <span className="of-queue-order">
                  {t('Queue order', {
                    side: order.side === 'buy' ? t('Buy') : t('Sell'),
                    amount: fmtAmount(order.remaining, { places: amountPlaces }),
                    asset: market.base,
                    price: fmtPrice(order.price ?? '', market.tickSize),
                  })}
                </span>
                {reads.status === 'loading' || (reads.status === 'ready' && !read) ? (
                  <Skeleton height={16} className="bg-field" />
                ) : read && !read.ok ? (
                  <span className="of-note of-note--bad" data-code={read.code ?? undefined}>
                    {read.code === 'trade.order_not_open'
                      ? t('Queue not open')
                      : read.code === 'trade.l3_unavailable'
                        ? t('Queue no l3')
                        : t('Queue unavailable')}
                  </span>
                ) : view ? (
                  <>
                    <span data-testid="of-queue-place">
                      {view.ordersAhead === 0
                        ? t('Queue first')
                        : view.ordersAhead === 1
                          ? t('Queue ahead one', { size: fmtAmount(view.sizeAhead, { places: amountPlaces }), asset: market.base })
                          : t('Queue ahead', {
                              n: view.ordersAhead,
                              size: fmtAmount(view.sizeAhead, { places: amountPlaces }),
                              asset: market.base,
                            })}
                    </span>
                    <span className="of-note">{t('Queue source')}</span>
                    <span data-testid="of-queue-chance" data-refusal={view.fillProbabilityRefusal ?? undefined}>
                      {percent && window
                        ? t('Queue chance', {
                            percent,
                            n: window.n,
                            unit: window.unit === 'minutes' ? t('Queue minutes') : t('Queue seconds'),
                          })
                        : t('Queue chance unset')}
                    </span>
                  </>
                ) : reads.status === 'error' || reads.status === 'refused' ? (
                  <span className="of-note of-note--bad">{t('Queue unavailable')}</span>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** The DOM widget on the desk: the ladder, time and sales and the depth chart for the chart's market. */
export const OrderFlow = memo(function OrderFlow({ market, book, openOrders, zone, setting, onSetting, onPick, onClose, instant }: Props) {
  const { t } = flowCopy.useCopy();
  const cancel = useLadderCancel(instant);
  const onCancel = (price: string, orders: Order[]) => cancel.ask(price, orders, market.tickSize);
  const now = useNow(1000);
  const data = book.status === 'ready' ? book.data : null;
  const mine = useMemo(
    () =>
      openOrders.status === 'ready' ? openOrders.data.filter((order) => order.symbol === market.symbol && order.status === 'open') : [],
    [openOrders, market.symbol],
  );
  const old = data !== null && now - data.timestamp >= STALE_BOOK_MS;

  let ladder: React.ReactNode;
  if (book.status === 'loading') ladder = <Skeleton height={240} className="bg-field" />;
  else if (book.status === 'error')
    ladder = <StateBlock kind="error" title={t('Couldn’t load the order book')} onRetry={book.retry} retryLabel={t('Try again')} />;
  else if (book.status === 'refused') {
    const words = refusalCopy(book.code, { pair: market.symbol.replace('/', '-') });
    ladder = <StateBlock kind="refused" title={words.title} body={words.body} action={words.action} />;
  } else if (data)
    ladder = (
      <Ladder
        market={market}
        data={data}
        mine={mine}
        columns={setting.columns}
        stepTicks={setting.stepTicks}
        onPick={onPick}
        onCancel={onCancel}
      />
    );
  else ladder = <p className="of-note">{t('Ladder empty')}</p>;

  return (
    <section
      className="dk-panel of-dom"
      aria-label={t('Depth of market')}
      data-testid="of-dom"
      data-symbol={market.symbol}
      data-book-nonce={data?.nonce ?? ''}
      data-columns={setting.columns}
      data-step-ticks={setting.stepTicks}
    >
      <div className="of-title-bar">
        <h2 className="of-title">{t('DOM for', { pair: market.symbol })}</h2>
        <div className="of-tools">
          <label className="of-field">
            <span>{t('Columns')}</span>
            <select value={setting.columns} onChange={(event) => onSetting({ ...setting, columns: event.target.value as LadderColumns })}>
              <option value="single">{t('Columns single')}</option>
              <option value="double">{t('Columns double')}</option>
            </select>
          </label>
          <label className="of-field">
            <span>{t('Price step')}</span>
            <select
              value={String(setting.stepTicks)}
              onChange={(event) =>
                onSetting({ ...setting, stepTicks: LADDER_STEPS.find((n) => String(n) === event.target.value) ?? setting.stepTicks })
              }
            >
              {LADDER_STEPS.map((n) => (
                <option key={n} value={String(n)}>
                  {n === 1 ? t('Step tick') : t('Step ticks', { n })}
                </option>
              ))}
            </select>
          </label>
          <button type="button" className="of-close" onClick={onClose}>
            {t('Close DOM')}
          </button>
        </div>
      </div>
      <p className="of-note">{t('Ladder hint')}</p>
      <p className="of-note of-legend">{t('Ladder highlights')}</p>
      {old ? (
        <p className="of-note of-note--warn" role="status">
          {t('Ladder old')}
        </p>
      ) : null}
      {cancel.note ? (
        <p className={cancel.note.tone === 'bad' ? 'of-note of-note--bad' : 'of-note'} role="status" data-testid="of-cancel-note">
          {cancel.note.text}
        </p>
      ) : null}
      <AlertDialog open={cancel.asking !== null} onOpenChange={(open) => !open && cancel.setAsking(null)}>
        {cancel.asking ? (
          <AlertDialogContent className="dk-review" data-testid="of-cancel-review">
            <AlertDialogHeader>
              <AlertDialogTitle>{t('Cancel review title', { price: fmtPrice(cancel.asking.price, market.tickSize) })}</AlertDialogTitle>
              <AlertDialogDescription>
                {cancel.asking.orders
                  .map((order) =>
                    t('Cancel review line', {
                      side: order.side === 'buy' ? t('Buy') : t('Sell'),
                      amount: order.remaining,
                      asset: market.base,
                      price: fmtPrice(order.price ?? '', market.tickSize),
                    }),
                  )
                  .join('; ')}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <Button variant="secondary" size={40} onClick={() => cancel.setAsking(null)}>
                {t('Cancel review keep')}
              </Button>
              <Button
                variant="primary"
                size={40}
                onClick={() => {
                  if (cancel.asking) void cancel.run(cancel.asking.price, cancel.asking.orders, market.tickSize);
                }}
              >
                {t('Cancel review confirm')}
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        ) : null}
      </AlertDialog>
      <div className="of-body">
        <div className="of-col">
          {ladder}
          <QueuePanel market={market} mine={mine} />
        </div>
        <div className="of-col">
          {data ? <DepthChart market={market} data={data} /> : null}
          <TimeAndSales market={market} zone={zone} setting={setting} onSetting={onSetting} />
        </div>
      </div>
    </section>
  );
});
