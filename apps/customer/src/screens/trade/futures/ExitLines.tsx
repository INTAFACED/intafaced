/**
 * A position's stop and target on the futures chart (J-derivatives-32), on the person's own venue account: each line sits
 * at the price the venue holds, read from the venue's open orders, and never at a price the venue refused.
 *
 * - Dragging the stop or the target line shows, at the pointer, the price snapped to the venue's tick, what closing the
 *   whole position there nets after the venue's fee and ours in and out, and the R it makes against the stop the position
 *   opened with. Nothing is sent while dragging.
 * - Letting go asks our door for the one action that moves that venue order in place (`/protections/move`); the person
 *   signs it and it is sent under `trigger-move:<owner>:<client id>:<price>`, the same on every retry. The line moves
 *   only once the venue's open orders hold it there; a refusal is shown in the venue's words and the line stays put.
 * - With no stop resting, the entry line drags out a new reduce-only stop for the whole position, on the venue's mark.
 * - Breakeven on the entry line moves the stop to the fee-adjusted breakeven (`useBreakeven`).
 *
 * The ledger posts nothing; every order is the person's own on the venue.
 */
import { useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { Button, ChartMark, ChartOverlay } from '@intafaced/ui/lit';
import { displayAmount } from '../../../shared/money';
import { useChartOverlay, useChartPricesInView } from '../../../shared/chart-overlay';
import { chartValue } from '../../../shared/chart-value';
import type { VenueMarket, VenueOrder, VenuePosition } from '../../../features/trade/venue-api';
import { outcomeText, useVenueApi } from '../../../features/trade/venue/VenueKit';
import { venueCopy } from '../../../features/trade/venue/venue-copy';
import type { ChartOrderHost } from '../../charts/chart-host';
import { snapToTick } from '../../charts/trading/chart-orders';
import { pricePane } from '../../charts/trading/ChartTrading';
import { exitOf, netAt, openingStop, rAt, samePrice, type FeeBasis } from './exit-figures';
import { exitLinesCopy } from './exit-lines-copy';
import { refusalOf, useExitSigner, useSignPrepared, type Refusal } from './VenueProtect';
import { closingSide, protectionClientId } from './venue-protect-logic';

type T = ReturnType<typeof exitLinesCopy.useCopy>['t'];
type LineKind = 'stop' | 'target' | 'entry';
type Drag = { kind: LineKind; y: number; from: number };
type Note = { tone: 'good' | 'bad'; text: string; code?: string | null };

/** Where the first label on a price starts, from the chart's inline start: the kit's own inset for a line's label. */
const LABEL_START_PX = 8;
/** The gap between two marks set side by side on one row. */
const LABEL_GAP_PX = 8;
/**
 * Two labels whose prices sit closer than this many pixels would cover each other (each is at least 24px tall, centred
 * on its price), so the later one is set after the earlier one on the same row instead of on top of it.
 */
const LABEL_NEAR_PX = 26;
/** A pointer that moves less than this many pixels between down and up is a press on the line, not a drag. */
const DRAG_MIN_PX = 4;
const NOTE_CLASS = { good: 'lt-note lt-note-good', bad: 'lt-note lt-note-bad' } as const;

const deviceStore = (): Storage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

/** A signed dollar figure: "+193.29 USDC", "−206.71 USDC"; "not known" without the venue's figures. */
function money(t: T, value: string | null, quote: string): string {
  if (value === null) return t('Not known');
  return `${value.startsWith('-') ? '' : '+'}${displayAmount(value, 2)} ${quote}`;
}

export interface ExitLinesProps {
  host: ChartOrderHost | null;
  market: VenueMarket;
  owner: string;
  position: VenuePosition | null;
  openOrders: readonly VenueOrder[];
  basis: FeeBasis | null;
  /** The venue moves a resting trigger order in place (status `movesTriggersInPlace`): only then do the lines drag. */
  movesInPlace: boolean;
  /** Breakeven for this position (`useBreakeven`), and whether one is running. */
  breakeven: (symbol: string) => void;
  breakevenBusy: boolean;
  /** After a move was sent: the desk reads the venue again. */
  onChanged: () => void;
}

export function ExitLines({
  host,
  market,
  owner,
  position,
  openOrders,
  basis,
  movesInPlace,
  breakeven,
  breakevenBusy,
  onChanged,
}: ExitLinesProps) {
  const { t } = exitLinesCopy.useCopy();
  const v = venueCopy.useCopy().t;
  const venue = useVenueApi();
  const sign = useSignPrepared(owner);
  const exitSigner = useExitSigner(owner);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const counter = useRef(0);
  // Each drawn mark's size, measured, so a label near another price is set beside it, never over its figures.
  const [sizes, setSizes] = useState<Partial<Record<'stop' | 'target' | 'entry' | 'actions', { w: number; h: number }>>>({});
  const measure = (key: 'stop' | 'target' | 'entry' | 'actions') => (el: HTMLElement | null) => {
    if (!el || typeof ResizeObserver === 'undefined') return;
    const read = () => {
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      setSizes((was) => (was[key]?.w === w && was[key]?.h === h ? was : { ...was, [key]: { w, h } }));
    };
    read();
    const watch = new ResizeObserver(read);
    watch.observe(el);
    return () => watch.disconnect();
  };
  // The overlay follows the chart: a redraw on a pan, a zoom, a resize and while the price scale moves.
  useChartOverlay(host, { onCrosshair: () => undefined, onContextMenu: () => undefined });

  const stop = position ? exitOf(position, openOrders, 'stop_loss') : null;
  const target = position ? exitOf(position, openOrders, 'take_profit') : null;
  const opened = position ? openingStop(owner, position, stop?.trigger?.price ?? null, deviceStore()) : null;
  const riskNet = position && opened ? netAt(position, opened, basis ?? { ok: false, missing: 'fees' }) : null;
  const figures = (price: string) => {
    const net = position && basis ? netAt(position, price, basis) : null;
    return { net, r: rAt(net, riskNet) };
  };

  // The entry, stop, target and liquidation price stay on the chart however far they sit from the bars, so each line can
  // be read and dragged, and a new stop can be dragged out anywhere between the entry and liquidation.
  const liquidation = position?.liquidationPrice.known ? position.liquidationPrice.value : null;
  const inView: string[] = [];
  for (const price of [position?.entryPrice, stop?.trigger?.price, target?.trigger?.price, liquidation]) {
    if (price) inView.push(price);
  }
  useChartPricesInView(host, inView.map(chartValue), inView.join(','));

  if (!host || !position) return null;
  const pane = pricePane(host);
  const stage = host.element.parentElement;
  const yOf = (price: string | null | undefined) => {
    const y = price ? host.main.priceToCoordinate(chartValue(price)) : null;
    return y === null ? null : pane.top + y;
  };
  const priceAt = (y: number) => {
    const at = host.main.coordinateToPrice(y - pane.top);
    return at === null ? null : snapToTick(at, market.tickSize);
  };

  const work = async (fn: () => Promise<void>) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    try {
      await fn();
    } catch {
      // A call that failed outright (no answer at all) still ends in words: the venue's own list is what counts.
      setNote({ tone: 'bad', text: t('No answer'), code: null });
    } finally {
      working.current = false;
      setBusy(false);
      onChanged();
    }
  };

  /** A refusal in words, or the venue's own; null when the action was taken. */
  const answered = (refusal: Refusal | null, good: string) =>
    setNote(refusal ? { tone: 'bad', text: refusal.message, code: refusal.code } : { tone: 'good', text: good });

  /** A stop or target line let go at `to`: the one move, signed and sent; the line follows the venue's answer. */
  const move = (order: VenueOrder, kind: 'stop' | 'target', to: string) =>
    void work(async () => {
      const chosen = exitSigner();
      if ('refusal' in chosen) return setNote({ tone: 'bad', text: chosen.refusal.message, code: chosen.refusal.code });
      const asked = await venue.moveTrigger({
        owner,
        symbol: market.symbol,
        venueClientOrderId: order.venueClientOrderId!,
        triggerPrice: to,
        signer: chosen.signer,
      });
      if (!asked.ok) return setNote({ tone: 'bad', text: t('Not moved', { detail: asked.message }), code: asked.code ?? null });
      const result = await sign(asked.data);
      const refused = refusalOf(result, (r) => outcomeText(v, r));
      answered(
        refused ? { ...refused, message: t('Venue refused move', { detail: refused.message }) } : null,
        t(kind === 'stop' ? 'Stop moved' : 'Target moved', { price: displayAmount(to) }),
      );
    });

  /** The entry line dragged out with no stop resting: a new reduce-only stop for the whole position at `at`. */
  const newStop = (at: string) =>
    void work(async () => {
      const chosen = exitSigner();
      if ('refusal' in chosen) return setNote({ tone: 'bad', text: chosen.refusal.message, code: chosen.refusal.code });
      const created = await venue.createProtection({
        owner,
        symbol: market.symbol,
        kind: 'stop_loss',
        side: closingSide(position.side),
        quantity: position.size,
        triggerPrice: at,
        triggerSource: 'mark',
        clientOrderId: protectionClientId(Date.now(), counter.current++),
        signer: chosen.signer,
      });
      if (!created.ok) return setNote({ tone: 'bad', text: t('Not moved', { detail: created.message }), code: created.code ?? null });
      if (created.data.restsOn !== 'venue') return setNote({ tone: 'bad', text: t('Stop not on venue') });
      const result = await sign(created.data);
      answered(
        refusalOf(result, (r) => outcomeText(v, r)),
        t('Stop placed', { price: displayAmount(at) }),
      );
    });

  const onDown = (event: ReactPointerEvent<HTMLElement>, kind: LineKind) => {
    if (busy) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const y = event.clientY - host.element.getBoundingClientRect().top;
    setNote(null);
    setDrag({ kind, y, from: y });
  };
  const onMove = (event: ReactPointerEvent<HTMLElement>) => {
    if (!drag) return;
    setDrag({ ...drag, y: event.clientY - host.element.getBoundingClientRect().top });
  };
  const onUp = (event: ReactPointerEvent<HTMLElement>) => {
    if (!drag) return;
    const y = event.clientY - host.element.getBoundingClientRect().top;
    const { kind, from } = drag;
    setDrag(null);
    if (Math.abs(y - from) < DRAG_MIN_PX) return; // a press on the line moves nothing
    const to = priceAt(y);
    if (!to) return;
    if (kind === 'stop' && stop && !samePrice(to, stop.trigger?.price)) move(stop, 'stop', to);
    if (kind === 'target' && target && !samePrice(to, target.trigger?.price)) move(target, 'target', to);
    if (kind === 'entry' && !stop) newStop(to);
  };
  const onCancel = () => setDrag(null);

  const dragged = drag ? priceAt(drag.y) : null;
  const handlers = (kind: LineKind) => ({
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => onDown(event, kind),
    onPointerMove: onMove,
    onPointerUp: onUp,
    onPointerCancel: onCancel,
    onLostPointerCapture: onCancel,
  });

  /** One exit line's handle: at the venue's price, or at the pointer while dragged, with its figures there. */
  const exitLine = (kind: 'stop' | 'target', order: VenueOrder | null, x: number) => {
    const held = order?.trigger?.price ?? null;
    if (!held) return null;
    const moving = drag?.kind === kind;
    const at = moving && dragged ? dragged : held;
    const y = moving ? drag.y : yOf(held);
    if (y === null) return null;
    const f = figures(at);
    const words = t(kind === 'stop' ? 'Stop line' : 'Target line', {
      price: displayAmount(at),
      result: money(t, f.net, market.quoteAsset),
      r: f.r === null ? t('R not known') : t('R value', { r: f.r }),
    });
    return (
      <ChartMark
        key={kind}
        as="button"
        kind="line"
        y={y}
        x={x}
        ref={measure(kind)}
        data-testid={`exit-line-${kind}`}
        data-side={kind === 'stop' ? 'sell' : 'buy'}
        data-held={held}
        data-price={at}
        data-net={f.net ?? ''}
        data-r={f.r ?? ''}
        data-dragging={moving ? 'true' : 'false'}
        disabled={busy || !movesInPlace}
        aria-label={t(kind === 'stop' ? 'Stop handle' : 'Target handle', { symbol: market.symbol, price: displayAmount(held) })}
        {...(movesInPlace ? handlers(kind) : {})}
      >
        {words}
        {moving ? ` · ${t('Not sent')}` : ''}
      </ChartMark>
    );
  };

  const entryY = drag?.kind === 'entry' ? drag.y : yOf(position.entryPrice);
  const entryFigures = drag?.kind === 'entry' && dragged ? figures(dragged) : null;
  // The labels' row positions: the stop first at the kit's inset, then the target, then the entry, each set after any
  // earlier label whose price sits within LABEL_NEAR_PX of its own; Breakeven sits on the entry's row, after its label.
  const lineY = (kind: 'stop' | 'target', order: VenueOrder | null) => {
    const held = order?.trigger?.price ?? null;
    if (!held) return null;
    return drag?.kind === kind ? drag.y : yOf(held);
  };
  const placed: { y: number; end: number }[] = [];
  const place = (key: 'stop' | 'target' | 'entry', y: number | null) => {
    if (y === null) return LABEL_START_PX;
    const x = placed.reduce((at, p) => (Math.abs(p.y - y) < LABEL_NEAR_PX ? Math.max(at, p.end + LABEL_GAP_PX) : at), LABEL_START_PX);
    placed.push({ y, end: x + (sizes[key]?.w ?? 0) });
    return x;
  };
  const stopX = place('stop', lineY('stop', stop));
  const targetX = place('target', lineY('target', target));
  const entryX = place('entry', entryY);
  const actionsX = entryX + (sizes.entry?.w ?? 0) + LABEL_GAP_PX;
  // The lines are drawn only once the chart reads a price back from a pixel (it has its bars): before then a line could
  // be pressed but never dropped at a price.
  const edges = { top: priceAt(pane.top), bottom: priceAt(pane.top + pane.height) };
  const overlay =
    stage && pane.height > 0 && edges.top && edges.bottom
      ? createPortal(
          <ChartOverlay
            data-testid="exit-lines-overlay"
            data-pane-top={pane.top}
            data-pane-height={pane.height}
            // The prices at the price pane's top and bottom edges: the chart's own scale, for a reader of the overlay.
            data-price-top={edges.top}
            data-price-bottom={edges.bottom}
          >
            {exitLine('stop', stop, stopX)}
            {exitLine('target', target, targetX)}
            {entryY !== null && (
              <ChartMark
                as="button"
                kind="line"
                y={entryY}
                x={entryX}
                ref={measure('entry')}
                data-testid="exit-line-entry"
                data-price={drag?.kind === 'entry' && dragged ? dragged : position.entryPrice}
                data-net={entryFigures?.net ?? ''}
                data-dragging={drag?.kind === 'entry' ? 'true' : 'false'}
                disabled={busy || !!stop}
                aria-label={t(stop ? 'Entry handle' : 'Entry handle drag', {
                  symbol: market.symbol,
                  price: displayAmount(position.entryPrice),
                })}
                {...(stop ? {} : handlers('entry'))}
              >
                {drag?.kind === 'entry' && dragged
                  ? `${t('New stop line', { price: displayAmount(dragged), result: money(t, entryFigures?.net ?? null, market.quoteAsset) })} · ${t('Not sent')}`
                  : t('Entry line', { price: displayAmount(position.entryPrice) })}
              </ChartMark>
            )}
            {entryY !== null && drag === null && (
              <ChartMark
                kind="menu"
                // The menu hangs from its top: half its height above the line centres it on the entry's row.
                y={entryY - (sizes.actions?.h ?? 0) / 2}
                x={actionsX}
                ref={measure('actions')}
                data-testid="exit-line-entry-actions"
              >
                <Button
                  tone="secondary"
                  size="sm"
                  disabled={busy || breakevenBusy}
                  aria-label={t('Breakeven on chart', { symbol: market.symbol })}
                  onClick={() => breakeven(market.symbol)}
                >
                  {t('Breakeven')}
                </Button>
              </ChartMark>
            )}
          </ChartOverlay>,
          stage,
        )
      : null;

  return (
    <div className="lt-stack-tight lt-tight" data-testid="exit-lines">
      {overlay}
      {!movesInPlace && (stop || target) ? (
        <p className="lt-note" role="status" data-testid="exit-lines-fixed">
          {t('Lines fixed')}
        </p>
      ) : null}
      {note && (
        <p
          className={NOTE_CLASS[note.tone]}
          role="status"
          data-testid="exit-lines-note"
          data-tone={note.tone}
          data-code={note.code ?? undefined}
        >
          {note.text}
        </p>
      )}
    </div>
  );
}
