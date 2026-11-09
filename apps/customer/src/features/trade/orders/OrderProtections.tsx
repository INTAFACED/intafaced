import { useEffect, useState } from 'react';
import type { RateCostsOutput } from '@intafaced/contracts/api-rate-limits';
import { useSession } from '../../session/session';
import type { FuturesOrderProtections } from '../../../screens/trade/futures/api';
import { useFuturesApi } from '../../../screens/trade/futures/data';
import { readRateCosts } from '../../developers/rate-limits/rate-limits-api';
import { futuresOrdersCopy } from './futures-orders-copy';

/** Whole milliseconds as exact seconds: 60000 is "60", 1500 is "1.5", 400 is "0.4". */
export function secondsOf(ms: number): string {
  const whole = Math.floor(ms / 1000);
  const rest = String(ms % 1000)
    .padStart(3, '0')
    .replace(/0+$/, '');
  return rest ? `${whole}.${rest}` : String(whole);
}

type Read<T> = { status: 'loading' } | { status: 'failed' } | { status: 'ready'; data: T };

/**
 * The order-flow protections on the futures book (J-derivatives-04 step 7), read live: the self-trade mode svc-trade
 * publishes, and the order-rate limit that applies. With no per-market limit set, the edge's own per-address limit is
 * the one in force, and the room says so with its figures; it never reads as unlimited.
 */
export function OrderProtections() {
  const { t } = futuresOrdersCopy.useCopy();
  const { api: client } = useSession();
  const api = useFuturesApi();
  const [protections, setProtections] = useState<Read<FuturesOrderProtections>>({ status: 'loading' });
  const [edge, setEdge] = useState<Read<RateCostsOutput>>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    void api.orderProtections(controller.signal).then((r) => {
      setProtections(r.ok ? { status: 'ready', data: r.data } : { status: 'failed' });
      // The edge's figure is read only when it is the one that applies.
      if (r.ok && r.data.orderRateLimit.perMarket === null)
        void readRateCosts(client, controller.signal).then((e) => setEdge(e.ok ? { status: 'ready', data: e.data } : { status: 'failed' }));
    });
    return () => controller.abort();
  }, [api, client]);

  const selfTrade =
    protections.status === 'loading'
      ? t('protectionsReading')
      : protections.status === 'failed'
        ? t('protectionsUnreadable')
        : protections.data.selfTrade.mode === 'cancel_resting'
          ? t('selfTradeCancelResting')
          : t('selfTradeMode', { mode: protections.data.selfTrade.mode });

  let rate: string;
  if (protections.status !== 'ready') rate = protections.status === 'loading' ? t('protectionsReading') : t('protectionsUnreadable');
  else if (protections.data.orderRateLimit.perMarket !== null) rate = t('rateMarket', { limit: protections.data.orderRateLimit.perMarket });
  else if (edge.status === 'loading') rate = t('rateEdgeReading');
  else if (edge.status === 'failed' || edge.data.address === undefined) rate = t('rateEdgeUnreadable');
  else if (edge.data.address === null) rate = t('rateNone');
  else
    rate = t(edge.data.address.keyedOn === 'client' ? 'rateEdge' : 'rateEdgeShared', {
      max: String(edge.data.address.max),
      // Exact: 1500 ms is 1.5 seconds, never rounded to a figure the edge does not enforce.
      seconds: secondsOf(edge.data.address.windowMs),
    });

  return (
    <section className="orders-note" aria-label={t('protectionsTitle')}>
      <h3>{t('protectionsTitle')}</h3>
      <dl>
        <dt>{t('selfTradeLabel')}</dt>
        <dd>{selfTrade}</dd>
        <dt>{t('rateLabel')}</dt>
        <dd>{rate}</dd>
      </dl>
    </section>
  );
}
