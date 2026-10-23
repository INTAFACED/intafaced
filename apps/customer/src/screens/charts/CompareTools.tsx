/**
 * Compare, snapshot and export for one chart. Compared markets are lines read at the chart's own interval, on a scale
 * of their own (left) or, in percent mode, rebased with the chart to the same start. How many may be added is the
 * owner's compare cap: a blank cap refuses every add. Snapshot is a PNG of the chart at its size; the link names the
 * market, interval and style only; a public page is refused because no publishing store exists.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Candle } from '../../data/types';
import { usePreferences } from '../../shared/preferences';
import { useChartCandles, type ChartInterval } from '../trade/chart/candles';
import { toLinePoint } from '../trade/chart/chart-data';
import type { DeskMarket } from '../trade/desk/market';
import { zoneName } from '../trade/desk/time';
import { barsCsv, chartLink, fileStem, visibleBars } from './chart-files';
import type { ChartHost, ChartSeries } from './chart-host';
import type { ChartStyle } from './chart-style';
import { chartsCopy } from './copy';
import { OWNER_VALUE_UNSET, ownerValue, useChartOwnerValues } from './owner-values';

const COMPARE_TOKENS = ['--if-ma-1', '--if-ma-2', '--if-ma-3'] as const;
export const PUBLISH_UNAVAILABLE = 'trade.chart.publish_unavailable' as const;

/** One compared market: its candles at the chart's interval, drawn as a line; it reports how it went. */
function CompareLine({
  host,
  symbol,
  interval,
  token,
  percent,
  onState,
}: {
  host: ChartHost;
  symbol: string;
  interval: ChartInterval;
  token: string;
  percent: boolean;
  onState: (symbol: string, state: 'loading' | 'ready' | 'empty' | 'error') => void;
}) {
  const read = useChartCandles(symbol, interval);
  const series = useRef<ChartSeries | null>(null);
  useEffect(() => {
    const color = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
    const line = host.chart.addSeries(host.lib.LineSeries, { color, lineWidth: 2, priceLineVisible: false, title: symbol }, 0);
    series.current = line;
    return () => {
      series.current = null;
      try {
        host.chart.removeSeries(line);
      } catch {
        /* the chart was already removed with its series */
      }
    };
  }, [host, symbol, token]);
  useEffect(() => {
    series.current?.applyOptions({ priceScaleId: percent ? 'right' : 'left' });
  }, [percent, host]);
  useEffect(() => {
    if (read.status === 'ready') series.current?.setData(read.data.map(toLinePoint));
    else series.current?.setData([]);
    onState(
      symbol,
      read.status === 'ready' ? 'ready' : read.status === 'empty' ? 'empty' : read.status === 'loading' ? 'loading' : 'error',
    );
  }, [read, symbol, onState, host]);
  return null;
}

export function CompareTools({
  host,
  market,
  markets,
  interval,
  style,
  bars,
}: {
  host: ChartHost | null;
  market: DeskMarket;
  markets: readonly DeskMarket[];
  interval: ChartInterval;
  style: ChartStyle;
  bars: readonly Candle[];
}) {
  const { t } = chartsCopy.useCopy();
  const { timeZone } = usePreferences();
  const owner = useChartOwnerValues(market.symbol);
  const cap = ownerValue(owner, 'compareCap');
  const [added, setAdded] = useState<string[]>([]);
  const [states, setStates] = useState<Record<string, string>>({});
  const [percent, setPercent] = useState(false);
  const [pick, setPick] = useState('');
  const [note, setNote] = useState<{ code?: string; text: string } | null>(null);
  const others = useMemo(
    () => markets.filter((m) => m.symbol !== market.symbol && !added.includes(m.symbol)),
    [markets, market.symbol, added],
  );
  const onState = useMemo(
    () => (symbol: string, state: string) => setStates((now) => (now[symbol] === state ? now : { ...now, [symbol]: state })),
    [],
  );

  // Percent mode rebases the chart's own scale; compared lines join it there.
  useEffect(() => {
    if (!host) return;
    host.element.dataset.scale = percent ? 'percent' : 'price';
    host.chart.applyOptions({
      rightPriceScale: { mode: percent ? 2 : 0 },
      leftPriceScale: { visible: !percent && added.length > 0, mode: 0 },
    });
  }, [host, percent, added.length]);

  const add = () => {
    const symbol = pick || others[0]?.symbol;
    if (!symbol) return;
    if (!cap.ok) {
      setNote({
        code: OWNER_VALUE_UNSET,
        text:
          cap.why === 'unset' ? t('Compare cap unset') : cap.why === 'loading' ? t('Compare cap loading') : t('Compare cap unavailable'),
      });
      return;
    }
    if (added.length >= cap.value) {
      setNote({ code: 'trade.chart.compare_cap_reached', text: t('Compare cap reached', { cap: String(cap.value) }) });
      return;
    }
    setNote(null);
    setAdded((now) => [...now, symbol]);
    setPick('');
  };

  const download = (name: string, href: string) => {
    const a = document.createElement('a');
    a.href = href;
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
  };
  const snapshot = () => {
    if (!host) return;
    download(`${fileStem(market.symbol, interval)}.png`, host.chart.takeScreenshot().toDataURL('image/png'));
  };
  const link = chartLink(window.location.origin, market.symbol, interval, style);
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setNote({ text: t('Link copied', { link }) });
    } catch {
      setNote({ text: t('Link to copy', { link }) });
    }
  };
  const exportBars = () => {
    const range = host?.chart.timeScale().getVisibleLogicalRange() ?? null;
    const shown = visibleBars(bars, range);
    const csv = barsCsv(shown, market.symbol, interval, zoneName(timeZone) ?? Intl.DateTimeFormat().resolvedOptions().timeZone);
    download(`${fileStem(market.symbol, interval)}.csv`, URL.createObjectURL(new Blob([csv], { type: 'text/csv' })));
  };

  return (
    <div className="cw-bar cw-bar--options cw-compare" role="group" aria-label={t('Compare and share')}>
      <label className="cw-select cw-select--inline">
        <span>{t('Compare with')}</span>
        <select value={pick || others[0]?.symbol || ''} onChange={(event) => setPick(event.target.value)}>
          {others.map((m) => (
            <option key={m.symbol} value={m.symbol}>
              {m.symbol}
            </option>
          ))}
        </select>
      </label>
      <button type="button" className="cw-option" onClick={add} disabled={others.length === 0}>
        {t('Add to chart')}
      </button>
      <label className="cw-check">
        <input type="checkbox" checked={percent} onChange={(event) => setPercent(event.target.checked)} />
        <span>{t('Percent')}</span>
      </label>
      {added.length > 0 && (
        <ul className="cw-compare-list" aria-label={t('Compared markets')}>
          {added.map((symbol, i) => (
            <li key={symbol} data-state={states[symbol] ?? 'loading'}>
              <span>{symbol}</span>
              {states[symbol] === 'empty' && <span>{t('Compare no candles')}</span>}
              {states[symbol] === 'error' && <span>{t('Compare error')}</span>}
              <button
                type="button"
                onClick={() => setAdded((now) => now.filter((s) => s !== symbol))}
                aria-label={t('Remove {symbol}', { symbol })}
              >
                {t('Remove')}
              </button>
              {host && (
                <CompareLine
                  host={host}
                  symbol={symbol}
                  interval={interval}
                  token={COMPARE_TOKENS[i % COMPARE_TOKENS.length]!}
                  percent={percent}
                  onState={onState}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      <span className="cw-compare-actions">
        <button type="button" className="cw-option" onClick={snapshot} disabled={!host}>
          {t('Snapshot')}
        </button>
        <button type="button" className="cw-option" onClick={() => void copyLink()}>
          {t('Copy link')}
        </button>
        <button type="button" className="cw-option" onClick={() => window.print()}>
          {t('Print')}
        </button>
        <button
          type="button"
          className="cw-option"
          onClick={exportBars}
          disabled={bars.length === 0}
          title={bars.length === 0 ? t('Export no bars') : undefined}
        >
          {t('Export bars')}
        </button>
        <button type="button" className="cw-option" onClick={() => setNote({ code: PUBLISH_UNAVAILABLE, text: t('Publish refused') })}>
          {t('Public page')}
        </button>
      </span>
      {note && (
        <p className="cw-note" role="status" data-testid="compare-note" data-code={note.code}>
          {note.text}
        </p>
      )}
    </div>
  );
}
