import { useMemo, useState } from 'react';
import { z } from 'zod';
import { MonitorTemplate } from '@intafaced/ui/lit/templates';
import type { RoomState } from '@intafaced/ui/lit/templates';
import { useResource } from '../../../shared/resource';
import { useSession } from '../../session/session';
import { marketAnalyticsCopy } from './market-analytics-copy';

/**
 * Market analytics, /trade/analytics/:pair (SP-markets-data-03 b; J-cex-spot-14 #9), on the monitor template. The
 * figures are svc-trade's `GET /api/v1/analytics/:symbol?window=`, computed on each read from the public trade tape:
 * the aggressor differential (taker buys minus taker sells) and the window's trades and range, with the window named.
 * A blank window is refused by the service; the room always names one, and a person picks another.
 */

// hand-declared-ok: the analytics read is svc-trade REST with no shared schema yet (services/svc-trade/src/spot/market-analytics.ts)
const analyticsSchema = z.object({
  symbol: z.string(),
  window: z.enum(['5m', '1h', '24h']),
  from: z.string(),
  to: z.string(),
  trades: z.number(),
  buyTrades: z.number(),
  sellTrades: z.number(),
  buyVolume: z.string(),
  sellVolume: z.string(),
  aggressorDifferential: z.string(),
  high: z.string().nullable(),
  low: z.string().nullable(),
  complete: z.boolean(),
  coveredFrom: z.string().nullable(),
});

const WINDOWS = ['5m', '1h', '24h'] as const;
type Window = (typeof WINDOWS)[number];
const utc = (iso: string) => iso.slice(0, 16).replace('T', ' ');

/** "BTC-USDT" from the address, as "BTC/USDT". */
export function symbolOf(pair: string): string {
  return pair.toUpperCase().replace(/[-_]/, '/');
}

export function MarketAnalyticsRoom({ pair }: { pair: string }) {
  const { t } = marketAnalyticsCopy.useCopy();
  const { api } = useSession();
  const symbol = symbolOf(pair);
  const base = symbol.split('/')[0] ?? symbol;
  const [window, setWindow] = useState<Window>('1h');
  const read = useResource(
    (signal) => api.rest(`/analytics/${encodeURIComponent(symbol)}`, analyticsSchema, { query: { window }, signal }),
    `market-analytics:${symbol}:${window}`,
  );

  const state: RoomState = useMemo(() => {
    const r = read.resource;
    if (r.status === 'loading') return { kind: 'loading' };
    if (r.status === 'failed') {
      const code = r.failure.code ?? '';
      if (code === 'trade.market_not_found' || code === 'BadSymbol')
        return {
          kind: 'refused',
          refusal: { variant: 'refused', title: t('pairUnknownTitle'), body: t('pairUnknownBody'), reference: code },
        };
      if (code === 'trade.analytics_window_unset')
        return {
          kind: 'refused',
          refusal: { variant: 'refused', title: t('windowUnsetTitle'), body: t('windowUnsetBody'), reference: code },
        };
      return {
        kind: 'refused',
        refusal: { variant: 'unreachable', title: t('failedTitle'), body: t('failedBody'), reference: code || undefined },
      };
    }
    return { kind: 'ready' };
  }, [read.resource, t]);

  const data = read.resource.status === 'ready' ? read.resource.data : null;
  const figures = data
    ? [
        <div key="diff" data-testid="analytics-differential">
          <span>{t('differential')}</span>
          <strong>{data.aggressorDifferential}</strong>
          <span>{t('differentialNote', { base })}</span>
        </div>,
        <div key="bought" data-testid="analytics-bought">
          <span>{t('bought')}</span> <strong>{data.buyVolume}</strong>
        </div>,
        <div key="sold" data-testid="analytics-sold">
          <span>{t('sold')}</span> <strong>{data.sellVolume}</strong>
        </div>,
        <div key="trades" data-testid="analytics-trades">
          <span>{t('trades')}</span> <strong>{data.trades}</strong>
          <span>{t('tradesSplit', { buys: String(data.buyTrades), sells: String(data.sellTrades) })}</span>
        </div>,
      ]
    : [];

  return (
    <MonitorTemplate
      title={`${t('title')} · ${symbol}`}
      description={t('description')}
      state={state}
      mode="pro"
      figures={figures}
      actions={
        <div role="group" aria-label={t('window')} data-testid="analytics-windows">
          {WINDOWS.map((w) => (
            <button key={w} type="button" aria-pressed={w === window} onClick={() => setWindow(w)}>
              {t(`window_${w}`)}
            </button>
          ))}
        </div>
      }
      panels={
        data ? (
          <div>
            <p data-testid="analytics-window">
              {t('windowLine', { window: t(`window_${data.window}`), from: utc(data.from), to: utc(data.to) })}
            </p>
            {data.complete ? null : (
              <p data-testid="analytics-partial">{t('partial', { from: utc(data.coveredFrom ?? data.from), to: utc(data.to) })}</p>
            )}
            <p data-testid="analytics-range">
              {t('range')}: {data.high !== null && data.low !== null ? `${data.low} – ${data.high}` : t('rangeNone')}
            </p>
          </div>
        ) : null
      }
      explain={<p>{t('explain')}</p>}
    />
  );
}
