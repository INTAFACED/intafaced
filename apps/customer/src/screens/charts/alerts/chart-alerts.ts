/**
 * Which alerts the chart draws (J-charts-desk-09 #5): the person's own open price alerts (active or stopped) on the market
 * the chart shows. An alert's market is matched by the listing's own id behind the chart's symbol, never by its spelling.
 */
import type { PriceAlert } from '../../notifications/notify-api';
import type { AlertMarket } from '../../notifications/use-alerts';

export const ALERTS_PAGE = '/notifications?view=alerts';

export function alertsOnMarket(
  alerts: readonly PriceAlert[],
  markets: readonly AlertMarket[],
  symbol: string,
  userId: string | null,
): PriceAlert[] {
  const market = markets.find((row) => row.label === symbol);
  if (!market || !userId) return [];
  return alerts.filter(
    (alert) =>
      alert.userId === userId &&
      alert.kind === 'price' &&
      alert.marketId === market.id &&
      (alert.status === 'active' || alert.status === 'stopped'),
  );
}
