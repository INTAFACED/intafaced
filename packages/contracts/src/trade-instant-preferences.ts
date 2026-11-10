/**
 * Instant placement on the trading desk (`trade.instant`, C-trade-dom-02, charts-desk-trade-dom-022; J-charts-desk-14 #6).
 *
 * Off by default. With it off, every order from the DOM ladder, the chart's Buy and Sell, a one-click close or a one-click
 * cancel opens the desk's review first and nothing is sent until the person confirms. With it on, such a click sends at
 * once: the review sheet is skipped, never the order check, the fresh preview or a refusal.
 *
 * Turning it on is stored only with the agreement the person accepted (its version) and the moment they accepted it, so
 * the record always says what was agreed and when. Turning it off clears both. Stored through the identity preferences
 * door (`preferences.get` / `preferences.set`, compare-and-set on `version`), on the account, so every device sees it.
 * An empty record means off.
 */
import { z } from 'zod';

export const TRADE_INSTANT_NAMESPACE = 'trade.instant' as const;

/** The agreement shown before instant placement turns on. A new wording is a new version, accepted again. */
export const TRADE_INSTANT_AGREEMENT = 'instant-placement-v1' as const;

/** An ISO-8601 instant in UTC with milliseconds, as `Date.prototype.toISOString` writes it. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const instant = z
  .string()
  .regex(ISO_INSTANT, 'ISO instant')
  .refine((value) => new Date(value).toISOString() === value, 'a real instant');

export const tradeInstantValueSchema = z.union([
  z.object({ on: z.literal(true), agreement: z.literal(TRADE_INSTANT_AGREEMENT), agreedAt: instant }).strict(),
  z.object({ on: z.literal(false), agreement: z.null(), agreedAt: z.null() }).strict(),
]);
export type TradeInstantValue = z.infer<typeof tradeInstantValueSchema>;

export const TRADE_INSTANT_OFF: TradeInstantValue = { on: false, agreement: null, agreedAt: null };

export const tradeInstantPreferenceSchema = z
  .object({ namespace: z.literal(TRADE_INSTANT_NAMESPACE), version: z.number().int(), value: tradeInstantValueSchema.nullable() })
  .strict();
export type TradeInstantPreference = z.infer<typeof tradeInstantPreferenceSchema>;

/**
 * The client request id of a write: a business key, never random. One id per (person, version read, value written), so a
 * retry after a lost reply returns the first stored result, and a second device writing at the same version meets a
 * version conflict instead of this write's receipt.
 */
export function tradeInstantRequestId(userId: string, ifVersion: number, value: TradeInstantValue): string {
  return `trade-instant:${userId.toLowerCase()}:${ifVersion}:${value.on ? `on:${value.agreedAt}` : 'off'}`;
}
