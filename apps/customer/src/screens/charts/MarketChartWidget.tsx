import { memo, useCallback, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { usePreferences } from '../../shared/preferences';
import { CHART_INTERVALS, MORE_INTERVALS, useChartCandles, type ChartInterval } from '../trade/chart/candles';
import { zoneName } from '../trade/desk/time';
import type { DeskMarket } from '../trade/desk/market';
import type { ChartHost } from './chart-host';
import {
  BASIS_UNPUBLISHED,
  CHART_STYLES,
  COLOUR_SCHEMES,
  PRICE_BASES,
  PUBLISHED_BASES,
  type ColourScheme,
  type PriceBasis,
} from './chart-style';
import { chartsCopy } from './copy';
import { Menu, MenuContent, MenuItem, MenuTrigger, refusalCopy, Skeleton, StateBlock } from './deps';
import { HISTORY_DEPTH, locateDate, useChartHistory, withHistory } from './history';
import { isStreamInterval, mergeLive, useCandleStream, type OpenSocket } from './live-candles';
import { intervalLabel, type ChartMode } from './workbench';
import { WorkbenchChart } from './WorkbenchChart';
import { useNow } from '../trade/desk/hooks';

export interface WidgetProps {
  market: DeskMarket;
  interval: ChartInterval;
  mode: ChartMode;
  onInterval: (interval: ChartInterval) => void;
  onMode: (mode: ChartMode) => void;
  scheme?: ColourScheme;
  onScheme?: (scheme: ColourScheme) => void;
  /** Tests hand in a socket; the page uses the browser's. */
  openSocket?: OpenSocket;
  /** Add-ons drawn on the chart (studies, drawings). */
  addons?: (host: ChartHost | null) => ReactNode;
}

const STYLE_LABEL = {
  candles: 'Candles',
  bars: 'Bars',
  line: 'Line',
  area: 'Area',
  columns: 'Columns',
  'heikin-ashi': 'Heikin Ashi',
} as const;
const SCHEME_LABEL = { standard: 'Scheme standard', inverted: 'Scheme inverted', mono: 'Scheme mono' } as const;
const BASIS_LABEL = { last: 'Basis last', bid: 'Basis bid', mark: 'Basis mark' } as const;

/**
 * The market chart widget: the polled history with the live bar laid over it, the interval and style controls,
 * and one line that says which way the chart is being fed. It holds no state of its own: the workbench does.
 */
export const MarketChartWidget = memo(function MarketChartWidget({
  market,
  interval,
  mode,
  onInterval,
  onMode,
  scheme = 'standard',
  onScheme,
  openSocket,
  addons,
}: WidgetProps) {
  const { t } = chartsCopy.useCopy();
  const { timeZone, language } = usePreferences();
  const polled = useChartCandles(market.symbol, interval);
  const stream = useCandleStream(market.symbol, interval, openSocket);
  const now = useNow(2_000);
  const recent = useMemo(
    () => (polled.status === 'ready' ? mergeLive(polled.data, stream.mode === 'stream' ? stream.live : null) : null),
    [polled, stream],
  );
  const history = useChartHistory(market.symbol, interval, recent?.[0]?.t ?? null);
  const candles = useMemo(
    () => (recent ? withHistory(recent, history.state.status === 'loaded' ? history.state.bars : []) : null),
    [recent, history.state],
  );
  const [basisRefused, setBasisRefused] = useState<PriceBasis | null>(null);
  const [focus, setFocus] = useState<{ index: number; nonce: number } | null>(null);
  const [dateNote, setDateNote] = useState<string | null>(null);
  const day = useCallback(
    (ms: number) =>
      new Intl.DateTimeFormat(language === 'en' ? 'en-GB' : language, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
        ...(zoneName(timeZone) ? { timeZone: zoneName(timeZone) } : {}),
      }).format(ms),
    [language, timeZone],
  );
  const labels = useMemo(
    () => ({
      open: t('O'),
      high: t('H'),
      low: t('L'),
      close: t('C'),
      change: t('Change'),
      chart: t('Chart of {pair}', { pair: market.symbol }),
      keys: t('Chart keys'),
    }),
    [t, market.symbol],
  );

  const goToDate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const raw = new FormData(event.currentTarget).get('date');
    // A `datetime-local` value is the person's own clock time.
    const target = typeof raw === 'string' && raw !== '' ? new Date(raw).getTime() : NaN;
    if (!Number.isFinite(target) || !recent) return;
    const loaded = await history.load();
    const older = loaded.status === 'loaded' ? loaded.bars : [];
    const bars = withHistory(recent, older);
    const reachedStart = loaded.status === 'loaded' && loaded.reachedStart;
    const spot = locateDate(bars, target, reachedStart, history.oldestReachable, Date.now());
    if (spot.kind === 'show') {
      setDateNote(null);
      setFocus({ index: spot.index, nonce: Date.now() });
    } else if (spot.kind === 'before-start') {
      setDateNote(t('Date before start', { earliest: day(spot.earliest) }));
      setFocus({ index: 0, nonce: Date.now() });
    } else if (spot.kind === 'beyond-depth') {
      setDateNote(t('Date beyond depth', { depth: String(HISTORY_DEPTH), oldest: day(spot.oldestReachable) }));
    } else setDateNote(t('Date in future'));
  };

  let body: React.ReactNode;
  if (polled.status === 'loading') body = <Skeleton className="cw-skeleton bg-field" />;
  else if (polled.status === 'empty') body = <StateBlock kind="empty" title={t('No trades in this period')} />;
  else if (polled.status === 'error')
    body = <StateBlock kind="error" title={t('Couldn’t load the chart')} onRetry={polled.retry} retryLabel={t('Try again')} />;
  else if (polled.status === 'refused') {
    const words = refusalCopy(polled.code);
    body = <StateBlock kind="refused" title={words.title} body={words.body} action={words.action} />;
  } else
    body = (
      <WorkbenchChart
        candles={candles ?? polled.data}
        style={mode}
        scheme={scheme}
        resetKey={`${market.symbol}:${interval}`}
        symbol={market.symbol}
        tickSize={market.tickSize}
        timeZone={zoneName(timeZone)}
        labels={labels}
        onReachStart={() => void history.load()}
        focus={focus}
      >
        {addons}
      </WorkbenchChart>
    );

  const moreActive = (MORE_INTERVALS as readonly string[]).includes(interval);
  const note = stream.mode === 'stream' ? t('Feed stream') : isStreamInterval(interval) ? t('Feed poll') : t('Feed poll interval');
  const seconds = polled.status === 'ready' ? Math.max(0, Math.round((now - polled.asOf) / 1000)) : null;
  const depth =
    candles && history.state.status === 'loaded'
      ? history.state.reachedStart
        ? t('Depth all', { bars: String(candles.length), from: day(candles[0]!.t) })
        : t('Depth capped', { bars: String(candles.length), from: day(candles[0]!.t), depth: String(HISTORY_DEPTH) })
      : history.state.status === 'loading'
        ? t('Depth loading')
        : history.state.status === 'error'
          ? t('Depth error')
          : candles
            ? t('Depth recent', { bars: String(candles.length) })
            : null;
  return (
    <section className="cw" aria-label={t('Chart of {pair}', { pair: market.symbol })} data-feed={stream.mode}>
      <h2 className="cw-title" data-testid="chart-title">
        {market.symbol} · {intervalLabel(interval)}
      </h2>
      <div className="cw-bar">
        <div className="cw-chips" role="group" aria-label={t('Chart intervals')}>
          {CHART_INTERVALS.map((id) => (
            <button key={id} type="button" aria-pressed={interval === id} onClick={() => onInterval(id)}>
              {intervalLabel(id)}
            </button>
          ))}
          <Menu>
            <MenuTrigger className="cw-more" data-active={moreActive || undefined}>
              {moreActive ? intervalLabel(interval) : t('More intervals')}
              <span aria-hidden="true"> ▾</span>
            </MenuTrigger>
            <MenuContent align="start">
              {MORE_INTERVALS.map((id) => (
                <MenuItem key={id} onClick={() => onInterval(id)}>
                  {intervalLabel(id)}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
        </div>
        <div className="cw-chips" role="group" aria-label={t('Chart style')}>
          {CHART_STYLES.map((id) => (
            <button key={id} type="button" aria-pressed={mode === id} onClick={() => onMode(id)}>
              {t(STYLE_LABEL[id])}
            </button>
          ))}
        </div>
      </div>
      <div className="cw-bar cw-bar--options">
        {onScheme && (
          <label className="cw-select cw-select--inline">
            <span>{t('Colours')}</span>
            <select value={scheme} onChange={(event) => onScheme(event.target.value as ColourScheme)}>
              {COLOUR_SCHEMES.map((id) => (
                <option key={id} value={id}>
                  {t(SCHEME_LABEL[id])}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="cw-select cw-select--inline">
          <span>{t('Price source')}</span>
          <select
            value="last"
            onChange={(event) => {
              const basis = event.target.value as PriceBasis;
              setBasisRefused(PUBLISHED_BASES.includes(basis) ? null : basis);
            }}
          >
            {PRICE_BASES.map((id) => (
              <option key={id} value={id}>
                {t(BASIS_LABEL[id])}
              </option>
            ))}
          </select>
        </label>
        <form className="cw-date" onSubmit={(event) => void goToDate(event)}>
          <label className="cw-select cw-select--inline">
            <span>{t('Go to date')}</span>
            <input type="datetime-local" name="date" required />
          </label>
          <button type="submit">{t('Go')}</button>
        </form>
      </div>
      {basisRefused && (
        <p className="cw-note" role="status" data-code={BASIS_UNPUBLISHED}>
          {t('Basis refused', { basis: t(BASIS_LABEL[basisRefused]) })}
        </p>
      )}
      {dateNote && (
        <p className="cw-note" role="status" data-testid="chart-date-note">
          {dateNote}
        </p>
      )}
      <div className="cw-canvas">{body}</div>
      <p className="cw-feed" data-testid="chart-feed">
        {note}
        {stream.mode === 'poll' && seconds !== null && <> {t('Feed age', { seconds: String(seconds) })}</>}
      </p>
      {depth && (
        <p className="cw-feed" data-testid="chart-depth">
          {depth}
        </p>
      )}
    </section>
  );
});
