// volt-room: /trade/analytics/:pair
import { useMemo, useState } from 'react';
import { MonitorTemplate } from '@intafaced/ui/lit/templates';
import type { RoomState } from '@intafaced/ui/lit/templates';
import { useResource } from '../../../shared/resource';
import { useSession } from '../../session';
import { marketAnalyticsCopy } from './market-analytics-copy';
import { marketAnalyticsSchema } from '@intafaced/contracts/trade-market-analytics';
import { venueAnalyticsReadSchema } from '@intafaced/contracts/trade-venue-door';
import { VENUE_DOOR_OFF } from '../../../data/venue-market-states';

/**
 * Market analytics, /trade/analytics/:pair (SP-markets-data-03 b; J-cex-spot-14 #9), on the monitor template. When the
 * user-venue door is on, figures come from `GET /api/v1/venue/analytics?symbol=&window=`, computed on read from the
 * venue's public trade tape; only when the door refuses `trade.user_venue_off` does the room read our own engine's
 * `GET /api/v1/analytics/:symbol?window=`. A blank window is refused by the service; the room always names one.
 */

const analyticsSchema = marketAnalyticsSchema;

const WINDOWS = ['5m', '1h', '24h'] as const;
type Window = (typeof WINDOWS)[number];
const utc = (iso: string) => iso.slice(0, 16).replace('T', ' ');

/** "BTC-USDT" from the address, as "BTC/USDT". */
export function symbolOf(pair: string): string {
  return pair.toUpperCase().replace(/[-_]/, '/');
}

/** "BTC/USDC" or "BTC-USDC" as the venue symbol "BTC-USDC". */
const venueSymbolOf = (pair: string): string => pair.toUpperCase().replace(/[/_]/g, '-');

export function MarketAnalyticsRoom({ pair }: { pair: string }) {
  const { t } = marketAnalyticsCopy.useCopy();
  const { api } = useSession();
  const symbol = symbolOf(pair);
  const venueSymbol = venueSymbolOf(pair);
  const base = symbol.split('/')[0] ?? symbol;
  const [window, setWindow] = useState<Window>('1h');
  const read = useResource(async (signal) => {
    const venue = await api.rest('/venue/analytics', venueAnalyticsReadSchema, { query: { symbol: venueSymbol, window }, signal });
    if (venue.ok || venue.code !== VENUE_DOOR_OFF) return venue;
    return api.rest(`/analytics/${encodeURIComponent(symbol)}`, analyticsSchema, { query: { window }, signal });
  }, `market-analytics:${symbol}:${window}`);

  const state: RoomState = useMemo(() => {
    const r = read.resource;
    if (r.status === 'loading') return { kind: 'loading' };
    if (r.status === 'failed') {
      const code = r.failure.code ?? '';
      if (code === 'trade.market_not_found' || code === 'BadSymbol' || code === 'trade.venue.not_offered')
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
