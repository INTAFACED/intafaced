import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ScreenProps } from '../../app/screen-types';
import { useDeviceSetting } from '../../features/trade/hooks';
import { useSession } from '../../features/session/session';
import type { ChartInterval } from '../trade/chart/candles';
import { useDeskMarkets } from '../trade/desk/data';
import { findMarket, pairOf, type DeskMarket } from '../trade/desk/market';
import '../trade/chart/chart.css';
import './charts.css';
import { chartsCopy } from './copy';
import { defaultDeskPair, navigate, normalizePair, refusalCopy, Skeleton, StateBlock } from './deps';
import { ChartGrid } from './ChartGrid';
import type { WidgetProps } from './MarketChartWidget';
import { DrawingsLayer } from './drawings/DrawingsLayer';
import { drawingsKey, readDoc, writeDoc } from './drawings/store';
import type { DrawingLimits } from './drawings/model';
import { ownerValue, useChartOwnerValues } from './owner-values';
import { useBookHalt, useMarketLifecycle } from './market-state';
import { refusalText } from './DataStatus';
import { tradeRefusal } from './data-status';
import {
  DEFAULT_SETTING,
  chartsHref,
  intervalFromSearch,
  isWorkbenchSetting,
  settingKey,
  workbenchId,
  unofferedInterval,
  intervalLabel,
  type ChartMode,
  type WorkbenchSetting,
} from './workbench';
import { isChartStyle, type ColourScheme } from './chart-style';
import { WatchlistPanel } from '../../features/watchlists/WatchlistPanel';
import { chartHrefFor, WATCHLIST_DRAG_TYPE } from '../../features/watchlists/links';
import { TemplatesMenu } from './TemplatesMenu';
import { drawingsFrom, styleFrom, studiesFrom, type ChartTemplate } from './templates';
import { templatesCopy } from './templates-copy';
import { FEATURESETS, describeFeatureset, styleOnDesk } from './featureset';

/** The workbench's chart parts (charts-desk-embed-feed-ops-018): the full chart. */
const FEATURES = FEATURESETS.workbench;
import { FRESH_STORE, isStudyStore, storeKey, type StudyStore } from './studies/model';

/** The workbench's main-chart studies as kept on this device (the studies bar writes them on every change). */
function readStudies(key: string): StudyStore {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? 'null');
    return isStudyStore(stored) ? stored : FRESH_STORE;
  } catch {
    return FRESH_STORE;
  }
}

function MarketSelect({
  label,
  value,
  markets,
  onChoose,
}: {
  label: string;
  value: string;
  markets: readonly DeskMarket[];
  onChoose: (symbol: string) => void;
}) {
  return (
    <label className="cw-select">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChoose(event.target.value)}>
        {markets.map((market) => (
          <option key={market.symbol} value={market.symbol}>
            {market.symbol}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * The chart's way to the desk for its market. While the market's state is halted, not open or unreadable, the control is
 * disabled and names the reason: the chart never offers an order into a market that cannot take one.
 */
function TradeLink({ symbol }: { symbol: string }) {
  const { t } = chartsCopy.useCopy();
  // The link is disabled until the state and the book are read, and while either is refused: one rule, the chart's own.
  const lifecycle = useMarketLifecycle(symbol);
  const bookHalt = useBookHalt(symbol);
  const refusal = refusalText(tradeRefusal(lifecycle, bookHalt, Date.now()), t);
  if (refusal !== null)
    return (
      <span className="cw-link-refused">
        <button
          type="button"
          data-testid="cw-link"
          className="cw-link"
          disabled
          aria-describedby="cw-trade-refusal"
          data-code="trade.chart.order_entry_refused"
        >
          {t('Trade this market')}
        </button>
        <span id="cw-trade-refusal" role="status">
          {refusal}
        </span>
      </span>
    );
  return (
    <a data-testid="cw-link" className="cw-link" href={`/trade/spot/${pairOf(symbol)}`}>
      {t('Trade this market')}
    </a>
  );
}

function Page({
  market,
  markets,
  search,
  openSocket,
}: {
  market: DeskMarket;
  markets: readonly DeskMarket[];
  search: string;
  openSocket?: WidgetProps['openSocket'];
}) {
  const { t } = chartsCopy.useCopy();
  const { userId } = useSession();
  const id = workbenchId(search);
  const [setting, setSetting] = useDeviceSetting<WorkbenchSetting>(settingKey(userId, id), DEFAULT_SETTING, isWorkbenchSetting);
  // An interval in the address opens the workbench at that interval, once; after that the person's choice stands.
  // A shared link also names the style (`?style=line`), applied the same way.
  const fromAddress = useRef(intervalFromSearch(search));
  const styleFromAddress = useRef(new URLSearchParams(search).get('style'));
  useEffect(() => {
    const wanted = fromAddress.current;
    const style = styleFromAddress.current;
    fromAddress.current = undefined;
    styleFromAddress.current = null;
    const next = { ...setting };
    if (wanted) next.interval = wanted;
    if (isChartStyle(style)) next.mode = style;
    if (next.interval !== setting.interval || next.mode !== setting.mode) setSetting(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const setInterval = useCallback((interval: ChartInterval) => setSetting((now) => ({ ...now, interval })), [setSetting]);
  const setMode = useCallback((mode: ChartMode) => setSetting((now) => ({ ...now, mode })), [setSetting]);
  const setScheme = useCallback((scheme: ColourScheme) => setSetting((now) => ({ ...now, scheme })), [setSetting]);
  const unoffered = useMemo(() => unofferedInterval(search), [search]);
  const chooseMarket = useCallback((symbol: string) => navigate(chartsHref(pairOf(symbol), { workbench: id })), [id]);
  // The owner's drawing caps. A blank, loading or failed read is null, and the drawing tools refuse with the typed reason.
  const owner = useChartOwnerValues(market.symbol);
  const drawingCap = ownerValue(owner, 'drawingCap');
  const brushCap = ownerValue(owner, 'brushPointCap');
  const limits: DrawingLimits = {
    drawingCap: drawingCap.ok ? drawingCap.value : null,
    drawingWhy: drawingCap.ok ? undefined : drawingCap.why,
    brushPointCap: brushCap.ok ? brushCap.value : null,
    brushWhy: brushCap.ok ? undefined : brushCap.why,
  };
  // Chart templates (C-embed-feed-ops-03): applying one replaces this workbench's study set and style and adds its drawings
  // on the market they were drawn on, then draws the grid again so every chart reads them; the interval and symbol stay.
  const { t: tt } = templatesCopy.useCopy();
  type Applied =
    | { name: string; count: number; placed: number; keptFor: string | null; kept: number; nonce: number }
    | { refused: 'Not drawable' | 'Drawings over cap' | 'Drawing cap unset'; nonce: number };
  const [applied, setApplied] = useState<Applied | null>(null);
  const studiesKey = storeKey(userId, id);
  const drawingKey = drawingsKey(userId, id, market.symbol);
  const currentChart = useCallback(
    () => ({
      studies: readStudies(studiesKey),
      style: setting.mode,
      scheme: setting.scheme ?? 'standard',
      drawings: FEATURES.drawings ? { symbol: market.symbol, doc: readDoc(localStorage, drawingKey) } : undefined,
    }),
    [studiesKey, setting.mode, setting.scheme, market.symbol, drawingKey],
  );
  const applyTemplate = useCallback(
    (template: ChartTemplate) => {
      const studies = studiesFrom(template, readStudies(studiesKey));
      const style = styleFrom(template);
      const drawings = FEATURES.drawings ? drawingsFrom(template, market.symbol, readDoc(localStorage, drawingKey)) : null;
      const nonce = (applied?.nonce ?? 0) + 1;
      if (!studies || !style || (FEATURES.drawings && !drawings)) return setApplied({ refused: 'Not drawable', nonce });
      // The owner's drawing cap holds for a template's drawings as for drawn ones; a blank cap places none.
      const placing = drawings && 'doc' in drawings && drawings.placed > 0 ? drawings : null;
      if (placing && limits.drawingCap === null) return setApplied({ refused: 'Drawing cap unset', nonce });
      if (placing && limits.drawingCap !== null && placing.doc.drawings.length > limits.drawingCap)
        return setApplied({ refused: 'Drawings over cap', nonce });
      // Only the parts this desk turns on: studies where it draws them, a style it draws (else it keeps its own).
      try {
        if (FEATURES.studies) localStorage.setItem(studiesKey, JSON.stringify(studies));
        if (placing && !writeDoc(localStorage, drawingKey, placing.doc)) return setApplied({ refused: 'Not drawable', nonce });
      } catch {
        return setApplied({ refused: 'Not drawable', nonce });
      }
      setSetting((now) => ({ ...now, mode: styleOnDesk(FEATURES, style.mode, now.mode), scheme: style.scheme }));
      setApplied({
        name: template.name,
        count: FEATURES.studies ? studies.studies.length : 0,
        placed: placing?.placed ?? 0,
        keptFor: drawings && 'keptFor' in drawings ? drawings.keptFor : null,
        kept: drawings && 'keptFor' in drawings ? drawings.count : 0,
        nonce,
      });
    },
    [studiesKey, drawingKey, market.symbol, limits.drawingCap, setSetting, applied?.nonce],
  );
  return (
    <div className="cw-page" data-market={market.symbol} data-workbench={id} data-featureset={describeFeatureset(FEATURES)}>
      <header className="cw-head">
        <div>
          <h1>{t('Charts')}</h1>
          <p>{t('Charts lead')}</p>
        </div>
        <div className="cw-head-actions">
          <MarketSelect label={t('Choose a market')} value={market.symbol} markets={markets} onChoose={chooseMarket} />
          <TradeLink symbol={market.symbol} />
          {FEATURES.templates ? <TemplatesMenu current={currentChart} onApply={applyTemplate} /> : null}
        </div>
      </header>
      {applied && 'refused' in applied ? (
        <p role="status" className="cw-note" data-testid="cw-template-refused" data-why={applied.refused}>
          {applied.refused === 'Drawings over cap'
            ? tt('Drawings over cap', { cap: String(limits.drawingCap ?? '') })
            : tt(applied.refused)}
        </p>
      ) : applied ? (
        <p
          role="status"
          className="cw-note"
          data-testid="cw-template"
          data-template={applied.name}
          data-drawings-placed={applied.placed}
          data-drawings-kept-for={applied.keptFor ?? undefined}
        >
          {tt('Applied', { name: applied.name, count: applied.count })}
          {applied.placed > 0 ? ` ${tt('Drawings placed', { count: applied.placed })}` : ''}
          {applied.keptFor ? ` ${tt('Drawings kept for', { count: applied.kept, symbol: applied.keptFor })}` : ''}
        </p>
      ) : null}
      {unoffered && (
        <div role="status" className="cw-note" data-code="trade.datafeed.interval_unsupported">
          <b>{t('Interval not offered title', { interval: unoffered })}</b>{' '}
          {t('Interval not offered body', { current: intervalLabel(setting.interval) })}
        </div>
      )}
      <div className="cw-split">
        {/* A watchlist row dragged here opens its market on this chart, at the interval the workbench already has. */}
        <div
          data-testid="cw-split-chart"
          className="cw-split-chart"
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes(WATCHLIST_DRAG_TYPE)) event.preventDefault();
          }}
          onDrop={(event) => {
            const symbol = event.dataTransfer.getData(WATCHLIST_DRAG_TYPE);
            if (!symbol) return;
            event.preventDefault();
            navigate(chartHrefFor(symbol, id));
          }}
        >
          <ChartGrid
            key={applied && !('refused' in applied) ? `template-${applied.nonce}` : 'grid'}
            market={market}
            markets={markets}
            workbench={id}
            setting={setting}
            setInterval={setInterval}
            setMode={setMode}
            setScheme={setScheme}
            openSocket={openSocket}
            mainAddons={(host, bars, view) => (
              <DrawingsLayer
                key={id}
                host={host}
                bars={bars}
                onIndicatorsSlot={view.onTreeSlot}
                workbench={id}
                symbol={market.symbol}
                tickSize={market.tickSize}
                limits={limits}
              />
            )}
          />
        </div>
        <WatchlistPanel workbench={id} />
      </div>
    </div>
  );
}

/** The workbench, `/charts/:symbol`: a chart for the market in the address, with the interval and style shared by every chart on the page. */
export default function ChartsScreen({ params, search, openSocket }: ScreenProps & { openSocket?: WidgetProps['openSocket'] }) {
  const { t } = chartsCopy.useCopy();
  const markets = useDeskMarkets();
  const pair = normalizePair(params.symbol ?? defaultDeskPair);
  if (markets.status === 'loading')
    return (
      <div className="cw-page" role="status" aria-busy="true">
        <Skeleton height={440} className="bg-field" />
      </div>
    );
  if (markets.status === 'error')
    return (
      <div className="cw-page cw-page--state">
        <StateBlock kind="error" title={t('Couldn’t load this market')} onRetry={markets.retry} retryLabel={t('Try again')} />
      </div>
    );
  if (markets.status === 'refused') {
    const words = refusalCopy(markets.code, { pair });
    return (
      <div className="cw-page cw-page--state">
        <StateBlock kind="refused" title={words.title} body={words.body} action={words.action} />
      </div>
    );
  }
  const market = markets.status === 'ready' ? findMarket(markets.data, pair) : undefined;
  if (!market || markets.status !== 'ready')
    return (
      <div className="cw-page cw-page--state">
        <StateBlock
          kind="empty"
          title={t('Market not found title')}
          body={t('Market not found body')}
          action={{ label: t('See all markets'), href: '/trade' }}
        />
      </div>
    );
  return <Page key={market.symbol} market={market} markets={markets.data} search={search} openSocket={openSocket} />;
}
