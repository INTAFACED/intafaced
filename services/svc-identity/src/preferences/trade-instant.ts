/**
 * Instant placement on the trading desk (`trade.instant`, J-charts-desk-14 #6): on only with the agreement's version and the
 * moment it was accepted; off clears both. The shape lives in `@intafaced/contracts/trade-instant-preferences` so the
 * customer app and this door check the same record. It is a desk setting only: no authorisation or money path reads it,
 * and every order it sends still passes the trade service's own checks.
 */
import { TRADE_INSTANT_NAMESPACE, tradeInstantValueSchema, type TradeInstantValue } from '@intafaced/contracts/trade-instant-preferences';
import { PREFERENCES_VALUE_INVALID } from './trade-views.js';

export { TRADE_INSTANT_NAMESPACE };
export type { TradeInstantValue };

/** Strict: on without the current agreement and its time, off with either left behind, or an unknown field is refused. */
export function parseTradeInstant(value: unknown): TradeInstantValue {
  const parsed = tradeInstantValueSchema.safeParse(value);
  if (!parsed.success) {
    const error = new Error(PREFERENCES_VALUE_INVALID);
    (error as Error & { code: string }).code = PREFERENCES_VALUE_INVALID;
    throw error;
  }
  return parsed.data;
}
