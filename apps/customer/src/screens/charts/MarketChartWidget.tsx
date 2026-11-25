import { memo, useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { usePreferences } from '../../shared/preferences';
import type { Candle } from '../../data/types';
import { CANDLE_POLL_MS, CHART_INTERVALS, MORE_INTERVALS, useChartCandles, type ChartInterval } from '../trade/chart/candles';
import { useChartSource } from '../trade/chart/chart-source';
import { useDeviceSetting } from '../../features/trade/hooks';
import { useSession } from '../../features/session/session';
import { dataStatus as computeStatus, tradeRefusal } from './data-status';
import { rememberLastTrade, useBookHalt, useLastTrade, useMarketLifecycle, useServerClock } from './market-state';
import { ownerValue, useChartOwnerCounts, useChartOwnerValues } from './owner-values';
import { venueStatusInputs } from './venue-charts';
import { refusalText, StatusBanner, StatusChip, SourceLine, TestLabel } from './DataStatus';
import { ChartSettingsDialog } from './ChartSettings';
import { chartSettingsKey, isStoredChartSettings, readChartSettings, type ChartSettings } from './chart-settings';
import { PriceLines } from './PriceLines';
import { isPriceLineStore, linesFor, priceLinesKey, type PriceLine, type PriceLineStore } from './price-lines';
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
import { Button, Menu, StateBlock } from '@intafaced/ui/lit';
import { Skeleton } from '@intafaced/ui/lit/templates';
import { refusalCopy } from './deps';
import { HISTORY_DEPTH, locateDate, useChartHistory, withHistory } from './history';
import { REPLAY_SPEEDS, replayBars, replayStart, useReplay, type ReplayRefusal, type ReplaySpeed } from './replay';
import { isStreamInterval, mergeLive, useCandleStream, type OpenSocket } from './live-candles';
import { intervalLabel, type ChartMode } from './workbench';
import { WorkbenchChart } from './WorkbenchChart';
import { ChartTrading } from './trading/ChartTrading';
import { ChartAlerts } from './alerts/ChartAlerts';
import { CompareTools } from './CompareTools';
import { useNow } from '../trade/desk/hooks';
import { DateInput } from '@intafaced/ui/lit';

/** The chart's tools start open, except on a phone-width screen or in a multi-chart grid, where the chart comes first. */
function toolsOpenAtFirst(compact = false): boolean {
  if (compact) return false;
  return typeof window === 'undefined' || typeof window.matchMedia !== 'function' || !window.matchMedia('(max-width: 760px)').matches;
}

/** What an add-on is drawn over: the price scale or percent mode, and whether a bar replay is cut. */
export interface AddonView {
  percent: boolean;
  replaying: boolean;
  /** The main chart only: hands the object tree's indicator slot to the studies bar, which lists its studies there. */
  onTreeSlot?: (slot: HTMLElement | null) => void;
}

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
  addons?: (host: ChartHost | null, bars: readonly Candle[], view: AddonView) => ReactNode;
  /** Add-ons shown under the empty state of a market with no trades (the studies bar, whose studies say what they lack). */
  emptyAddons?: () => ReactNode;
  onHost?: (host: ChartHost | null) => void;
  /** The markets that can be compared on this chart; no compare tools without them. */
  markets?: readonly DeskMarket[];
  /** A command from the workbench's keys (open the replay panel), new each time by its nonce. */
  command?: { kind: 'replay'; nonce: number } | null;
  /** In a multi-chart grid each cell is narrow, so the chart's tools start folded and the plot sits above the fold. */
  compact?: boolean;
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
  emptyAddons,
  onHost,
  command,
  markets,
  compact = false,
}: WidgetProps) {
  const { t } = chartsCopy.useCopy();
  const { timeZone, language } = usePreferences();
  const { userId } = useSession();
  const source = useChartSource();
  const venue = source.kind === 'venue' ? source : null;
  const polled = useChartCandles(market.symbol, interval);
  const stream = useCandleStream(market.symbol, interval, openSocket, venue === null);
  const now = useNow(2_000);
  // The data status: the market's state, its newest trade and the owner's class and boundary, judged against the candles.
  const engineLifecycle = useMarketLifecycle(market.symbol, venue === null);
  const engineBookHalt = useBookHalt(market.symbol, venue === null);
  const serverClock = useServerClock();
  const engineLastTrade = useLastTrade(market.symbol, venue === null);
  const venueState = venue ? venueStatusInputs(venue, market.symbol, polled, now) : null;
  const lifecycle = venueState ? venueState.lifecycle : engineLifecycle;
  const bookHalt = venueState ? venueState.bookHalt : engineBookHalt;
  const lastTrade = venueState ? venueState.lastTrade : engineLastTrade;
  // The newest trade this tab has read for the market, kept once the tape stops answering, so a down feed names its last
  // tick even on a chart opened during the outage. Module memory, not state: keeping it never causes a render of its own.
  const lastTradeSeenMs = rememberLastTrade(market.symbol, lastTrade);
  const engineOwner = useChartOwnerValues(market.symbol, venue === null);
  const venueOwner = useChartOwnerCounts(venue !== null);
  const owner = venue !== null ? venueOwner : engineOwner;
  // Order entry on the chart: the same one rule as the status chip and the trade link (C-ops-02).
  const orderRefusal = refusalText(tradeRefusal(lifecycle, bookHalt, now), t);
  const protectionRead = ownerValue(owner, 'orderProtectionBps');
  const protection = protectionRead.ok ? protectionRead.value : null;
  const status = computeStatus({
    now,
    serverClock,
    owner,
    lifecycle,
    bookHalt,
    candles: polled,
    lastTrade,
    lastTradeSeenMs,
    pollIntervalMs: CANDLE_POLL_MS,
  });
  // Settings and price lines are this device's own display choices.
  const [storedSettings, setStoredSettings] = useDeviceSetting<ChartSettings>(
    chartSettingsKey(userId),
    readChartSettings(null),
    isStoredChartSettings,
  );
  const settings = readChartSettings(storedSettings);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [priceLineOpen, setPriceLineOpen] = useState(false);
  const [storedLines, setStoredLines] = useDeviceSetting<PriceLineStore>(priceLinesKey(userId), {}, isPriceLineStore);
  const lines = linesFor(storedLines, market.symbol);
  const setLines = (next: PriceLine[]) => setStoredLines((store) => ({ ...store, [market.symbol]: next }));
  const recent = useMemo(
    () => (polled.status === 'ready' ? mergeLive(polled.data, stream.mode === 'stream' ? stream.live : null) : null),
    [polled, stream],
  );
  const history = useChartHistory(market.symbol, interval, recent?.[0]?.t ?? null);
  const candles = useMemo(
    () => (recent ? withHistory(recent, history.state.status === 'loaded' ? history.state.bars : []) : null),
    [recent, history.state],
  );
  const [host, setHost] = useState<ChartHost | null>(null);
  const reportHost = useCallback(
    (next: ChartHost | null) => {
      setHost(next);
      onHost?.(next);
    },
    [onHost],
  );
  const all = candles ?? (polled.status === 'ready' ? polled.data : []);
  const replay = useReplay();
  // The bars the chart draws: the loaded bars, or a replay's frozen copy up to its cut. Export reads this same array.
  const drawnBars = replayBars(all, replay.replay);
  const [percent, setPercent] = useState(false);
  const [replayOpen, setReplayOpen] = useState(false);
  const [toolsState, setToolsState] = useState(() => ({ compact, open: toolsOpenAtFirst(compact) }));
  const toolsOpen = toolsState.compact === compact ? toolsState.open : toolsOpenAtFirst(compact);
  const [replayNote, setReplayNote] = useState<string | null>(null);
  useEffect(() => {
    if (command?.kind === 'replay') setReplayOpen((open) => !open);
  }, [command]);
  // A replay belongs to one market and interval.
  useEffect(() => {
    replay.exit();
    setReplayNote(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market.symbol, interval]);
  /** The words for a replay that cannot start: each reason states its own fact, so a count is never read as a bar back. */
  const replayRefusal = (reason: ReplayRefusal, most: number, bars: number): string =>
    reason === 'whole'
      ? t('Replay whole')
      : reason === 'least'
        ? t('Replay least')
        : reason === 'few'
          ? t('Replay few', { bars: String(bars) })
          : t('Replay too deep', { most: String(most), bars: String(bars) });
  const startReplay = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const back = Number(form.get('back'));
    const speed = Number(form.get('speed')) as ReplaySpeed;
    const start = replayStart(all.length, back);
    if (!start.ok) {
      setReplayNote(replayRefusal(start.reason, start.most, all.length));
      return;
    }
    setReplayNote(null);
    replay.start(all, start.position, REPLAY_SPEEDS.includes(speed) ? speed : 1);
  };
  const [basisRefused, setBasisRefused] = useState<PriceBasis | null>(null);
  const [focus, setFocus] = useState<{ index: number; nonce: number } | null>(null);
  const [dateNote, setDateNote] = useState<string | null>(null);
  // A date asked for on one interval or style is not carried to the next one.
  useEffect(() => {
    setFocus(null);
    setDateNote(null);
  }, [market.symbol, interval, mode]);
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
    if (loaded.status === 'error') {
      setDateNote(t('Depth error'));
      return;
    }
    const spot = locateDate(bars, target, history.oldestReachable, Date.now());
    if (spot.kind === 'show') {
      setDateNote(null);
      setFocus({ index: spot.index, nonce: Date.now() });
    } else if (spot.kind === 'no-trades-until') {
      setDateNote(t('Date before start', { earliest: day(spot.earliest) }));
      setFocus({ index: 0, nonce: Date.now() });
    } else if (spot.kind === 'beyond-depth') {
      setDateNote(t('Date beyond depth', { depth: String(HISTORY_DEPTH), oldest: day(spot.oldestReachable) }));
    } else setDateNote(t('Date in future'));
  };

  let body: React.ReactNode;
  if (polled.status === 'loading') body = <Skeleton shape="chart" />;
  else if (polled.status === 'empty')
    // Volume is the sum of the market's trades, so a market with no trades has none: the chart says so, as the volume
    // study does on loaded bars with no volume.
    body = (
      <>
        <StateBlock kind="empty" title={t('No trades in this period')} body={t('No volume in this period')} />
        {emptyAddons?.()}
      </>
    );
  else if (polled.status === 'error')
    body = <StateBlock kind="error" title={t('Couldn’t load the chart')} onRetry={polled.retry} retryLabel={t('Try again')} />;
  else if (polled.status === 'refused') {
    const words = refusalCopy(polled.code);
    body = <StateBlock kind="refused" title={words.title} body={words.body} action={words.action} />;
  } else
    body = (
      <WorkbenchChart
        candles={drawnBars}
        chartStyle={mode}
        scheme={scheme}
        percent={percent}
        resetKey={`${market.symbol}:${interval}`}
        symbol={market.symbol}
        tickSize={market.tickSize}
        timeZone={zoneName(timeZone)}
        labels={labels}
        onReachStart={() => void history.load()}
        focus={replay.replay ? null : focus}
        onHost={reportHost}
        settings={settings}
        priceLines={lines}
      >
        {(host, bars) => (
          <>
            {addons?.(host, bars, { percent, replaying: replay.replay !== null })}
            <ChartTrading
              host={host}
              market={market}
              refusal={orderRefusal}
              protectionBps={protection}
              protectionWhy={protectionRead.ok ? null : protectionRead.why}
              replaying={replay.replay !== null}
              orderButton={settings.orderButton}
            />
            <ChartAlerts host={host} market={market} replaying={replay.replay !== null} levels={settings.alertLevels} />
          </>
        )}
      </WorkbenchChart>
    );

  const primaryIntervals = venue ? CHART_INTERVALS.filter((id) => venue.intervals.includes(id)) : CHART_INTERVALS;
  const extraIntervals = venue ? MORE_INTERVALS.filter((id) => venue.intervals.includes(id)) : MORE_INTERVALS;
  const moreActive = (extraIntervals as readonly string[]).includes(interval);
  const note = stream.mode === 'stream' ? t('Feed stream') : isStreamInterval(interval) ? t('Feed poll') : t('Feed poll interval');
  const feedText =
    status.feed === 'connected'
      ? t('Feed connected')
      : status.feed === 'stale'
        ? t('Feed stale')
        : status.feed === 'down'
          ? t('Feed down')
          : status.feed === 'empty'
            ? t('Feed empty')
            : null;
  const seconds = polled.status === 'ready' ? Math.max(0, Math.round((now - polled.asOf) / 1000)) : null;
  const depth =
    candles && history.state.status === 'loaded'
      ? t('Depth loaded', {
          bars: String(candles.length),
          from: day(candles[0]!.t),
          depth: String(HISTORY_DEPTH),
          oldest: day(history.state.since),
        })
      : history.state.status === 'loading'
        ? t('Depth loading')
        : history.state.status === 'error'
          ? t('Depth error')
          : candles
            ? t('Depth recent', { bars: String(candles.length) })
            : null;
  return (
    <section data-testid="cw" className="lt-panel" aria-label={t('Chart of {pair}', { pair: market.symbol })} data-feed={stream.mode}>
      <div className="lt-row">
        <h2 className="lt-panel-title" data-testid="chart-title">
          {settings.showName ? `${market.symbol} · ${intervalLabel(interval)}` : intervalLabel(interval)}
        </h2>
        <TestLabel status={status} />
        <StatusChip status={status} />
      </div>
      <div className="lt-row lt-row-between">
        <div className="lt-chips" role="group" aria-label={t('Chart intervals')}>
          {primaryIntervals.map((id) => (
            <button key={id} type="button" aria-pressed={interval === id} onClick={() => onInterval(id)}>
              {intervalLabel(id)}
            </button>
          ))}
          {extraIntervals.length > 0 && (
            <Menu
              testId="cw-more"
              size="sm"
              align="start"
              active={moreActive}
              label={
                <>
                  {moreActive ? intervalLabel(interval) : t('More intervals')}
                  <span aria-hidden="true"> ▾</span>
                </>
              }
              items={extraIntervals.map((id) => ({ key: id, label: intervalLabel(id), onSelect: () => onInterval(id) }))}
            />
          )}
        </div>
        <div className="lt-chips" role="group" aria-label={t('Chart style')}>
          {CHART_STYLES.map((id) => (
            <button key={id} type="button" aria-pressed={mode === id} onClick={() => onMode(id)}>
              {t(STYLE_LABEL[id])}
            </button>
          ))}
        </div>
      </div>
      {/* On a phone the chart's own tools fold under one line, so the chart comes before them; wider, they start open. */}
      <details className="lt-stack" open={toolsOpen} onToggle={(event) => setToolsState({ compact, open: event.currentTarget.open })}>
        <summary className="lt-link">{t('Chart tools')}</summary>
        <div className="lt-toolbar">
          {onScheme && (
            <label className="lt-field">
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
          <label className="lt-field">
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
          <button
            type="button"
            className="lt-button lt-button-secondary"
            aria-pressed={replayOpen}
            onClick={() => setReplayOpen((open) => !open)}
          >
            {t('Bar replay')}
          </button>
          <button type="button" className="lt-button lt-button-secondary" aria-haspopup="dialog" onClick={() => setSettingsOpen(true)}>
            {t('Chart settings')}
          </button>
          <button
            type="button"
            className="lt-button lt-button-secondary"
            aria-pressed={priceLineOpen}
            onClick={() => setPriceLineOpen((open) => !open)}
          >
            {t('Price line')}
          </button>
          <form className="lt-row" onSubmit={(event) => void goToDate(event)}>
            <label className="lt-field">
              <span>{t('Go to date')}</span>
              <DateInput type="datetime-local" name="date" required />
            </label>
            <Button type="submit" size="sm">
              {t('Go')}
            </Button>
          </form>
        </div>
        {markets && (
          <CompareTools
            host={host}
            market={market}
            markets={markets}
            interval={interval}
            chartStyle={mode}
            bars={drawnBars}
            percent={percent}
            onPercent={setPercent}
          />
        )}
      </details>
      {basisRefused && (
        <p className="lt-note lt-note-warn" role="status" data-code={BASIS_UNPUBLISHED}>
          {t('Basis refused', { basis: t(BASIS_LABEL[basisRefused]) })}
        </p>
      )}
      {dateNote && (
        <p className="lt-note lt-note-warn" role="status" data-testid="chart-date-note">
          {dateNote}
        </p>
      )}
      <StatusBanner status={status} format={day} />
      <div className="lt-canvas">{body}</div>
      <SourceLine />
      <PriceLines lines={lines} tickSize={market.tickSize} open={priceLineOpen} onChange={setLines} />
      <p className="lt-note" data-testid="chart-feed">
        {feedText && <>{feedText} · </>}
        {note}
        {stream.mode === 'poll' && seconds !== null && <> {t('Feed age', { seconds: String(seconds) })}</>}
      </p>
      <ChartSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        settings={settings}
        onChange={(next) => setStoredSettings(next)}
        symbol={market.symbol}
        tick={market.tickSize}
      />
      {replayOpen && (
        <div className="lt-row" role="group" aria-label={t('Bar replay')}>
          {replay.replay ? (
            <>
              <span data-testid="replay-position">
                {t('Replay position', { bar: String(replay.replay.position + 1), bars: String(replay.replay.bars.length) })}
              </span>
              {replay.replay.playing ? (
                <Button size="sm" onClick={replay.pause}>
                  {t('Pause')}
                </Button>
              ) : (
                <Button size="sm" onClick={replay.play}>
                  {t('Play')}
                </Button>
              )}
              <Button size="sm" onClick={replay.step}>
                {t('Step')}
              </Button>
              <label className="lt-field">
                <span>{t('Replay speed')}</span>
                <select value={replay.replay.speed} onChange={(event) => replay.speed(Number(event.target.value) as ReplaySpeed)}>
                  {REPLAY_SPEEDS.map((x) => (
                    <option key={x} value={x}>{`${x}x`}</option>
                  ))}
                </select>
              </label>
              <Button size="sm" onClick={replay.exit}>
                {t('Exit replay')}
              </Button>
            </>
          ) : (
            <form className="lt-row" onSubmit={startReplay}>
              <label className="lt-field">
                <span>{t('Bars back')}</span>
                <input type="number" name="back" min={1} step={1} defaultValue={100} required />
              </label>
              <label className="lt-field">
                <span>{t('Replay speed')}</span>
                <select name="speed" defaultValue="1">
                  {REPLAY_SPEEDS.map((x) => (
                    <option key={x} value={x}>{`${x}x`}</option>
                  ))}
                </select>
              </label>
              <Button type="submit" size="sm">
                {t('Start replay')}
              </Button>
            </form>
          )}
          <span className="lt-note">{t('Replay note')}</span>
          {replayNote && (
            <span role="status" data-testid="replay-note">
              {replayNote}
            </span>
          )}
        </div>
      )}
      {depth && (
        <p className="lt-note" data-testid="chart-depth">
          {depth}
        </p>
      )}
    </section>
  );
});
