/**
 * Placing and moving orders from the venue desk's chart (J-charts-desk-15, C-trade-dom-03, C-trade-dom-05, C-ops-02), on
 * the person's own venue account: an order from the chart is the same signed venue order as the desk's (J-cex-spot-05).
 * Nothing here posts to our ledger or holds a balance; every lock and answer is the venue's.
 *
 * - A ticket under the chart: side, limit price and amount. While it is open with a price on the tick, the order is
 *   projected on the chart as a dashed preview line. Place asks the venue for its preview (what it would lock and charge);
 *   nothing is prepared, signed or sent until Confirm.
 * - The price-axis plus button (at the pointer's price) and the chart's context menu open the ticket at that price.
 * - Confirm prepares the order, the wallet signs once, and the door submits it under the draft's client order key. When
 *   the answer is lost, "Send again" sends the same signed bytes under the same key, so the venue keeps one order.
 * - Each of the person's open limit orders on this market shows as a line with its side and size. Dragging a line asks the
 *   venue for its preview of the replacement; only Confirm sends the one signed cancel-and-replace, so the old order is
 *   cancelled (its lock released, as the venue reports) only when the new one is confirmed. The replacement's keys come
 *   from the drag's draft and stay the same on every retry of it.
 * - A drag further than the owner's protection distance from the venue's last trade asks first, naming the distance,
 *   before anything is previewed or sent. While the owner has not set the distance, a drag refuses and nothing is sent.
 * - While the venue reports the market halted, cancel only or delisted, or our listing stops routing new orders to it,
 *   every order control on the chart is disabled and names why.
 */
import { useMemo, useRef, useState, type FormEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { displayAmount } from '../../../shared/money';
import { useChartOverlay, useChartPriceLines } from '../../../shared/chart-overlay';
import {
  canonicalDecimal,
  draftId,
  keys,
  onStep,
  type MaybeKnown,
  type OrderIntent,
  type VenueMarket,
  type VenueOrder,
  type VenuePreview,
} from '../../../features/trade/venue-api';
import { useVenueApi, type ActionResult, type RunAction } from '../../../features/trade/venue/VenueKit';
import type { ChartOrderHost } from '../../charts/chart-host';
import { OWNER_VALUE_UNSET, ownerValue, useChartOwnerCounts } from '../../charts/owner-values';
import { protectionCheck, samePrice, snapToTick } from '../../charts/trading/chart-orders';
import { pricePane } from '../../charts/trading/ChartTrading';
import '../../charts/trading/chart-trading.css';
import { chartOrdersCopy } from './venue-chart-orders-copy';

type Side = 'buy' | 'sell';
type T = ReturnType<typeof chartOrdersCopy.useCopy>['t'];
type Note = { tone: 'good' | 'bad'; text: string; code?: string };
type Move =
  | { stage: 'protect'; order: VenueOrder; price: string; distance: string; limit: string }
  | { stage: 'review'; order: VenueOrder; price: string; intent: OrderIntent; actionKey: string; preview: VenuePreview };

/** The code the chart's refusal carries, the same as the workbench chart's (C-ops-02). */
export const ORDER_ENTRY_REFUSED = 'trade.chart.order_entry_refused' as const;

/** A pointer that moves less than this many pixels between down and up is a click on the line, not a drag. */
const DRAG_MIN_PX = 4;

const LIVE = new Set(['open', 'partially_filled']);
const isLineOrder = (order: VenueOrder, symbol: string) =>
  order.symbol === symbol && order.type === 'limit' && LIVE.has(order.status) && !!order.venueClientOrderId && !order.trigger;

/**
 * Why order entry on this chart is off, in words, or null while the market takes new orders: the venue's own state for
 * it first, then our listing's routing. A venue that reports no state leaves the venue's preview to refuse.
 */
export function chartOrderRefusal(market: VenueMarket, venueName: string, t: T): string | null {
  const at = { symbol: market.symbol, venue: venueName };
  if (market.status === 'halted') return t('Off halted', at);
  if (market.status === 'cancel_only') return t('Off cancel only', at);
  if (market.status === 'delisted') return t('Off delisted', at);
  if (market.listing?.routing === 'stop') return t('Off routing stopped', at);
  if (market.listing?.routing === 'close_only') return t('Off close only', at);
  if (market.listing?.delisted) return t('Off delisted here', at);
  return null;
}

const known = (t: T, v: MaybeKnown<{ amount: string; asset: string }>) =>
  v.known ? `${displayAmount(v.value.amount)} ${v.value.asset}` : t('Not published');

/** Words for an answer that is not the venue's definite yes: the wallet, a refusal before or by the venue, or none. */
function notPlaced(t: T, answer: ActionResult): Note | null {
  switch (answer.kind) {
    case 'rejected':
      return { tone: 'bad', text: t('Wallet rejected') };
    case 'waiting':
      return { tone: 'bad', text: t('Wallet waiting') };
    case 'wallet_failed':
      return { tone: 'bad', text: t('Wallet failed', { message: answer.message }) };
    case 'unknown':
      return { tone: 'bad', text: t('Lost') };
    case 'refused':
      return { tone: 'bad', text: t('Door refused', { detail: answer.message }), ...(answer.code ? { code: answer.code } : {}) };
    case 'outcome':
      return answer.outcome.accepted
        ? null
        : { tone: 'bad', text: t('Refused', { detail: answer.outcome.refusal.detail }), code: answer.outcome.refusal.code };
  }
}

export interface VenueChartOrdersProps {
  host: ChartOrderHost | null;
  market: VenueMarket;
  venueName: string;
  /** The connected wallet's address, the venue account's owner; null until a wallet is connected on the right network. */
  owner: string | null;
  /** The person's open orders on the venue, as the desk last read them; null while unread. */
  openOrders: readonly VenueOrder[] | null;
  run: RunAction;
  resend: (intent: OrderIntent) => Promise<ActionResult>;
  /** Every answer a placement from the chart got, for the desk's own records (its key for a later cancel) and a re-read. */
  onPlaced: (intent: OrderIntent, answer: ActionResult) => void;
  /** After a move was sent: the desk reads the venue again. */
  onChanged: () => void;
}

export function VenueChartOrders({ host, market, venueName, owner, openOrders, run, resend, onPlaced, onChanged }: VenueChartOrdersProps) {
  const { t } = chartOrdersCopy.useCopy();
  const venue = useVenueApi();
  const counts = useChartOwnerCounts();
  const protectionRead = ownerValue(counts, 'orderProtectionBps');
  const protectionBps = protectionRead.ok ? protectionRead.value : null;
  const refusal = chartOrderRefusal(market, venueName, t);
  const locked = refusal !== null || owner === null;
  const [open, setOpen] = useState(false);
  const [side, setSide] = useState<Side>('buy');
  const [price, setPrice] = useState('');
  const [amount, setAmount] = useState('');
  const [review, setReview] = useState<{ intent: OrderIntent; preview: VenuePreview } | null>(null);
  const [lost, setLost] = useState<OrderIntent | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [move, setMove] = useState<Move | null>(null);
  const [cursor, setCursor] = useState<{ y: number; price: string } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; price: string } | null>(null);
  const [drag, setDrag] = useState<{ id: string; y: number; from: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const priceField = useRef<HTMLInputElement>(null);
  // One reviewed order keeps its draft (so its client order key) until the venue answers definitely: a second Confirm, a
  // lost answer or Send again is the same order. The same holds for one drag's replacement.
  const placeDraft = useRef<{ fields: string; id: string } | null>(null);
  const moveDraft = useRef<{ key: string; id: string } | null>(null);

  const lineOrders = useMemo(() => (openOrders ?? []).filter((order) => isLineOrder(order, market.symbol)), [openOrders, market.symbol]);

  // The overlay follows the chart: the pointer's price on the price pane, the context menu, and a redraw on a pan, a
  // zoom, a resize and while the price scale moves with new bars.
  useChartOverlay(host, {
    onCrosshair: (param) => {
      if (!host || !param.point) return;
      // Only the price pane names a price: over the volume pane the plus button goes away.
      const pane = pricePane(host);
      if (param.paneIndex !== undefined && param.paneIndex !== pane.index) return setCursor(null);
      const at = host.main.coordinateToPrice(param.point.y);
      const snapped = at === null ? null : snapToTick(at, host.tickSize);
      setCursor(snapped ? { y: pane.top + param.point.y, price: snapped } : null);
    },
    onContextMenu: (event) => {
      if (!host) return;
      const box = host.element.getBoundingClientRect();
      const y = event.clientY - box.top;
      const pane = pricePane(host);
      if (y < pane.top || y > pane.top + pane.height) return setMenu(null); // not on the price pane: no price to order at
      const at = host.main.coordinateToPrice(y - pane.top);
      const snapped = at === null ? null : snapToTick(at, host.tickSize);
      if (snapped) setMenu({ x: event.clientX - box.left, y, price: snapped });
    },
  });

  const projected = open && !locked && onStep(price.trim(), market.tickSize) ? price.trim() : null;

  // The lines on the library's own canvas: the projected order dashed, each open order solid with its side and size.
  const token = (s: Side) => (s === 'buy' ? '--if-up' : '--if-down');
  useChartPriceLines(
    host,
    [
      ...(projected
        ? [
            {
              price: Number(projected),
              token: token(side),
              lineWidth: 1,
              lineStyle: 2,
              title: t(side === 'buy' ? 'Preview buy' : 'Preview sell'),
            },
          ]
        : []),
      ...lineOrders.map((order) => ({
        price: Number(order.price),
        token: token(order.side),
        lineWidth: 2,
        lineStyle: 0,
        title: `${t(order.side === 'buy' ? 'Buy' : 'Sell')} ${order.remaining}`,
      })),
    ],
    `${projected ?? ''}|${side}|${lineOrders.map((o) => `${o.venueClientOrderId}:${o.price}:${o.remaining}`).join(',')}`,
  );

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

  const work = async (fn: () => Promise<void>) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    try {
      await fn();
    } finally {
      working.current = false;
      setBusy(false);
    }
  };

  /** Place: the venue previews the order (its lock and fees); nothing is prepared, signed or sent until Confirm. */
  const place = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (locked || !owner) return;
    void work(async () => {
      setNote(null);
      const p = price.trim();
      const a = amount.trim();
      if (!onStep(p, market.tickSize) || !onStep(a, market.lotSize))
        return setNote({ tone: 'bad', text: t('Invalid', { tick: market.tickSize, lot: market.lotSize }) });
      const fields = `${side}:${canonicalDecimal(p)}:${canonicalDecimal(a)}`;
      if (placeDraft.current?.fields !== fields) placeDraft.current = { fields, id: draftId() };
      const intent: OrderIntent = {
        kind: 'place_order',
        symbol: market.symbol,
        side,
        type: 'limit',
        amount: a,
        price: p,
        timeInForce: 'GTC',
        reduceOnly: false,
        clientOrderKey: keys.order(owner, market.symbol, placeDraft.current.id),
        builderFee: null,
      };
      const answer = await venue.preview(owner, intent);
      if (!answer.ok) return setNote({ tone: 'bad', text: t('Not checked', { detail: answer.message }), code: answer.code });
      setReview({ intent, preview: answer.data.value });
    });
  };

  /** One answer to a placement or to Send again, in words; a definite one lets go of the draft. */
  const answered = (intent: OrderIntent, answer: ActionResult) => {
    onPlaced(intent, answer);
    if (answer.kind === 'unknown') {
      setLost(intent);
      setReview(null);
      return setNote({ tone: 'bad', text: t('Lost') });
    }
    const bad = notPlaced(t, answer);
    if (answer.kind === 'outcome') {
      placeDraft.current = null;
      setLost(null);
      setReview(null);
    }
    if (bad) return setNote(bad);
    if (answer.kind !== 'outcome' || !answer.outcome.accepted) return;
    const order = answer.outcome.order;
    const words = {
      side: t(intent.side === 'buy' ? 'Buy' : 'Sell'),
      amount: displayAmount(intent.amount),
      asset: market.baseAsset,
      price: displayAmount(order?.price ?? intent.price),
      id: order?.venueClientOrderId ?? answer.clientOrderId ?? '',
      status: order?.status ?? '',
    };
    setOpen(false);
    setPrice('');
    setNote({ tone: 'good', text: order && !LIVE.has(order.status) ? t('Placed filled', words) : t('Placed', words) });
  };

  const confirm = () =>
    void work(async () => {
      if (!review || locked) return;
      answered(review.intent, await run(review.intent));
    });

  const sendAgain = () =>
    void work(async () => {
      if (!lost) return;
      answered(lost, await resend(lost));
    });

  /** A dropped line: the venue previews the replacement and it is shown; nothing is cancelled or placed yet. */
  const reviewMove = async (order: VenueOrder, to: string) => {
    if (!owner || !order.venueClientOrderId) return;
    const key = `${order.venueClientOrderId}:${canonicalDecimal(to)}`;
    if (moveDraft.current?.key !== key) moveDraft.current = { key, id: draftId() };
    const draft = moveDraft.current.id;
    const intent: OrderIntent = {
      kind: 'place_order',
      symbol: order.symbol,
      side: order.side,
      type: 'limit',
      amount: order.remaining,
      price: to,
      timeInForce: order.timeInForce,
      reduceOnly: order.reduceOnly,
      clientOrderKey: keys.replacement(owner, order.symbol, draft),
      builderFee: null,
    };
    const answer = await venue.preview(owner, intent);
    if (!answer.ok) return setNote({ tone: 'bad', text: t('Not checked', { detail: answer.message }), code: answer.code });
    setMove({ stage: 'review', order, price: to, intent, actionKey: keys.replace(owner, draft), preview: answer.data.value });
  };

  const dropped = (order: VenueOrder, y: number) =>
    void work(async () => {
      setNote(null);
      if (!host || locked) return;
      // y is from the host's top, as the overlay draws it; the library reads it from the price pane's top.
      const at = host.main.coordinateToPrice(y - pricePane(host).top);
      const to = at === null ? null : snapToTick(at, market.tickSize);
      if (!to || samePrice(to, order.price)) return;
      // The distance is judged against the venue's last trade, read now; the read is a GET and sends no order.
      const tape = await venue.trades(market.symbol, 1);
      const last = tape.ok ? (tape.data.value[0]?.price ?? null) : null;
      const check = protectionCheck(to, last, protectionBps);
      if (check.kind === 'unset')
        return !protectionRead.ok && protectionRead.why === 'unset'
          ? setNote({ tone: 'bad', text: t('Protection unset'), code: OWNER_VALUE_UNSET })
          : setNote({ tone: 'bad', text: t('Protection unread') });
      if (check.kind === 'no-reference') return setNote({ tone: 'bad', text: t('Protection no last') });
      if (check.kind === 'beyond') return setMove({ stage: 'protect', order, price: to, distance: check.distance, limit: check.limit });
      await reviewMove(order, to);
    });

  const confirmMove = () =>
    void work(async () => {
      if (!move || move.stage !== 'review' || locked || !move.order.venueClientOrderId) return;
      const answer = await run(
        { kind: 'replace_order', symbol: move.order.symbol, venueClientOrderId: move.order.venueClientOrderId, order: move.intent },
        { actionKey: move.actionKey },
      );
      onChanged();
      setMove(null);
      if (answer.kind === 'unknown') return setNote({ tone: 'bad', text: t('Move unknown') });
      if (answer.kind === 'outcome') moveDraft.current = null;
      const bad = notPlaced(t, answer);
      if (bad) return setNote(bad);
      if (answer.kind !== 'outcome' || !answer.outcome.accepted) return;
      const [cancelled, placed] = answer.outcome.legs ?? [];
      if (!cancelled?.accepted)
        return setNote({ tone: 'bad', text: t('Move nothing changed', { detail: cancelled ? cancelled.refusal.detail : '' }) });
      if (!placed?.accepted)
        return setNote({ tone: 'bad', text: t('Move cancelled only', { detail: placed ? placed.refusal.detail : '' }) });
      const order = placed.order;
      setNote({
        tone: 'good',
        text: t('Moved', {
          price: displayAmount(order?.price ?? move.price),
          id: order?.venueClientOrderId ?? '',
          lock: `${displayAmount(order?.locked ?? '')} ${order?.lockedAsset ?? ''}`,
        }),
      });
    });

  const onHandleDown = (event: ReactPointerEvent<HTMLButtonElement>, order: VenueOrder) => {
    if (locked || busy || !host) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const top = host.element.getBoundingClientRect().top;
    setDrag({ id: order.venueClientOrderId ?? '', y: event.clientY - top, from: event.clientY - top });
  };
  const onHandleCancel = () => setDrag(null);
  const onHandleMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!drag || !host) return;
    setDrag({ ...drag, y: event.clientY - host.element.getBoundingClientRect().top });
  };
  const onHandleUp = (event: ReactPointerEvent<HTMLButtonElement>, order: VenueOrder) => {
    if (!drag || !host) return;
    const y = event.clientY - host.element.getBoundingClientRect().top;
    const from = drag.from;
    setDrag(null);
    if (Math.abs(y - from) < DRAG_MIN_PX) return; // a click on the line moves nothing
    dropped(order, y);
  };

  const stage = host?.element.parentElement ?? null;
  const pane = host ? pricePane(host) : null;
  const yOf = (value: string | null | undefined) => {
    const y = host && pane && value ? host.main.priceToCoordinate(Number(value)) : null;
    return y === null || !pane ? null : pane.top + y;
  };
  const projectedY = yOf(projected);
  const sideWord = (s: Side) => t(s === 'buy' ? 'Buy' : 'Sell');

  const overlay =
    stage && host && pane
      ? createPortal(
          <div className="ct-overlay" data-testid="chart-trading-overlay" data-pane-top={pane.top} data-pane-height={pane.height}>
            {projected && projectedY !== null && (
              <div
                className="ct-line ct-line--preview"
                data-testid="chart-preview-line"
                data-side={side}
                data-price={projected}
                style={{ insetBlockStart: `${projectedY}px` }}
              >
                {t(side === 'buy' ? 'Preview buy' : 'Preview sell')} · {displayAmount(projected)} · {t('Not placed')}
              </div>
            )}
            {lineOrders.map((order) => {
              const id = order.venueClientOrderId ?? '';
              const y = drag?.id === id ? drag.y : yOf(order.price);
              if (y === null) return null;
              return (
                <button
                  key={id}
                  type="button"
                  className="ct-line ct-line--order"
                  data-testid="chart-order-line"
                  data-client-order-id={id}
                  data-side={order.side}
                  data-price={order.price}
                  data-amount={order.remaining}
                  disabled={locked}
                  aria-label={t('Order line', {
                    side: sideWord(order.side),
                    amount: displayAmount(order.remaining),
                    asset: market.baseAsset,
                    price: displayAmount(order.price),
                  })}
                  style={{ insetBlockStart: `${y}px` }}
                  onPointerDown={(event) => onHandleDown(event, order)}
                  onPointerMove={onHandleMove}
                  onPointerUp={(event) => onHandleUp(event, order)}
                  onPointerCancel={onHandleCancel}
                  onLostPointerCapture={onHandleCancel}
                >
                  {sideWord(order.side)} {displayAmount(order.remaining)} {market.baseAsset}
                </button>
              );
            })}
            {cursor && !locked && (
              <button
                type="button"
                className="ct-plus"
                data-testid="chart-axis-plus"
                data-price={cursor.price}
                aria-label={t('Create at', { price: displayAmount(cursor.price) })}
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
                aria-label={t('Order menu')}
                style={{ insetBlockStart: `${menu.y}px`, insetInlineStart: `${menu.x}px` }}
              >
                <button type="button" role="menuitem" onClick={() => openTicketAt(menu.price, 'buy')}>
                  {t('Menu buy', { price: displayAmount(menu.price) })}
                </button>
                <button type="button" role="menuitem" onClick={() => openTicketAt(menu.price, 'sell')}>
                  {t('Menu sell', { price: displayAmount(menu.price) })}
                </button>
                <button type="button" role="menuitem" onClick={() => setMenu(null)}>
                  {t('Menu close')}
                </button>
              </div>
            )}
          </div>,
          stage,
        )
      : null;

  return (
    <div className="ct-bar" data-testid="chart-trading" data-locked={locked ? 'true' : 'false'}>
      {overlay}
      {refusal !== null ? (
        <p className="dk-note" role="status" data-testid="chart-trading-refusal" data-code={ORDER_ENTRY_REFUSED}>
          {refusal}
        </p>
      ) : owner === null ? (
        <p className="dk-note" role="status" data-testid="chart-trading-refusal">
          {t('No wallet')}
        </p>
      ) : null}
      <button type="button" aria-expanded={open} disabled={locked} onClick={() => setOpen((v) => !v)}>
        {t('Order on chart')}
      </button>
      {open && (
        <form className="ct-ticket" aria-label={t('Ticket title')} onSubmit={place}>
          <fieldset disabled={locked || busy}>
            <label className="of-field">
              <span>{t('Side')}</span>
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
            <label className="of-field">
              <span>{t('Limit price', { quote: market.quoteAsset })}</span>
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
            <label className="of-field">
              <span>{t('Amount', { base: market.baseAsset })}</span>
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
        <div className="ct-review" role="dialog" aria-label={t('Review order')} data-testid="chart-order-review">
          <p>
            {t('Review line', {
              side: sideWord(review.intent.side),
              amount: displayAmount(review.intent.amount),
              asset: market.baseAsset,
              price: displayAmount(review.intent.price),
            })}
          </p>
          <p data-testid="chart-review-lock" data-lock={review.preview.lock.amount} data-lock-asset={review.preview.lock.asset}>
            {t('Review lock', {
              lock: `${displayAmount(review.preview.lock.amount)} ${review.preview.lock.asset}`,
              venueFee: known(t, review.preview.venueFee),
              builderFee: known(t, review.preview.builderFee),
            })}
          </p>
          <p>{t('Review before send')}</p>
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
          {t('Send again')}
        </button>
      )}
      {move?.stage === 'protect' && (
        <div className="ct-review" role="alertdialog" aria-label={t('Protection title')} data-testid="chart-protection">
          <p>{t('Protection ask', { price: displayAmount(move.price), distance: move.distance, limit: move.limit })}</p>
          <button type="button" disabled={busy || locked} onClick={() => void work(() => reviewMove(move.order, move.price))}>
            {t('Protection continue')}
          </button>
          <button type="button" onClick={() => setMove(null)} disabled={busy}>
            {t('Cancel')}
          </button>
        </div>
      )}
      {move?.stage === 'review' && (
        <div className="ct-review" role="dialog" aria-label={t('Review move')} data-testid="chart-move-review">
          <p>
            {t('Move line', {
              side: sideWord(move.order.side),
              amount: displayAmount(move.order.remaining),
              asset: market.baseAsset,
              from: displayAmount(move.order.price),
              to: displayAmount(move.price),
            })}
          </p>
          <p>{t('Move note')}</p>
          <p data-testid="chart-move-lock" data-lock={move.preview.lock.amount}>
            {t('Move lock', { lock: `${displayAmount(move.preview.lock.amount)} ${move.preview.lock.asset}` })}
          </p>
          <button type="button" onClick={confirmMove} disabled={busy || locked}>
            {t('Confirm')}
          </button>
          <button type="button" onClick={() => setMove(null)} disabled={busy}>
            {t('Cancel')}
          </button>
        </div>
      )}
      {note && (
        <p
          className={note.tone === 'good' ? 'dk-note dk-note--good' : 'dk-note dk-note--bad'}
          role="status"
          data-testid="chart-trading-note"
          data-tone={note.tone}
          data-code={note.code}
        >
          {note.text}
        </p>
      )}
    </div>
  );
}
