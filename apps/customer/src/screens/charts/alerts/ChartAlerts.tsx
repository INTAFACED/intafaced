/**
 * Price alerts on the chart (J-charts-desk-09 #5, C-alerts-scan-02).
 *
 * - Each open price alert the person holds on this market (active or stopped) is drawn as a dotted level on the chart's
 *   own canvas, with a handle on the overlay naming its condition and exact price. The same alerts are listed under the
 *   chart, so one whose level is outside the visible range is still read.
 * - Dragging a handle to a new price sends ONE edit of that alert (`notify.updateAlert`) at the price where it is dropped,
 *   snapped to the market's tick. The edit sets a value, so a retry after a lost answer changes nothing more. The line then
 *   shows what the service answered, never the pointer's guess. A click, a drop on the same price, a drop while another
 *   edit is on its way and a drop during a bar replay send nothing.
 * - Alerts are created and managed on the alerts page; the chart shows their levels and moves them, nothing else.
 */
import { useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { useSession } from '../../../features/session/session';
import type { DeskMarket } from '../../trade/desk/market';
import { updatePriceAlert, type AlertCondition, type PriceAlert } from '../../notifications/notify-api';
import { useAlertMarkets, useAlerts } from '../../notifications/use-alerts';
import type { ChartHost } from '../chart-host';
import { chartsCopy } from '../copy';
import { samePrice, snapToTick } from '../trading/chart-orders';
import { pricePane } from '../trading/ChartTrading';
import { alertsOnMarket, ALERTS_PAGE } from './chart-alerts';

type Note = { tone: 'good' | 'bad'; text: string };

/** Answers that do not say whether the edit was stored: the person is told to look, never that nothing changed. */
const UNSURE: ReadonlySet<string> = new Set(['uncertain', 'unreachable', 'invalid_response', 'aborted']);

/** A pointer that moves less than this many pixels between down and up is a click on the line, not a drag. */
const DRAG_MIN_PX = 4;

const CONDITION_KEY = {
  crossing: 'Chart alert crossing',
  crossing_up: 'Chart alert crossing up',
  crossing_down: 'Chart alert crossing down',
  greater_than: 'Chart alert above',
  less_than: 'Chart alert below',
} as const satisfies Record<AlertCondition, string>;

export function ChartAlerts({ host, market, replaying = false }: { host: ChartHost | null; market: DeskMarket; replaying?: boolean }) {
  const { t } = chartsCopy.useCopy();
  const { api, userId } = useSession();
  const alerts = useAlerts();
  const markets = useAlertMarkets();
  const [drag, setDrag] = useState<{ id: string; y: number; from: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const [, setFrame] = useState(0);
  const signedIn = userId !== null;

  const shown = useMemo(
    () =>
      alerts.state.status === 'ready' && markets.status === 'ready'
        ? alertsOnMarket(alerts.state.items, markets.markets, market.symbol, userId)
        : [],
    [alerts.state, markets, market.symbol, userId],
  );
  const words = (alert: PriceAlert) =>
    t('Chart alert level', {
      condition: t(CONDITION_KEY[alert.condition ?? 'greater_than']),
      price: alert.targetPrice,
      quote: market.quote,
    });

  // The handles follow the chart: redrawn on a pan, a zoom, a resize and while the price scale moves with new bars.
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
    host.chart.timeScale().subscribeVisibleLogicalRangeChange(redraw);
    const resize = new ResizeObserver(redraw);
    resize.observe(host.element);
    const timer = window.setInterval(redraw, 1000);
    return () => {
      host.chart.timeScale().unsubscribeVisibleLogicalRangeChange(redraw);
      resize.disconnect();
      window.clearInterval(timer);
    };
  }, [host, signedIn]);

  // The levels on the library's own canvas, dotted, so they read apart from orders (solid) and the order preview (dashed).
  const lineKey = shown.map((alert) => `${alert.id}:${alert.targetPrice}:${alert.status}`).join(',');
  useEffect(() => {
    if (!host) return;
    const colour = getComputedStyle(document.documentElement).getPropertyValue('--if-fg').trim();
    const lines = shown.map((alert) =>
      host.main.createPriceLine({
        price: Number(alert.targetPrice),
        color: colour,
        lineWidth: 1,
        lineStyle: 1,
        axisLabelVisible: true,
        title: t('Chart alert title'),
      }),
    );
    return () => {
      for (const line of lines) host.main.removePriceLine(line);
    };
    // The key carries every value the lines draw.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [host, lineKey]);

  /** A dropped handle: one edit at the snapped price. Nothing is sent for the same price or while another edit is out. */
  const dropped = async (alert: PriceAlert, y: number) => {
    if (!host || !userId || busy || replaying) return;
    const at = host.main.coordinateToPrice(y - pricePane(host).top);
    const to = at === null ? null : snapToTick(at, market.tickSize);
    if (!to || samePrice(to, alert.targetPrice)) return;
    setBusy(true);
    setNote(null);
    try {
      const result = await updatePriceAlert(api, alert.id, { targetPrice: to }, userId);
      if (result.ok) setNote({ tone: 'good', text: t('Chart alert moved', { price: result.data.alert.targetPrice, quote: market.quote }) });
      else setNote({ tone: 'bad', text: UNSURE.has(result.reason) ? t('Chart alert move unsure') : t('Chart alert not moved') });
    } finally {
      setBusy(false);
      // Read again either way: the line shows what the service holds, never the pointer's guess.
      alerts.reload();
    }
  };

  const onDown = (event: ReactPointerEvent<HTMLButtonElement>, alert: PriceAlert) => {
    if (busy || replaying || !host) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const top = host.element.getBoundingClientRect().top;
    setDrag({ id: alert.id, y: event.clientY - top, from: event.clientY - top });
  };
  const onMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (!drag || !host) return;
    setDrag({ ...drag, y: event.clientY - host.element.getBoundingClientRect().top });
  };
  const onUp = (event: ReactPointerEvent<HTMLButtonElement>, alert: PriceAlert) => {
    if (!drag || !host) return;
    const y = event.clientY - host.element.getBoundingClientRect().top;
    const from = drag.from;
    setDrag(null);
    if (Math.abs(y - from) < DRAG_MIN_PX) return; // a click on the line moves nothing
    void dropped(alert, y);
  };
  const onCancel = () => setDrag(null);

  // Nothing at all without an alert here: the chart reads exactly as it did before alerts were drawn on it.
  if (!signedIn || shown.length === 0) return null;
  const stage = host?.element.parentElement ?? null;
  const paneTop = host ? pricePane(host).top : 0;
  const paneHeight = host ? pricePane(host).height : 0;
  const yOf = (price: string) => {
    const y = host ? host.main.priceToCoordinate(Number(price)) : null;
    return y === null || y < 0 || y > paneHeight ? null : paneTop + y;
  };

  const overlay =
    stage && host
      ? createPortal(
          <div className="ct-overlay" data-testid="chart-alerts-overlay">
            {shown.map((alert) => {
              const y = drag?.id === alert.id ? drag.y : yOf(alert.targetPrice);
              if (y === null) return null;
              return (
                <button
                  key={alert.id}
                  type="button"
                  className="ct-line ct-line--alert"
                  data-testid="chart-alert-line"
                  data-alert-id={alert.id}
                  data-price={alert.targetPrice}
                  data-status={alert.status}
                  disabled={busy || replaying}
                  aria-label={t('Chart alert handle', { level: words(alert) })}
                  style={{ insetBlockStart: `${y}px` }}
                  onPointerDown={(event) => onDown(event, alert)}
                  onPointerMove={onMove}
                  onPointerUp={(event) => onUp(event, alert)}
                  onPointerCancel={onCancel}
                  onLostPointerCapture={onCancel}
                >
                  {words(alert)}
                </button>
              );
            })}
          </div>,
          stage,
        )
      : null;

  return (
    <div className="ct-bar" data-testid="chart-alerts">
      {overlay}
      <ul className="ct-alerts" aria-label={t('Chart alerts list')}>
        {shown.map((alert) => (
          <li key={alert.id} data-testid="chart-alert-row" data-price={alert.targetPrice} data-status={alert.status}>
            {words(alert)}
            {alert.status === 'stopped' ? ` · ${t('Chart alert stopped')}` : ''}
          </li>
        ))}
      </ul>
      {replaying ? (
        <p className="cw-note" role="status" data-testid="chart-alerts-replay">
          {t('Chart alerts replay')}
        </p>
      ) : null}
      <a className="cw-link" href={ALERTS_PAGE}>
        {t('Chart alerts manage')}
      </a>
      {note ? (
        <p className="cw-note" role="status" data-testid="chart-alerts-note" data-tone={note.tone}>
          {note.text}
        </p>
      ) : null}
    </div>
  );
}
