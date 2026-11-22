/**
 * The DOM (J-charts-desk-14, C-trade-dom-01): a depth-of-market ladder, time and sales and a depth chart, opened from the
 * chart and bound to the chart's symbol. It reads the book and the tape the desk already reads: the ladder and the depth
 * chart draw the SAME book snapshot (its engine sequence is on both), and nothing here holds a balance or sends an order.
 * A click on a ladder cell asks the desk's own ticket for a draft at that price; the ticket reviews it (OrderForm).
 */
import { memo, useMemo, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import type { OrderBook } from '@intafaced/exchange-contract/schemas';
import type { Order } from '../../../features/trade/trade-api';
import type { Preferences } from '../../../shared/preferences';
import { Bone, Button, StateBlock } from '@intafaced/ui/lit';
import { fmtAmount, fmtPct, fmtPrice, refusalCopy, type Loadable } from '../../../data';
import { useQueuePosition, useTape } from './data';
import { useNow } from './hooks';
import { STALE_BOOK_MS } from './OrderBook';
import { flowCopy } from './order-flow-copy';
import { RowCancel } from './OneClick';
import {
  buildLadder,
  depthCurve,
  myOrdersAt,
  LADDER_STEPS,
  queueReadout,
  stepOf,
  tapeView,
  type DomSetting,
  type FlowMarket,
  type LadderColumns,
  type LadderStep,
  type TapePrint,
  type TapeUnits,
  type WorkingOrder,
} from './order-flow';
import { scaled } from './order-math';
import { placesOf } from './text';
import { depthGeometry } from '../chart/depth-geometry';
import { clockSeconds } from './time';

export interface LadderPick {
  side: 'buy' | 'sell';
  price: string;
}

interface Props {
  market: FlowMarket;
  book: Loadable<OrderBook>;
  openOrders: Loadable<Order[]>;
  zone: Preferences['timeZone'];
  setting: DomSetting;
  onSetting: (next: DomSetting) => void;
  onPick: (pick: LadderPick) => void;
  onClose: () => void;
  /** Instant placement is on (J-charts-desk-14 #6): a ladder click and a row's cancel act at once. */
  instant?: boolean;
  /** The one-click strip (J-charts-desk-14 #6 and #7): instant placement, size presets and one-click close. */
  oneClick?: ReactNode;
  /** A one-click cancel finished. */
  onCancelled?: () => void;
}

function Ladder<O extends WorkingOrder>({
  market,
  data,
  mine,
  columns,
  stepTicks,
  onPick,
  renderCancel,
}: {
  market: FlowMarket;
  data: Pick<OrderBook, 'bids' | 'asks'>;
  mine: readonly O[];
  columns: LadderColumns;
  stepTicks: LadderStep;
  onPick: (pick: LadderPick) => void;
  /** One-click cancel of my orders on one row (J-charts-desk-14 #7). */
  renderCancel: (orders: O[]) => ReactNode;
}) {
  const { t } = flowCopy.useCopy();
  const step = stepOf(market.tickSize, stepTicks) ?? market.tickSize;
  const ladder = useMemo(() => buildLadder(data, step, mine), [data, step, mine]);
  const amountPlaces = placesOf(market.lotSize);
  const size = (value: string) => (value === '' ? '' : fmtAmount(value, { places: amountPlaces, fixed: true }));
  const double = columns === 'double';
  if (ladder.rows.length === 0)
    return (
      <p className="lt-note" data-testid="of-ladder-empty">
        {t('Ladder empty')}
      </p>
    );
  return (
    <div
      className="lt-levels"
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
      <div className="lt-row lt-row-nowrap lt-label" role="row" data-columns={columns}>
        {double ? (
          <span role="columnheader" className="lt-grow">
            {t('Ladder my bids')}
          </span>
        ) : null}
        <span role="columnheader" className="lt-grow">
          {t('Ladder bid', { asset: market.base })}
        </span>
        <span role="columnheader" className="lt-grow">
          {t('Ladder price', { asset: market.quote })}
        </span>
        <span role="columnheader" className="lt-grow">
          {t('Ladder ask', { asset: market.base })}
        </span>
        <span role="columnheader" className="lt-grow">
          {double ? t('Ladder my asks') : t('Ladder mine')}
        </span>
      </div>
      <div className="lt-levels" role="rowgroup">
        {ladder.rows.map((row) => {
          const highlight = row.best ? `best-${row.best}` : row.myBid || row.myAsk ? 'mine' : undefined;
          const price = fmtPrice(row.price, market.tickSize);
          return (
            <div
              key={row.price}
              role="row"
              className={ladderRow(highlight !== undefined)}
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
                <span role="gridcell" className="lt-grow lt-num" data-testid="of-my-bid">
                  {size(row.myBid)}
                </span>
              ) : null}
              <span role="gridcell" className="lt-grow">
                <button
                  type="button"
                  className="lt-level lt-up"
                  data-testid="of-bid-cell"
                  aria-label={t('Ladder sell at', { price })}
                  onClick={() => onPick({ side: 'sell', price: row.price })}
                >
                  {size(row.bid)}
                </button>
              </span>
              <span role="gridcell" className="lt-grow lt-num" data-testid="of-price">
                {price}
              </span>
              <span role="gridcell" className="lt-grow">
                <button
                  type="button"
                  className="lt-level lt-down"
                  data-testid="of-ask-cell"
                  aria-label={t('Ladder buy at', { price })}
                  onClick={() => onPick({ side: 'buy', price: row.price })}
                >
                  {size(row.ask)}
                </button>
              </span>
              <span role="gridcell" className="lt-grow lt-num" data-testid={double ? 'of-my-ask' : 'of-mine'}>
                {double
                  ? size(row.myAsk)
                  : [row.myBid && `+${size(row.myBid)}`, row.myAsk && `−${size(row.myAsk)}`].filter(Boolean).join(' ')}
                {row.myBid || row.myAsk ? renderCancel(myOrdersAt(mine, row.price, step)) : null}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** One of my resting orders: its place in the native queue and, only with the owner's window set, the chance of a fill. */
function QueueRow({ market, order }: { market: FlowMarket; order: Order }) {
  const { t } = flowCopy.useCopy();
  const read = useQueuePosition(order.id);
  const amountPlaces = placesOf(market.lotSize);
  const size = (value: string) => fmtAmount(value, { places: amountPlaces });
  const head = t('My queue order', {
    side: order.side === 'buy' ? t('My queue side buy') : t('My queue side sell'),
    // Once the queue read answers, its own remaining size, so the heading and the basis below never disagree.
    amount: size(read.status === 'ready' ? read.data.remaining : order.remaining),
    asset: market.base,
    price: order.price ? fmtPrice(order.price, market.tickSize) : '—',
  });
  if (read.status !== 'ready')
    return (
      <li className="lt-stack-tight" data-testid="of-queue-row" data-order-id={order.id} data-state={read.status}>
        <span className="lt-strong">{head}</span>
        <span className="lt-note" role={read.status === 'loading' ? undefined : 'status'}>
          {read.status === 'loading'
            ? t('My queue loading')
            : read.status === 'refused' && read.code === 'trade.queue_unavailable'
              ? t('My queue unavailable')
              : read.status === 'refused'
                ? refusalCopy(read.code).title
                : t('My queue unavailable')}
        </span>
      </li>
    );
  const q = read.data;
  const view = queueReadout(q);
  const chance = view.chance.kind === 'estimate' ? view.chance : null;
  return (
    <li
      className="lt-stack-tight"
      data-testid="of-queue-row"
      data-state="ready"
      data-order-id={q.orderId}
      data-price={q.price}
      data-orders-ahead={q.ordersAhead}
      data-size-ahead={q.sizeAhead}
      data-as-of={q.asOfSequence}
      data-source={q.source}
      data-chance={chance ? chance.ratio : 'unset'}
      data-window={chance?.windowSeconds ?? ''}
      data-traded={chance?.tradedThrough ?? ''}
      data-to-fill={chance?.sizeToFill ?? ''}
    >
      <span className="lt-strong">{head}</span>
      <span data-testid="of-queue-ahead">
        {view.ahead.kind === 'first'
          ? t('My queue first')
          : view.ahead.kind === 'one'
            ? t('My queue ahead one', { size: size(view.ahead.size), asset: market.base })
            : t('My queue ahead', { n: view.ahead.n, size: size(view.ahead.size), asset: market.base })}
      </span>
      <span data-testid="of-queue-chance">
        {chance ? t('My queue chance', { pct: fmtPct(chance.ratio, { signed: false }) }) : t('My queue chance unset')}
      </span>
      <span className="lt-note" data-testid="of-queue-basis">
        {chance
          ? t('My queue basis', {
              traded: size(chance.tradedThrough),
              asset: market.base,
              seconds: chance.windowSeconds,
              toFill: size(chance.sizeToFill),
            })
          : t('My queue basis unset')}{' '}
        {t('My queue source')}
      </span>
    </li>
  );
}

/** My resting limit orders in this market and where each stands in the queue. */
function MyQueue({ market, mine }: { market: FlowMarket; mine: readonly Order[] }) {
  const { t } = flowCopy.useCopy();
  const resting = mine.filter((order) => order.type === 'limit' && order.price !== null);
  return (
    <section className="lt-stack" aria-label={t('My queue')} data-testid="of-queue">
      <h3 className="lt-panel-title">{t('My queue')}</h3>
      {resting.length === 0 ? (
        <p className="lt-note">{t('My queue none')}</p>
      ) : (
        <ul className="lt-list lt-list-tight lt-list-rule">
          {resting.map((order) => (
            <QueueRow key={order.id} market={market} order={order} />
          ))}
        </ul>
      )}
    </section>
  );
}

function TimeAndSales({
  market,
  zone,
  setting,
  onSetting,
  tape,
}: {
  market: FlowMarket;
  zone: Preferences['timeZone'];
  setting: DomSetting;
  onSetting: (next: DomSetting) => void;
  /** The prints the tape shows: today's public trades, or the venue's own prints. */
  tape: Loadable<readonly TapePrint[]>;
}) {
  const { t } = flowCopy.useCopy();
  const [typed, setTyped] = useState(setting.minAmount);
  const invalid = typed.trim() !== '' && (scaled(typed.trim()) === null || (scaled(typed.trim()) ?? 0n) < 0n);
  const amountPlaces = placesOf(market.lotSize);
  const trades: readonly TapePrint[] = tape.status === 'ready' ? tape.data : [];
  const view = useMemo(
    () => tapeView(trades, { minAmount: setting.minAmount, units: setting.units, accumulate: setting.accumulate }),
    [trades, setting.minAmount, setting.units, setting.accumulate],
  );
  const unitAsset = setting.units === 'base' ? market.base : market.quote;

  let body: React.ReactNode;
  if (tape.status === 'loading') body = <Bone size="block" />;
  else if (tape.status === 'error')
    body = <StateBlock kind="error" title={t('Couldn’t load trades')} onRetry={tape.retry} retryLabel={t('Try again')} />;
  else if (tape.status === 'refused') {
    const words = refusalCopy(tape.code);
    body = <StateBlock kind="refused" title={words.title} body={words.body} action={words.action} />;
  } else if (view.total === 0) body = <p className="lt-note">{t('Tape empty')}</p>;
  else
    body = (
      <>
        <p className="lt-note" role="status" data-testid="of-tape-hidden" data-hidden={view.hidden} data-total={view.total}>
          {view.hidden > 0 ? t('Tape hidden', { n: view.hidden, total: view.total }) : t('Tape none hidden', { total: view.total })}
        </p>
        {view.rows.length === 0 ? (
          <p className="lt-note">{t('Tape all hidden')}</p>
        ) : (
          <div className="lt-levels lt-scroll" role="grid" aria-label={t('Time and sales')}>
            <div className="lt-level lt-level-head" role="row">
              <span role="columnheader">{t('Tape time')}</span>
              <span role="columnheader">{t('Tape price', { asset: market.quote })}</span>
              <span role="columnheader">{t('Tape amount', { asset: unitAsset })}</span>
            </div>
            {view.rows.map((row) => (
              <div
                key={row.id}
                role="row"
                className="lt-level"
                data-testid="of-tape-row"
                data-trade-id={row.id}
                data-side={row.side ?? undefined}
                data-price={row.price}
                data-amount={row.amount}
                data-value={row.value}
                data-prints={row.prints}
                data-bar={row.bar}
              >
                <meter className="lt-meter" min={0} max={1000} value={row.bar} aria-hidden="true" />
                <span role="gridcell">{clockSeconds(row.timestamp, zone)}</span>
                <span role="gridcell" className={printTone(row.side)} data-side={row.side ?? undefined}>
                  {fmtPrice(row.price, market.tickSize)}
                </span>
                <span role="gridcell">
                  {setting.units === 'base'
                    ? fmtAmount(row.amount, { places: amountPlaces, fixed: true })
                    : fmtAmount(row.value, { places: placesOf(market.tickSize) })}
                  {row.prints > 1 ? <span className="lt-quiet"> · {t('Tape prints', { n: row.prints })}</span> : null}
                </span>
              </div>
            ))}
          </div>
        )}
      </>
    );

  return (
    <section className="lt-stack" aria-label={t('Time and sales')} data-testid="of-tape">
      <h3 className="lt-panel-title">{t('Time and sales')}</h3>
      <div className="lt-row lt-row-baseline">
        <label className="lt-field">
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
        <label className="lt-field">
          <span>{t('Units')}</span>
          <select value={setting.units} onChange={(event) => onSetting({ ...setting, units: event.target.value as TapeUnits })}>
            <option value="base">{market.base}</option>
            <option value="quote">{market.quote}</option>
          </select>
        </label>
        <label className="lt-field">
          <input
            type="checkbox"
            checked={setting.accumulate}
            onChange={(event) => onSetting({ ...setting, accumulate: event.target.checked })}
          />
          <span>{t('Accumulate at price')}</span>
        </label>
      </div>
      {invalid ? (
        <p id="of-min-invalid" className="lt-note lt-note-bad">
          {t('Minimum invalid')}
        </p>
      ) : null}
      {body}
    </section>
  );
}

/** Kit classes for a print's side: buys in the gain colour, sells in the loss colour, unknown plain. */
const PRINT_TONE = { buy: 'lt-num lt-up', sell: 'lt-num lt-down', none: 'lt-num' } as const;
const LADDER_ROW = { plain: 'lt-row lt-row-nowrap', marked: 'lt-row lt-row-nowrap lt-strong' } as const;
const ladderRow = (marked: boolean) => LADDER_ROW[marked ? 'marked' : 'plain'];
const printTone = (side: TapePrint['side']) => PRINT_TONE[side ?? 'none'];

const W = 320;
const H = 140;

function DepthChart({ market, data }: { market: FlowMarket; data: OrderBook }) {
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
    <section className="lt-stack" aria-label={t('Depth chart')} data-testid="of-depth">
      <div className="lt-panel-head">
        <h3 className="lt-panel-title">{t('Depth chart')}</h3>
        <label className="lt-field">
          <span>{t('Depth units')}</span>
          <select value={units} onChange={(event) => setUnits(event.target.value as TapeUnits)}>
            <option value="base">{market.base}</option>
            <option value="quote">{market.quote}</option>
          </select>
        </label>
      </div>
      {empty ? (
        <p className="lt-note" data-testid="of-depth-empty">
          {t('Depth empty')}
        </p>
      ) : (
        <>
          <svg
            className="lt-canvas lt-canvas-short"
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
            <path d={geometry.bidPath} fill="var(--lit-up-text)" fillOpacity="0.18" stroke="var(--lit-up-text)" />
            <path d={geometry.askPath} fill="var(--lit-down-text)" fillOpacity="0.18" stroke="var(--lit-down-text)" />
            {hover ? <line stroke="var(--lit-text-2)" strokeDasharray="3 3" x1={hover.x} x2={hover.x} y1={0} y2={H} /> : null}
          </svg>
          <p
            className="lt-note"
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

const noop = () => {};

/** What the DOM draws, from whichever book, tape and orders it is given (today's engine, or a venue: VenueOrderFlow.tsx). */
export interface OrderFlowViewProps<O extends WorkingOrder> {
  market: FlowMarket;
  /** One book snapshot: the ladder and the depth chart both draw it. */
  book: Loadable<OrderBook>;
  /** My working orders on this market. */
  mine: readonly O[];
  tape: Loadable<readonly TapePrint[]>;
  /** My place in the queue for my resting orders. */
  queue: ReactNode;
  renderCancel: (orders: O[]) => ReactNode;
  zone: Preferences['timeZone'];
  setting: DomSetting;
  onSetting: (next: DomSetting) => void;
  onPick: (pick: LadderPick) => void;
  onClose: () => void;
  instant?: boolean;
  oneClick?: ReactNode;
  /** The source of the figures, named under the title (the venue's TEST mark), when not today's engine. */
  badge?: ReactNode;
}

/** The DOM widget: the ladder, time and sales and the depth chart for the chart's market. */
export function OrderFlowView<O extends WorkingOrder>({
  market,
  book,
  mine,
  tape,
  queue,
  renderCancel,
  zone,
  setting,
  onSetting,
  onPick,
  onClose,
  instant = false,
  oneClick,
  badge,
}: OrderFlowViewProps<O>) {
  const { t } = flowCopy.useCopy();
  const now = useNow(1000);
  const data = book.status === 'ready' ? book.data : null;
  const old = data !== null && now - data.timestamp >= STALE_BOOK_MS;

  let ladder: React.ReactNode;
  if (book.status === 'loading') ladder = <Bone size="block" />;
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
        renderCancel={renderCancel}
      />
    );
  else ladder = <p className="lt-note">{t('Ladder empty')}</p>;

  return (
    <section
      className="lt-panel"
      aria-label={t('Depth of market')}
      data-testid="of-dom"
      data-symbol={market.symbol}
      data-book-nonce={data?.nonce ?? ''}
      data-columns={setting.columns}
      data-step-ticks={setting.stepTicks}
    >
      <div className="lt-panel-head">
        <h2 className="lt-panel-title">
          {t('DOM for', { pair: market.symbol })}
          {badge ? <> {badge}</> : null}
        </h2>
        <div className="lt-row lt-row-baseline">
          <label className="lt-field">
            <span>{t('Columns')}</span>
            <select value={setting.columns} onChange={(event) => onSetting({ ...setting, columns: event.target.value as LadderColumns })}>
              <option value="single">{t('Columns single')}</option>
              <option value="double">{t('Columns double')}</option>
            </select>
          </label>
          <label className="lt-field">
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
          <Button tone="secondary" size="sm" onClick={onClose}>
            {t('Close DOM')}
          </Button>
        </div>
      </div>
      {oneClick}
      <p className="lt-note" data-testid="of-ladder-hint">
        {instant ? t('Ladder hint instant') : t('Ladder hint')}
      </p>
      <p className="lt-note">{t('Ladder highlights')}</p>
      {old ? (
        <p className="lt-note lt-note-warn" role="status">
          {t('Ladder old')}
        </p>
      ) : null}
      <div className="lt-cols-2">
        <div className="lt-stack">
          {ladder}
          {queue}
        </div>
        <div className="lt-stack">
          {data ? <DepthChart market={market} data={data} /> : null}
          <TimeAndSales market={market} zone={zone} setting={setting} onSetting={onSetting} tape={tape} />
        </div>
      </div>
    </section>
  );
}

/** The DOM on today's desk: our engine's book and tape, my orders there and their place in the native queue. */
export const OrderFlow = memo(function OrderFlow({
  market,
  book,
  openOrders,
  zone,
  setting,
  onSetting,
  onPick,
  onClose,
  instant = false,
  oneClick,
  onCancelled,
}: Props) {
  const tape = useTape(market.symbol, true);
  const mine = useMemo(
    () =>
      openOrders.status === 'ready' ? openOrders.data.filter((order) => order.symbol === market.symbol && order.status === 'open') : [],
    [openOrders, market.symbol],
  );
  const done = onCancelled ?? noop;
  const renderCancel = (orders: Order[]) => <RowCancel market={market} orders={orders} instant={instant} onDone={done} />;
  return (
    <OrderFlowView
      market={market}
      book={book}
      mine={mine}
      tape={tape}
      queue={<MyQueue market={market} mine={mine} />}
      renderCancel={renderCancel}
      zone={zone}
      setting={setting}
      onSetting={onSetting}
      onPick={onPick}
      onClose={onClose}
      instant={instant}
      oneClick={oneClick}
    />
  );
});
