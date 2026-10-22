import { memo, useMemo } from 'react';
import { usePreferences } from '../../shared/preferences';
import { PriceChart } from '../trade/chart/PriceChart';
import { CHART_INTERVALS, MORE_INTERVALS, useChartCandles, type ChartInterval } from '../trade/chart/candles';
import { zoneName } from '../trade/desk/time';
import type { DeskMarket } from '../trade/desk/market';
import { chartsCopy } from './copy';
import { Menu, MenuContent, MenuItem, MenuTrigger, refusalCopy, Skeleton, StateBlock } from './deps';
import { isStreamInterval, mergeLive, useCandleStream, type OpenSocket } from './live-candles';
import { intervalLabel, type ChartMode } from './workbench';
import { useNow } from '../trade/desk/hooks';

export interface WidgetProps {
  market: DeskMarket;
  interval: ChartInterval;
  mode: ChartMode;
  onInterval: (interval: ChartInterval) => void;
  onMode: (mode: ChartMode) => void;
  /** Tests hand in a socket; the page uses the browser's. */
  openSocket?: OpenSocket;
}

/**
 * The market chart widget: the polled history with the live bar laid over it, the interval and style controls,
 * and one line that says which way the chart is being fed. It holds no state of its own: the workbench does.
 */
export const MarketChartWidget = memo(function MarketChartWidget({ market, interval, mode, onInterval, onMode, openSocket }: WidgetProps) {
  const { t } = chartsCopy.useCopy();
  const { timeZone } = usePreferences();
  const polled = useChartCandles(market.symbol, interval);
  const stream = useCandleStream(market.symbol, interval, openSocket);
  const now = useNow(2_000);
  const candles = useMemo(
    () => (polled.status === 'ready' ? mergeLive(polled.data, stream.mode === 'stream' ? stream.live : null) : null),
    [polled, stream],
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
      <PriceChart
        candles={candles ?? polled.data}
        mode={mode}
        interval={interval}
        resetKey={`${market.symbol}:${interval}`}
        tickSize={market.tickSize}
        orderLines={[]}
        fills={[]}
        timeZone={zoneName(timeZone)}
        labels={labels}
      />
    );

  const moreActive = (MORE_INTERVALS as readonly string[]).includes(interval);
  const note = stream.mode === 'stream' ? t('Feed stream') : isStreamInterval(interval) ? t('Feed poll') : t('Feed poll interval');
  const seconds = polled.status === 'ready' ? Math.max(0, Math.round((now - polled.asOf) / 1000)) : null;
  return (
    <section className="cw" aria-label={t('Chart of {pair}', { pair: market.symbol })} data-feed={stream.mode}>
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
          <button type="button" aria-pressed={mode === 'candles'} onClick={() => onMode('candles')}>
            {t('Candles')}
          </button>
          <button type="button" aria-pressed={mode === 'line'} onClick={() => onMode('line')}>
            {t('Line')}
          </button>
        </div>
      </div>
      <div className="cw-canvas">{body}</div>
      <p className="cw-feed" data-testid="chart-feed">
        {note}
        {stream.mode === 'poll' && seconds !== null && <> {t('Feed age', { seconds: String(seconds) })}</>}
      </p>
    </section>
  );
});
