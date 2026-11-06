/**
 * Trading from the chart itself (J-charts-desk-15, C-trade-dom-03, C-trade-dom-05, C-ops-02).
 *
 * - A ticket under the chart: side, limit price and amount. While it is open with a price on the tick, the order is
 *   projected on the chart as a dashed preview line; no order exists until Place is pressed and the review confirmed.
 * - The price-axis plus button (at the pointer's price) and the chart's context menu open the ticket at that price.
 * - Confirm places the reviewed order under its review number (`reviewIdFor`). When the answer is lost, "Send again"
 *   sends the SAME number, so the trade service keeps one order however often it is sent.
 * - Each open limit order on this market shows as a line with its side and size. Dragging the line's handle to a new
 *   price asks for a review of the replacement; only Confirm sends the cancel-replace, so the old order is cancelled
 *   (its hold released once, by the service) only when the new one is confirmed. The replacement's number is
 *   `replaceKey(order, price, amount)`: the same on every retry.
 * - A drag further than the owner's protection distance from the last price asks first, naming the distance, before
 *   anything is sent; while the owner has not set the distance, a drag refuses and nothing is sent.
 * - While the market is halted, not open or unreadable, every order control on the chart is disabled and names why.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { useDataEnv } from '../../../data/hooks';
import { fmtAmount, fmtPrice } from '../../../data/format';
import { useSession } from '../../../features/session/session';
import { draftSchema, type Draft, type Order, type Preview } from '../../../features/trade/trade-api';
import { useDeskApi, useOpenOrders, useRefreshPrivate } from '../../trade/desk/data';
import type { DeskMarket } from '../../trade/desk/market';
import { asReplacement, previewIsOrderable } from '../../trade/desk/preview';
import { replaceKey } from '../../trade/desk/replace-key';
import { resendOrder } from '../../trade/desk/resend';
import { forgetReviewId, reviewIdFor } from '../../trade/desk/review-id';
import type { ChartHost } from '../chart-host';
import { chartsCopy } from '../copy';
import { OWNER_VALUE_UNSET } from '../owner-values';
import { onTick, protectionCheck, samePrice, snapToTick } from './chart-orders';

type Side = 'buy' | 'sell';
type Note = { tone: 'good' | 'bad'; text: string; code?: string };
type Move =
  | { stage: 'protect'; order: Order; price: string; distance: string; limit: string }
  | { stage: 'review'; order: Order; price: string; draft: Draft; preview: Preview };

export const ORDER_ENTRY_REFUSED = 'trade.chart.order_entry_refused' as const;

export interface ChartTradingProps {
  host: ChartHost | null;
  market: DeskMarket;
  /** Why order entry is refused now (halted, not open, unreadable), from the chart's one rule; null when it is open. */
  refusal: string | null;
  /** The owner's protection distance in basis points, or null while it is blank, still loading or unreadable. */
  protectionBps: number | null;
  /** Why `protectionBps` is null: only 'unset' is the owner's blank; the others refuse without claiming it is unset. */
  protectionWhy?: 'loading' | 'unavailable' | 'unset' | null;
  /** A bar replay is showing past bars: no order is placed or moved from a chart that doesn't show the market now. */
  replaying?: boolean;
}

/** A pointer that moves less than this many pixels between down and up is a click on the line, not a drag. */
const DRAG_MIN_PX = 4;

const isLineOrder = (order: Order, symbol: string) =>
  order.symbol === symbol && order.type === 'limit' && order.price !== null && order.price !== undefined;

export function ChartTrading({ host, market, refusal, protectionBps, protectionWhy = null, replaying = false }: ChartTradingProps) {
  const { t } = chartsCopy.useCopy();
  const { userId, api: client } = useSession();
  const env = useDataEnv();
  const api = useDeskApi();
  const openOrders = useOpenOrders(userId !== null);
  const [open, setOpen] = useState(false);
  const [side, setSide] = useState<Side>('buy');
  const [price, setPrice] = useState('');
  const [amount, setAmount] = useState('');
  const [review, setReview] = useState<{ draft: Draft; preview: Preview } | null>(null);
  const [lost, setLost] = useState<Draft | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [move, setMove] = useState<Move | null>(null);
  const [cursor, setCursor] = useState<{ y: number; price: string } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; price: string } | null>(null);
  const [drag, setDrag] = useState<{ id: string; y: number; from: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [, setFrame] = useState(0);
  const priceField = useRef<HTMLInputElement>(null);
  const locked = refusal !== null || replaying;
  const signedIn = userId !== null;

  const lineOrders = useMemo(
    () => (openOrders.status === 'ready' ? openOrders.data.filter((order) => isLineOrder(order, market.symbol)) : []),
    [openOrders, market.symbol],
  );
  // An order's hold moves the balance too: every private list is read again, not only the open orders.
  const refreshOrders = useRefreshPrivate();

  // The overlays follow the chart: redrawn on a pan, a zoom, a resize and while the price scale moves with new bars.
  useEffect(() => {
    if (!host || !signedIn) return;
    let queued = false;
    const redraw = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        setFrame((n) => n + 1);
      });
    };
    const onMove = (param: { point?: { x: number; y: number } }) => {
      redraw();
      if (!param.point) return;
      const at = host.main.coordinateToPrice(param.point.y);
      const snapped = at === null ? null : snapToTick(at, host.tickSize);
      if (snapped) setCursor({ y: param.point.y, price: snapped });
    };
    host.chart.subscribeCrosshairMove(onMove);
    host.chart.timeScale().subscribeVisibleLogicalRangeChange(redraw);
    const resize = new ResizeObserver(redraw);
    resize.observe(host.element);
    const timer = window.setInterval(redraw, 1000);
    const onContext = (event: MouseEvent) => {
      event.preventDefault();
      const box = host.element.getBoundingClientRect();
      const y = event.clientY - box.top;
      const at = host.main.coordinateToPrice(y);
      const snapped = at === null ? null : snapToTick(at, host.tickSize);
      if (snapped) setMenu({ x: event.clientX - box.left, y, price: snapped });
    };
    host.element.addEventListener('contextmenu', onContext);
    return () => {
      host.chart.unsubscribeCrosshairMove(onMove);
      host.chart.timeScale().unsubscribeVisibleLogicalRangeChange(redraw);
      resize.disconnect();
      window.clearInterval(timer);
      host.element.removeEventListener('contextmenu', onContext);
    };
  }, [host, signedIn]);

  const projected = open && signedIn && !locked && onTick(price, market.tickSize) ? price : null;

  // The lines on the library's own canvas: the projected order dashed, each open order solid with its side and size.
  const lineKey = `${projected ?? ''}|${side}|${lineOrders.map((o) => `${o.id}:${o.price}:${o.remaining}`).join(',')}`;
  useEffect(() => {
    if (!host) return;
    const css = getComputedStyle(document.documentElement);
    const colour = (s: Side) => css.getPropertyValue(s === 'buy' ? '--if-up' : '--if-down').trim();
    const lines: unknown[] = [];
    if (projected)
      lines.push(
        host.main.createPriceLine({
          price: Number(projected),
          color: colour(side),
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: t(side === 'buy' ? 'Chart preview buy' : 'Chart preview sell'),
        }),
      );
    for (const order of lineOrders)
      lines.push(
        host.main.createPriceLine({
          price: Number(order.price),
          color: colour(order.side),
          lineWidth: 2,
          lineStyle: 0,
          axisLabelVisible: true,
          title: `${t(order.side === 'buy' ? 'Buy' : 'Sell')} ${order.remaining}`,
        }),
      );
    // The price scale takes in every line, so an order far from the bars is still on the chart to read and to drag.
    const prices = [projected, ...lineOrders.map((order) => order.price)].filter((p): p is string => !!p).map(Number);
    if (prices.length > 0)
      host.main.applyOptions({
        autoscaleInfoProvider: (original: () => { priceRange: { minValue: number; maxValue: number } } | null) => {
          const base = original();
          const low = Math.min(...prices, base?.priceRange.minValue ?? Infinity);
          const high = Math.max(...prices, base?.priceRange.maxValue ?? -Infinity);
          return { ...(base ?? {}), priceRange: { minValue: low, maxValue: high } };
        },
      });
    return () => {
      for (const line of lines) host.main.removePriceLine(line);
      if (prices.length > 0) host.main.applyOptions({ autoscaleInfoProvider: undefined });
    };
    // The key carries every value the lines draw.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, lineKey]);

  const openTicketAt = (at: string, as?: Side) => {
    if (locked) return;
    setMenu(null);
    setOpen(true);
    setPrice(at);
    if (as) setSide(as);
    setReview(null);
    setNote(null);
    requestAnimationFrame(() => priceField.current?.focus());
  };

  const run = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  };

  /** Place: the service checks the order and prices its hold and fee; nothing is sent until Confirm. */
  const place = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (locked || !userId) return;
    void run(async () => {
      setNote(null);
      const body = {
        symbol: market.symbol,
        side,
        type: 'limit' as const,
        amount: amount.trim(),
        price: price.trim(),
        timeInForce: 'GTC' as const,
        postOnly: false,
      };
      const parsed = draftSchema.safeParse({ ...body, clientOrderId: 'chart-check' });
      if (!parsed.success || !onTick(body.price, market.tickSize)) {
        setNote({ tone: 'bad', text: t('Chart order invalid', { tick: market.tickSize }) });
        return;
      }
      const draft: Draft = { ...parsed.data, clientOrderId: reviewIdFor(userId, body) };
      env.poller.recordExternalRequest();
      const answer = await api.preview(draft);
      if (!answer.ok) return setNote({ tone: 'bad', text: answer.message ?? t('Chart order unchecked') });
      if (!previewIsOrderable(answer.data))
        return setNote({ tone: 'bad', text: answer.data.refusals.map((row) => row.message).join(' ') || t('Chart order unchecked') });
      setReview({ draft, preview: answer.data });
    });
  };

  const placed = (order: Order) => {
    forgetReviewId(order.clientOrderId ?? '');
    setReview(null);
    // Only the order whose answer was lost is settled by this one; a different order leaves its "Send again" in place.
    setLost((was) => (was && was.clientOrderId === order.clientOrderId ? null : was));
    setOpen(false);
    setPrice('');
    setNote({
      tone: 'good',
      text: t('Chart order placed', {
        side: t(order.side === 'buy' ? 'Buy' : 'Sell'),
        amount: fmtAmount(order.amount),
        asset: market.base,
        price: fmtPrice(order.price ?? '', market.tickSize),
      }),
    });
    refreshOrders();
  };

  const confirm = () =>
    void run(async () => {
      if (!review) return;
      env.poller.recordExternalRequest(2);
      const result = await api.place(review.draft, review.preview);
      if (result.ok) return placed(result.data);
      if (result.reason === 'changed' && 'preview' in result && result.preview) {
        setReview({ draft: review.draft, preview: result.preview as Preview });
        return setNote({ tone: 'bad', text: t('Chart order changed') });
      }
      if (result.reason === 'uncertain') {
        // The answer was lost: the order may or may not be on the book. Only the same number is ever sent again.
        setLost(review.draft);
        setReview(null);
        return setNote({ tone: 'bad', text: t('Chart order lost') });
      }
      forgetReviewId(review.draft.clientOrderId);
      setReview(null);
      setNote({ tone: 'bad', text: result.message ?? t('Chart order unchecked') });
    });

  const sendAgain = () =>
    void run(async () => {
      if (!lost) return;
      env.poller.recordExternalRequest();
      const result = await resendOrder(client, lost);
      if (result.ok) return placed(result.order);
      if (result.reason === 'unsure') return setNote({ tone: 'bad', text: t('Chart order lost') });
      forgetReviewId(lost.clientOrderId);
      setLost(null);
      setNote({ tone: 'bad', text: t('Chart order refused') });
    });

  /** A dropped line: the replacement is checked with the service and shown; nothing is cancelled or placed yet. */
  const reviewMove = async (order: Order, to: string) => {
    const draft = draftSchema.safeParse({
      symbol: order.symbol,
      side: order.side,
      type: 'limit',
      amount: order.remaining,
      price: to,
      timeInForce: 'GTC',
      postOnly: false,
      clientOrderId: replaceKey(order.id, to, order.remaining),
    });
    if (!draft.success) return setNote({ tone: 'bad', text: t('Chart order unchecked') });
    env.poller.recordExternalRequest();
    const answer = await api.preview(draft.data);
    if (!answer.ok) return setNote({ tone: 'bad', text: answer.message ?? t('Chart order unchecked') });
    const preview = asReplacement(answer.data);
    if (!previewIsOrderable(preview))
      return setNote({ tone: 'bad', text: preview.refusals.map((row) => row.message).join(' ') || t('Chart order unchecked') });
    setMove({ stage: 'review', order, price: to, draft: draft.data, preview });
  };

  const dropped = (order: Order, y: number) =>
    void run(async () => {
      setNote(null);
      if (!host || locked) return;
      const at = host.main.coordinateToPrice(y);
      const to = at === null ? null : snapToTick(at, market.tickSize);
      if (!to || samePrice(to, order.price ?? '')) return;
      // The distance is judged against the last trade, read now; the read is a GET and sends no order.
      const ticker = await api.ticker(market.symbol);
      const last = ticker.ok ? (ticker.data.last ?? ticker.data.close) : null;
      const check = protectionCheck(to, last, protectionBps);
      if (check.kind === 'unset')
        return protectionWhy === 'unset'
          ? setNote({ tone: 'bad', text: t('Chart protection unset'), code: OWNER_VALUE_UNSET })
          : setNote({ tone: 'bad', text: t('Chart protection unread') });
      if (check.kind === 'no-reference') return setNote({ tone: 'bad', text: t('Chart protection no last') });
      if (check.kind === 'beyond') return setMove({ stage: 'protect', order, price: to, distance: check.distance, limit: check.limit });
      await reviewMove(order, to);
    });

  const confirmMove = () =>
    void run(async () => {
      if (!move || move.stage !== 'review') return;
      env.poller.recordExternalRequest(2);
      const result = await api.replace(move.order, move.draft, move.preview, (fresh) => previewIsOrderable(asReplacement(fresh)));
      if (!result.ok && result.reason === 'changed' && 'preview' in result && result.preview) {
        // The hold or fee moved before anything was sent: show the new values to confirm again.
        setMove({ ...move, preview: asReplacement(result.preview) });
        return setNote({ tone: 'bad', text: t('Chart order changed') });
      }
      setMove(null);
      refreshOrders();
      if (result.ok && result.data.accepted && result.data.replacement)
        return setNote({
          tone: 'good',
          text: t('Chart order moved', { price: fmtPrice(result.data.replacement.price ?? move.price, market.tickSize) }),
        });
      if (result.ok) return setNote({ tone: 'bad', text: t('Chart order not moved') });
      setNote({
        tone: 'bad',
        text: result.reason === 'uncertain' ? t('Chart move uncertain') : (result.message ?? t('Chart order not moved')),
      });
    });

  const onHandleDown = (event: ReactPointerEvent<HTMLButtonElement>, order: Order) => {
    if (locked || busy || !host) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const top = host.element.getBoundingClientRect().top;
    setDrag({ id: order.id, y: event.clientY - top, from: event.clientY - top });
  };
  const onHandleCancel = () => setDrag(null);
  const onHandleMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!drag || !host) return;
    setDrag({ ...drag, y: event.clientY - host.element.getBoundingClientRect().top });
  };
  const onHandleUp = (event: ReactPointerEvent<HTMLButtonElement>, order: Order) => {
    if (!drag || !host) return;
    const y = event.clientY - host.element.getBoundingClientRect().top;
    const from = drag.from;
    setDrag(null);
    if (Math.abs(y - from) < DRAG_MIN_PX) return; // a click on the line moves nothing
    dropped(order, y);
  };

  const stage = host?.element.parentElement ?? null;
  const yOf = (value: string | null | undefined) => (host && value ? host.main.priceToCoordinate(Number(value)) : null);
  const projectedY = yOf(projected);

  const overlay =
    stage && host && signedIn
      ? createPortal(
          <div className="ct-overlay" data-testid="chart-trading-overlay">
            {projected && projectedY !== null && (
              <div
                className="ct-line ct-line--preview"
                data-testid="chart-preview-line"
                data-side={side}
                data-price={projected}
                style={{ insetBlockStart: `${projectedY}px` }}
              >
                {t(side === 'buy' ? 'Chart preview buy' : 'Chart preview sell')} · {fmtPrice(projected, market.tickSize)} ·{' '}
                {t('Chart preview not placed')}
              </div>
            )}
            {lineOrders.map((order) => {
              const y = drag?.id === order.id ? drag.y : yOf(order.price);
              if (y === null) return null;
              return (
                <button
                  key={order.id}
                  type="button"
                  className="ct-line ct-line--order"
                  data-testid="chart-order-line"
                  data-order-id={order.id}
                  data-side={order.side}
                  data-price={order.price ?? ''}
                  data-amount={order.remaining}
                  disabled={locked}
                  aria-label={t('Chart order line', {
                    side: t(order.side === 'buy' ? 'Buy' : 'Sell'),
                    amount: order.remaining,
                    asset: market.base,
                    price: fmtPrice(order.price ?? '', market.tickSize),
                  })}
                  style={{ insetBlockStart: `${y}px` }}
                  onPointerDown={(event) => onHandleDown(event, order)}
                  onPointerMove={onHandleMove}
                  onPointerUp={(event) => onHandleUp(event, order)}
                  onPointerCancel={onHandleCancel}
                  onLostPointerCapture={onHandleCancel}
                >
                  {t(order.side === 'buy' ? 'Buy' : 'Sell')} {order.remaining} {market.base}
                </button>
              );
            })}
            {cursor && !locked && (
              <button
                type="button"
                className="ct-plus"
                data-testid="chart-axis-plus"
                data-price={cursor.price}
                aria-label={t('Chart create at', { price: fmtPrice(cursor.price, market.tickSize) })}
                style={{ insetBlockStart: `${cursor.y}px` }}
                onClick={() => openTicketAt(cursor.price)}
              >
                +
              </button>
            )}
            {menu && !locked && (
              <div
                className="ct-menu"
                role="menu"
                aria-label={t('Chart order menu')}
                style={{ insetBlockStart: `${menu.y}px`, insetInlineStart: `${menu.x}px` }}
              >
                <button type="button" role="menuitem" onClick={() => openTicketAt(menu.price, 'buy')}>
                  {t('Chart menu buy', { price: fmtPrice(menu.price, market.tickSize) })}
                </button>
                <button type="button" role="menuitem" onClick={() => openTicketAt(menu.price, 'sell')}>
                  {t('Chart menu sell', { price: fmtPrice(menu.price, market.tickSize) })}
                </button>
                <button type="button" role="menuitem" onClick={() => setMenu(null)}>
                  {t('Chart menu close')}
                </button>
              </div>
            )}
          </div>,
          stage,
        )
      : null;

  if (!signedIn)
    return (
      <div className="ct-bar" data-testid="chart-trading">
        <p className="cw-note">{t('Chart trading signed out')}</p>
      </div>
    );

  return (
    <div className="ct-bar" data-testid="chart-trading" data-locked={locked ? 'true' : 'false'}>
      {overlay}
      {refusal === null && replaying && (
        <p className="cw-note" role="status" data-testid="chart-trading-replay">
          {t('Chart trading replay')}
        </p>
      )}
      {refusal !== null && (
        <p className="cw-note" role="status" data-testid="chart-trading-refusal" data-code={ORDER_ENTRY_REFUSED}>
          {refusal}
        </p>
      )}
      <button type="button" aria-expanded={open} disabled={locked} onClick={() => setOpen((v) => !v)}>
        {t('Order on chart')}
      </button>
      {open && (
        <form className="ct-ticket" aria-label={t('Chart order ticket')} onSubmit={place}>
          <fieldset disabled={locked || busy}>
            <label className="cw-select cw-select--inline">
              <span>{t('Chart side')}</span>
              <select
                value={side}
                onChange={(event) => {
                  setSide(event.target.value as Side);
                  setReview(null);
                }}
              >
                <option value="buy">{t('Buy')}</option>
                <option value="sell">{t('Sell')}</option>
              </select>
            </label>
            <label className="cw-select cw-select--inline">
              <span>{t('Chart limit price', { quote: market.quote })}</span>
              <input
                ref={priceField}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={price}
                onChange={(event) => {
                  setPrice(event.target.value);
                  setReview(null);
                }}
              />
            </label>
            <label className="cw-select cw-select--inline">
              <span>{t('Chart amount', { base: market.base })}</span>
              <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={amount}
                onChange={(event) => {
                  setAmount(event.target.value);
                  setReview(null);
                }}
              />
            </label>
            <button type="submit">{t('Place')}</button>
          </fieldset>
        </form>
      )}
      {review && (
        <div className="ct-review" role="dialog" aria-label={t('Chart review order')} data-testid="chart-order-review">
          <p>
            {t('Chart review line', {
              side: t(review.draft.side === 'buy' ? 'Buy' : 'Sell'),
              amount: review.draft.amount,
              asset: market.base,
              price: fmtPrice(review.draft.price ?? '', market.tickSize),
            })}
          </p>
          <p>
            {t('Chart review hold', {
              hold: fmtAmount(review.preview.holdAmount ?? ''),
              holdAsset: review.preview.holdAsset ?? '',
              fee: fmtAmount(review.preview.estimatedFee ?? ''),
              feeAsset: review.preview.feeAsset ?? '',
            })}
          </p>
          <button type="button" onClick={confirm} disabled={busy || locked}>
            {t('Confirm')}
          </button>
          <button type="button" onClick={() => setReview(null)} disabled={busy}>
            {t('Cancel')}
          </button>
        </div>
      )}
      {lost && (
        <button type="button" onClick={sendAgain} disabled={busy || locked} data-testid="chart-send-again">
          {t('Chart send again')}
        </button>
      )}
      {move?.stage === 'protect' && (
        <div className="ct-review" role="alertdialog" aria-label={t('Chart protection title')} data-testid="chart-protection">
          <p>{t('Chart protection ask', { price: fmtPrice(move.price, market.tickSize), distance: move.distance, limit: move.limit })}</p>
          <button type="button" disabled={busy || locked} onClick={() => void run(() => reviewMove(move.order, move.price))}>
            {t('Chart protection continue')}
          </button>
          <button type="button" onClick={() => setMove(null)} disabled={busy}>
            {t('Cancel')}
          </button>
        </div>
      )}
      {move?.stage === 'review' && (
        <div className="ct-review" role="dialog" aria-label={t('Chart review move')} data-testid="chart-move-review">
          <p>
            {t('Chart move line', {
              side: t(move.order.side === 'buy' ? 'Buy' : 'Sell'),
              amount: move.order.remaining,
              asset: market.base,
              from: fmtPrice(move.order.price ?? '', market.tickSize),
              to: fmtPrice(move.price, market.tickSize),
            })}
          </p>
          <p>{t('Chart move note')}</p>
          <button type="button" onClick={confirmMove} disabled={busy || locked}>
            {t('Confirm')}
          </button>
          <button type="button" onClick={() => setMove(null)} disabled={busy}>
            {t('Cancel')}
          </button>
        </div>
      )}
      {note && (
        <p className="cw-note" role="status" data-testid="chart-trading-note" data-tone={note.tone} data-code={note.code}>
          {note.text}
        </p>
      )}
    </div>
  );
}
