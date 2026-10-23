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
import type { DrawingLimits } from './drawings/model';
import { ownerValue, useChartOwnerValues } from './owner-values';
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
import { LayoutsMenu } from './layouts/LayoutsMenu';
import { layoutsCopy } from './layouts/copy';
import { DEFAULT_DESK, isDeskSetting } from './layouts/model';
import { deskKey } from './layouts/capture';
import type { DeskSetting } from '@intafaced/contracts/layouts-preferences';

/** The watchlist widget is dragged by its grip and dropped on either half of the chart area. Its own drag type, never a symbol. */
const WIDGET_DRAG_TYPE = 'application/x-intafaced-widget';

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

function Page({
  market,
  markets,
  search,
  openSocket,
  onRemount,
}: {
  market: DeskMarket;
  markets: readonly DeskMarket[];
  search: string;
  openSocket?: WidgetProps['openSocket'];
  onRemount: () => void;
}) {
  const { t } = chartsCopy.useCopy();
  const { t: tl } = layoutsCopy.useCopy();
  const { userId } = useSession();
  const id = workbenchId(search);
  const [setting, setSetting] = useDeviceSetting<WorkbenchSetting>(settingKey(userId, id), DEFAULT_SETTING, isWorkbenchSetting);
  // The desk: which widgets show (the preset's), and which side the watchlist sits on. Kept on this device, and in a layout.
  const [desk, setDesk] = useDeviceSetting<DeskSetting>(deskKey(userId, id), DEFAULT_DESK, isDeskSetting);
  const [dragging, setDragging] = useState(false);
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
  return (
    <div className="cw-page" data-market={market.symbol} data-workbench={id}>
      <header className="cw-head">
        <div>
          <h1>{t('Charts')}</h1>
          <p>{t('Charts lead')}</p>
        </div>
        <div className="cw-head-actions">
          <MarketSelect label={t('Choose a market')} value={market.symbol} markets={markets} onChoose={chooseMarket} />
          <LayoutsMenu
            workbench={id}
            symbol={market.symbol}
            markets={markets}
            setting={setting}
            desk={desk}
            setDesk={setDesk}
            limits={{ drawingCap: limits.drawingCap, brushPointCap: limits.brushPointCap }}
            onRemount={onRemount}
          />
          <a className="cw-link" href={`/trade/spot/${pairOf(market.symbol)}`}>
            {t('Trade this market')}
          </a>
        </div>
      </header>
      {unoffered && (
        <div role="status" className="cw-note" data-code="trade.datafeed.interval_unsupported">
          <b>{t('Interval not offered title', { interval: unoffered })}</b>{' '}
          {t('Interval not offered body', { current: intervalLabel(setting.interval) })}
        </div>
      )}
      <div
        className={`cw-split${desk.side === 'left' ? ' cw-split--left' : ''}${dragging ? ' cw-split--drop' : ''}`}
        data-side={desk.side}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes(WIDGET_DRAG_TYPE)) event.preventDefault();
        }}
        onDrop={(event) => {
          // A widget dropped on the left or right half of the page takes that side. A widget drop is never a market drop.
          if (!event.dataTransfer.types.includes(WIDGET_DRAG_TYPE)) return;
          event.preventDefault();
          setDragging(false);
          const box = event.currentTarget.getBoundingClientRect();
          setDesk({ ...desk, side: event.clientX < box.left + box.width / 2 ? 'left' : 'right' });
        }}
      >
        {/* A watchlist row dragged here opens its market on this chart, at the interval the workbench already has. */}
        <div
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
            market={market}
            markets={markets}
            workbench={id}
            setting={setting}
            setInterval={setInterval}
            setMode={setMode}
            setScheme={setScheme}
            openSocket={openSocket}
            showStudies={desk.studies}
            mainAddons={(host, bars) =>
              desk.drawings ? (
                <DrawingsLayer
                  key={id}
                  host={host}
                  bars={bars}
                  workbench={id}
                  symbol={market.symbol}
                  tickSize={market.tickSize}
                  limits={limits}
                />
              ) : null
            }
          />
        </div>
        <div className="cw-widget" data-widget="watchlist">
          <button
            type="button"
            className="cw-grip"
            draggable
            aria-label={tl('Drag widget')}
            title={tl('Drag widget')}
            onDragStart={(event) => {
              event.dataTransfer.setData(WIDGET_DRAG_TYPE, 'watchlist');
              event.dataTransfer.effectAllowed = 'move';
              setDragging(true);
            }}
            onDragEnd={() => setDragging(false)}
          >
            {tl('Drag widget')}
          </button>
          <WatchlistPanel workbench={id} />
        </div>
      </div>
    </div>
  );
}

/** The workbench, `/charts/:symbol`: a chart for the market in the address, with the interval and style shared by every chart on the page. */
export default function ChartsScreen({ params, search, openSocket }: ScreenProps & { openSocket?: WidgetProps['openSocket'] }) {
  const { t } = chartsCopy.useCopy();
  const markets = useDeskMarkets();
  // Bumped when a layout, template or reset has written the device's settings: the page mounts again and reads them.
  const [revision, setRevision] = useState(0);
  const remount = useCallback(() => setRevision((now) => now + 1), []);
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
  return (
    <Page
      key={`${market.symbol}#${revision}`}
      market={market}
      markets={markets.data}
      search={search}
      openSocket={openSocket}
      onRemount={remount}
    />
  );
}
