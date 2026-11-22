import { useMemo, useState } from 'react';
import { Segmented, StateBlock } from '@intafaced/ui/lit';
import { Skeleton } from '@intafaced/ui/lit/templates';
import type { Position } from '@intafaced/exchange-contract/schemas';
import { usePreferences } from '../../../shared/preferences';
import { fmtPrice } from '../../../data/format';
import type { Loadable } from '../../../data/types';
import { CHART_INTERVALS, useChartCandles, type ChartInterval } from '../chart/candles';
import { PriceChart, type ChartOrderLine } from '../chart/PriceChart';
import { zoneName } from '../desk/time';
import type { FuturesListing } from './api';
import { deskCopy } from './desk-copy';
import { isLive } from './model';

interface Props {
  market: FuturesListing;
  positions: Loadable<Position[]>;
}

/**
 * Candles for the chosen contract with the trader's entry prices drawn as lines (OKX/TradingView position overlay).
 * Entry, mark and liquidation of each live position are also listed under the chart as plain text, because the chart
 * line has only a side colour and no label. No candles from the service means no chart, said plainly.
 */
export function FuturesChart({ market, positions }: Props) {
  const { t } = deskCopy.useCopy();
  const { timeZone } = usePreferences();
  const [interval, setInterval] = useState<ChartInterval>('15m');
  const candles = useChartCandles(market.symbol, interval);
  const mine = useMemo(
    () => (positions.status === 'ready' ? positions.data.filter((p) => isLive(p) && p.symbol === market.symbol) : []),
    [positions, market.symbol],
  );
  const lines = useMemo<ChartOrderLine[]>(
    () => mine.map((p) => ({ price: p.entryPrice, side: p.side === 'long' ? 'buy' : 'sell' })),
    [mine],
  );
  const labels = useMemo(
    () => ({
      buy: t('Side_buy'),
      sell: t('Side_sell'),
      open: t('O'),
      high: t('H'),
      low: t('L'),
      close: t('C'),
      change: t('Change'),
      chart: t('Chart of contract', { contract: market.symbol }),
    }),
    [t, market.symbol],
  );
  const price = (v: string | null) => fmtPrice(v, market.precision.price);
  let body: React.ReactNode;
  if (candles.status === 'loading') body = <Skeleton shape="chart" />;
  else if (candles.status === 'empty' || candles.status === 'refused')
    body = <StateBlock kind="empty" title={t('Chart no candles title')} body={t('Chart no candles reason')} />;
  else if (candles.status === 'error')
    body = <StateBlock kind="error" title={t('Chart error title')} onRetry={candles.retry} retryLabel={t('Try again')} />;
  else
    body = (
      <PriceChart
        candles={candles.data}
        mode="candles"
        interval={interval}
        resetKey={`${market.symbol}:${interval}`}
        tickSize={market.precision.price}
        orderLines={lines}
        fills={[]}
        timeZone={zoneName(timeZone)}
        labels={labels}
      />
    );
  return (
    // The desk template's own Chart region names this panel; a second region of the same name would hide which is which.
    <div className="lt-panel">
      <div className="lt-row">
        <Segmented
          label={t('Chart intervals')}
          value={interval}
          onChange={(value) => setInterval(value)}
          options={CHART_INTERVALS.map((id) => ({ value: id, label: id }))}
        />
      </div>
      <div className="lt-canvas">{body}</div>
      {mine.length > 0 ? (
        <ul aria-label={t('Position lines')} className="lt-list lt-note">
          {mine.map((p) => (
            <li key={p.id ?? p.symbol} className="lt-num">
              {p.side === 'long' ? '▲' : '▼'} {t('Entry line', { price: price(p.entryPrice) })} ·{' '}
              {t('Mark line', { price: price(p.markPrice) })} · {t('Liquidation line', { price: price(p.liquidationPrice) })}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
