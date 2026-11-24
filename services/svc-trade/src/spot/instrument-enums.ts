import type { TradingSchedule } from '@intafaced/contracts';
import { ASSET_CLASSES, isAssetClass, SCHEDULE_KEYS, TRADING_SCHEDULES } from '@intafaced/contracts/instruments';
import { TradeError, type Market } from './types.js';

/**
 * INSTRUMENT ENUM AUTHORITY AT THE ORDER BOUNDARY (D26-P1-T9 / D-S-05).
 *
 * `TRADING_SCHEDULES` and `ASSET_CLASSES` in `@intafaced/contracts` are the sole
 * authorities. Rows arrive as bare casts of Postgres enums (`rows.ts`), so a
 * migration that widens the DB without updating those authorities must refuse
 * here — never throw a TypeError, never default to crypto-24x7.
 *
 * Kept in its own file so forex/options sibling craft (T6/T7) can own
 * `forex-settlement.ts` / `options-listing.ts` without dual-editing this path.
 */

/**
 * Unknown `asset_class` refuses with the permitted set named.
 */
export function assertKnownAssetClass(market: Pick<Market, 'symbol' | 'assetClass'>): void {
  if (isAssetClass(market.assetClass)) return;
  throw new TradeError(
    `${market.symbol} has unknown asset_class (${String(market.assetClass)}); permitted: ${ASSET_CLASSES.join(', ')}`,
    'trade.unknown_asset_class',
  );
}

/**
 * Resolve the schedule table entry, or refuse with `trade.unknown_schedule`.
 *
 * Distinct from `trade.market_closed` (session boundary — retry Monday).
 * Unknown is misconfiguration — bots must not treat it as a weekend.
 */
export function requireTradingSchedule(market: Pick<Market, 'symbol' | 'schedule'>): TradingSchedule {
  // Index through a string map so a drifted DB enum (cast past ScheduleKey) is
  // undefined at runtime rather than a typed-always-present false comfort.
  const schedule = (TRADING_SCHEDULES as Readonly<Record<string, TradingSchedule | undefined>>)[String(market.schedule)];
  if (schedule) return schedule;
  throw new TradeError(
    `${market.symbol} has an unknown trading schedule (${String(market.schedule)}); permitted: ${SCHEDULE_KEYS.join(', ')} — refusing orders`,
    'trade.unknown_schedule',
  );
}
