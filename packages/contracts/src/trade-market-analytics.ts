/**
 * svc-trade's market analytics read (`GET /analytics/:symbol`, `services/svc-trade/src/spot/market-analytics.ts`) as the
 * customer's market analytics room reads it: one market's trades over a named window, the aggressor differential (taker
 * buys minus taker sells) and the range. Browser-safe (zod only). Amounts stay strings.
 */
import { z } from 'zod';

export const marketAnalyticsSchema = z.object({
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
