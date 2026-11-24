import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import type { Order } from '../../../features/trade/trade-api';
import { useDeviceSetting } from '../../../features/trade/hooks';
import type { Trade } from '@intafaced/exchange-contract/schemas';
import { usePreferences } from '../../../shared/preferences';
import { CHART_INTERVALS, MORE_INTERVALS, useChartCandles, type ChartInterval } from '../chart/candles';
import { PriceChart, type ChartOrderLine } from '../chart/PriceChart';
import { deskCopy } from './copy';
import { Menu, refusalCopy, Skeleton, StateBlock, type Loadable } from './deps';
import { TabPanel, Tabs } from '@intafaced/ui/lit/templates';
import { pairOf, type DeskMarket } from './market';
import { placesOf } from './text';
import { MarketRulesList } from './MarketRules';
import { zoneName } from './time';
import { flowCopy } from './order-flow-copy';
import { FEATURESETS, describeFeatureset } from '../../charts/featureset';
import { CHART_SETTING_DEFAULT, CHART_SETTING_KEY, isChartSetting, type ChartSetting } from './chart-setting';

interface Props {
  market: DeskMarket;
  openOrders: Loadable<Order[]>;
  fills: Loadable<Trade[]>;
  /** The DOM is showing (J-charts-desk-14 #1); the chart's button opens and closes it. */
  domOpen?: boolean;
  onToggleDom?: () => void;
  /** Buy and Sell on the chart with the live spread (J-charts-desk-14 #5), laid over the chart. */
  trade?: ReactNode;
  /** An interval asked for from outside the panel (a saved layout opened); each new nonce is applied once. */
  requestedInterval?: { interval: ChartInterval; nonce: number } | null;
}

const intervalLabel = (interval: ChartInterval) => (interval === '1d' ? '1D' : interval === '1w' ? '1W' : interval);

/** Centre top (UI-SPEC 5.7): Chart and Info tabs, interval toolbar, candles or line, full screen. */
export const ChartPanel = memo(function ChartPanel({ market, openOrders, fills, domOpen, onToggleDom, trade, requestedInterval }: Props) {
  const { t } = deskCopy.useCopy();
  const flow = flowCopy.useCopy();
  const { timeZone } = usePreferences();
  const [setting, setSetting] = useDeviceSetting<ChartSetting>(CHART_SETTING_KEY, CHART_SETTING_DEFAULT, isChartSetting);
  const { interval, mode } = setting;
  useEffect(() => {
    if (requestedInterval) setSetting((current) => ({ ...current, interval: requestedInterval.interval }));
  }, [requestedInterval?.nonce]); // eslint-disable-line react-hooks/exhaustive-deps
  const [tab, setTab] = useState<'chart' | 'info'>('chart');
  const [full, setFull] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const candles = useChartCandles(market.symbol, interval);

  useEffect(() => {
    const onChange = () => setFull(document.fullscreenElement === panel.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const orderLines = useMemo<ChartOrderLine[]>(
    () =>
      openOrders.status === 'ready'
        ? openOrders.data.flatMap((order) =>
            order.symbol === market.symbol && order.price !== null ? [{ price: order.price, side: order.side }] : [],
          )
        : [],
    [openOrders, market.symbol],
  );
  const fillMarks = useMemo(
    () =>
      fills.status === 'ready'
        ? fills.data.filter((fill) => fill.symbol === market.symbol).map((fill) => ({ at: fill.timestamp, side: fill.side }))
        : [],
    [fills, market.symbol],
  );
  const labels = useMemo(
    () => ({
      buy: t('Side buy'),
      sell: t('Side sell'),
      open: t('O'),
      high: t('H'),
      low: t('L'),
      close: t('C'),
      change: t('Change'),
      chart: t('Chart of {pair}', { pair: market.symbol }),
    }),
    [t, market.symbol],
  );

  const toggleFull = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void panel.current?.requestFullscreen?.();
  };

  let body: React.ReactNode;
  if (candles.status === 'loading')
    body = (
      <div data-testid="dk-chart-skeleton">
        <Skeleton shape="chart" />
      </div>
    );
  else if (candles.status === 'empty') body = <StateBlock kind="empty" title={t('No trades in this period')} />;
  else if (candles.status === 'error')
    body = <StateBlock kind="error" title={t('Couldn’t load the chart')} onRetry={candles.retry} retryLabel={t('Try again')} />;
  else if (candles.status === 'refused') {
    const words = refusalCopy(candles.code);
    body = <StateBlock kind="refused" title={words.title} body={words.body} action={words.action} />;
  } else
    body = (
      <PriceChart
        candles={candles.data}
        mode={mode}
        interval={interval}
        resetKey={`${market.symbol}:${interval}`}
        tickSize={market.tickSize}
        orderLines={orderLines}
        fills={fillMarks}
        timeZone={zoneName(timeZone)}
        labels={labels}
      />
    );

  const moreActive = (MORE_INTERVALS as readonly string[]).includes(interval);
  return (
    <div data-testid="dk-chart" data-featureset={describeFeatureset(FEATURESETS['spot-desk'])} className="lt-panel" ref={panel}>
      <Tabs
        id="dk-chart"
        items={[
          { value: 'chart', label: t('Chart') },
          { value: 'info', label: t('Info') },
        ]}
        value={tab}
        onChange={(value) => setTab(value as 'chart' | 'info')}
      />
      <TabPanel id="dk-chart" value="chart" current={tab}>
        <div className="lt-stack">
          <div className="lt-row lt-row-between">
            <div className="lt-chips" role="group" aria-label={t('Chart intervals')}>
              {CHART_INTERVALS.map((id) => (
                <button key={id} type="button" aria-pressed={interval === id} onClick={() => setSetting({ ...setting, interval: id })}>
                  {intervalLabel(id)}
                </button>
              ))}
              <Menu
                size="sm"
                align="start"
                testId="dk-more"
                active={moreActive}
                label={
                  <>
                    {moreActive ? intervalLabel(interval) : t('More intervals')}
                    <span aria-hidden="true"> ▾</span>
                  </>
                }
                items={MORE_INTERVALS.map((id) => ({
                  key: id,
                  label: intervalLabel(id),
                  onSelect: () => setSetting({ ...setting, interval: id }),
                }))}
              />
            </div>
            <div className="lt-row">
              {onToggleDom ? (
                <button type="button" aria-pressed={domOpen === true} data-testid="dk-open-dom" onClick={onToggleDom}>
                  {domOpen ? flow.t('Close DOM') : flow.t('Open DOM')}
                </button>
              ) : null}
              <div role="group" className="lt-chips" aria-label={t('Chart style')}>
                <button type="button" aria-pressed={mode === 'candles'} onClick={() => setSetting({ ...setting, mode: 'candles' })}>
                  {t('Candles')}
                </button>
                <button type="button" aria-pressed={mode === 'line'} onClick={() => setSetting({ ...setting, mode: 'line' })}>
                  {t('Line')}
                </button>
              </div>
              <a className="lt-link" data-testid="dk-full-chart" href={`/charts/${pairOf(market.symbol)}`}>
                {t('Full chart')}
              </a>
              <button
                type="button"
                className="lt-icon-button"
                aria-label={full ? t('Exit full screen') : t('Full screen')}
                onClick={toggleFull}
              >
                {full ? <Minimize2 size={16} aria-hidden="true" /> : <Maximize2 size={16} aria-hidden="true" />}
              </button>
            </div>
          </div>
          <div className="lt-canvas">{body}</div>
          {trade}
        </div>
      </TabPanel>
      <TabPanel id="dk-chart" value="info" current={tab}>
        <div data-testid="dk-info" className="lt-stack">
          <h2 className="lt-panel-title">{t('Market rules')}</h2>
          <MarketRulesList market={market} />
          <p className="lt-note">{t('Fee rule')}</p>
        </div>
      </TabPanel>
    </div>
  );
});
