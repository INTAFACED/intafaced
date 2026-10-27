import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import type { Order } from '../../../features/trade/trade-api';
import { useDeviceSetting } from '../../../features/trade/hooks';
import type { Trade } from '@intafaced/exchange-contract/schemas';
import { usePreferences } from '../../../shared/preferences';
import { CHART_INTERVALS, MORE_INTERVALS, useChartCandles, type ChartInterval } from '../chart/candles';
import { PriceChart, type ChartOrderLine } from '../chart/PriceChart';
import { deskCopy } from './copy';
import {
  fmtAmount,
  fmtPrice,
  Menu,
  MenuContent,
  MenuItem,
  MenuTrigger,
  refusalCopy,
  Skeleton,
  StateBlock,
  Tabs,
  TabsList,
  TabsPanel,
  TabsTab,
  type Loadable,
} from './deps';
import type { DeskMarket } from './market';
import { placesOf } from './text';
import { MarketRulesList } from './MarketRules';
import { zoneName } from './time';

type Mode = 'candles' | 'line';
const isSetting = (value: unknown): value is { interval: ChartInterval; mode: Mode } =>
  typeof value === 'object' &&
  value !== null &&
  'interval' in value &&
  'mode' in value &&
  [...CHART_INTERVALS, ...MORE_INTERVALS].includes((value as { interval: ChartInterval }).interval) &&
  ((value as { mode: Mode }).mode === 'candles' || (value as { mode: Mode }).mode === 'line');

interface Props {
  market: DeskMarket;
  openOrders: Loadable<Order[]>;
  fills: Loadable<Trade[]>;
}

const intervalLabel = (interval: ChartInterval) => (interval === '1d' ? '1D' : interval === '1w' ? '1W' : interval);

/** Centre top (UI-SPEC 5.7): Chart and Info tabs, interval toolbar, candles or line, full screen. */
export const ChartPanel = memo(function ChartPanel({ market, openOrders, fills }: Props) {
  const { t } = deskCopy.useCopy();
  const { timeZone } = usePreferences();
  const [setting, setSetting] = useDeviceSetting<{ interval: ChartInterval; mode: Mode }>(
    'trade-desk-chart',
    { interval: '15m', mode: 'candles' },
    isSetting,
  );
  const { interval, mode } = setting;
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
  if (candles.status === 'loading') body = <Skeleton data-testid="dk-chart-skeleton" className="dk-chart-skeleton bg-field" />;
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
    <Tabs
      value={tab}
      onValueChange={(value) => setTab(value as 'chart' | 'info')}
      data-testid="dk-chart"
      className="dk-panel dk-chart"
      ref={panel}
    >
      <TabsList divider className="dk-tabs">
        <TabsTab value="chart">{t('Chart')}</TabsTab>
        <TabsTab value="info">{t('Info')}</TabsTab>
      </TabsList>
      <TabsPanel value="chart" className="dk-chart-body">
        <div className="dk-chart-bar">
          <div className="dk-chips" role="group" aria-label={t('Chart intervals')}>
            {CHART_INTERVALS.map((id) => (
              <button key={id} type="button" aria-pressed={interval === id} onClick={() => setSetting({ ...setting, interval: id })}>
                {intervalLabel(id)}
              </button>
            ))}
            <Menu>
              <MenuTrigger className="dk-more" data-active={moreActive || undefined}>
                {moreActive ? intervalLabel(interval) : t('More intervals')}
                <span aria-hidden="true"> ▾</span>
              </MenuTrigger>
              <MenuContent align="start">
                {MORE_INTERVALS.map((id) => (
                  <MenuItem key={id} onClick={() => setSetting({ ...setting, interval: id })}>
                    {intervalLabel(id)}
                  </MenuItem>
                ))}
              </MenuContent>
            </Menu>
          </div>
          <div className="dk-chips dk-chips--right">
            <div role="group" className="dk-chips" aria-label={t('Chart style')}>
              <button type="button" aria-pressed={mode === 'candles'} onClick={() => setSetting({ ...setting, mode: 'candles' })}>
                {t('Candles')}
              </button>
              <button type="button" aria-pressed={mode === 'line'} onClick={() => setSetting({ ...setting, mode: 'line' })}>
                {t('Line')}
              </button>
            </div>
            <button type="button" className="dk-icon-btn" aria-label={full ? t('Exit full screen') : t('Full screen')} onClick={toggleFull}>
              {full ? <Minimize2 size={16} aria-hidden="true" /> : <Maximize2 size={16} aria-hidden="true" />}
            </button>
          </div>
        </div>
        <div className="dk-chart-canvas">{body}</div>
      </TabsPanel>
      <TabsPanel value="info" className="dk-chart-body">
        <div data-testid="dk-info" className="dk-info">
          <h2>{t('Market rules')}</h2>
          <MarketRulesList market={market} />
          <p>{t('Fee rule')}</p>
        </div>
      </TabsPanel>
    </Tabs>
  );
});
