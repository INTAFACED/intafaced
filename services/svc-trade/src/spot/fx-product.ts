import type { TradingSchedule } from '@intafaced/contracts';
import { isScheduleOpen, TRADING_SCHEDULES, venueClock } from '@intafaced/contracts/instruments';
import { FOREX_SETTLEMENT_SOCKET } from './forex-settlement.js';
import { TradeError, type Market } from './types.js';

/**
 * R-fx — FX is a separate product from crypto spot.
 *
 * Convert walks the spot matching book. Using that walk as an FX mid mixes
 * products and invents a rate. Holiday `[]` fail-OPEN is not "no holidays".
 * Rail unset is already `socket.forex-settlement`. Named degrade; no second convert.
 */

export const FX_PRODUCT = 'fx' as const;

export const FX_NOT_SPOT_CODE = 'trade.fx_not_spot' as const;
export const FX_HOLIDAY_CALENDAR_UNPUBLISHED_CODE = 'trade.fx_holiday_calendar_unpublished' as const;
export const FX_HOLIDAY_CODE = 'trade.fx_holiday' as const;

export function isFxProduct(market: Pick<Market, 'assetClass'>): boolean {
  return market.assetClass === 'forex';
}

function fxHolidayCalendarPublished(): boolean {
  const schedule = TRADING_SCHEDULES['fx-global'];
  return schedule.kind === 'sessions' && schedule.holidays.length > 0;
}

export type FxNamedDegrade = {
  readonly product: typeof FX_PRODUCT;
  readonly separateFromSpot: true;
  readonly convert: 'refused';
  readonly matching: 'not_spot_book';
  readonly holidayCalendar: {
    readonly published: boolean;
    readonly residual: string;
  };
  readonly rail: {
    readonly published: false;
    readonly socket: typeof FOREX_SETTLEMENT_SOCKET;
  };
};

/** Public posture — convert refused, holiday/rail named, never an invented mid. */
export function fxNamedDegrade(): FxNamedDegrade {
  const holidayPublished = fxHolidayCalendarPublished();
  return {
    product: FX_PRODUCT,
    separateFromSpot: true,
    convert: 'refused',
    matching: 'not_spot_book',
    holidayCalendar: {
      published: holidayPublished,
      residual: holidayPublished
        ? 'owner FX holiday calendar present'
        : 'owner FX holiday calendar unpublished — empty list is not "no holidays"; never invent days',
    },
    rail: { published: false, socket: FOREX_SETTLEMENT_SOCKET },
  };
}

/**
 * Convert / TWAP / POV are crypto-spot surfaces. FX must not inherit them.
 */
export function assertFxSeparateFromSpot(market: Pick<Market, 'symbol' | 'assetClass'>, surface: string): void {
  if (!isFxProduct(market)) return;
  throw new TradeError(
    `${market.symbol} is an FX product — ${surface} is crypto spot (do not invent an FX mid from the spot book)`,
    FX_NOT_SPOT_CODE,
  );
}

/**
 * Holiday named degrade on the FX session path.
 *
 * 1. Venue-local date in the calendar → `trade.fx_holiday` (not weekend close).
 * 2. Session would be open and holidays are empty → unpublished (fail closed).
 * 3. Session shut (weekend / window) → return; caller uses `trade.market_closed`.
 */
export function assertFxHolidayNamedDegrade(market: Pick<Market, 'symbol' | 'assetClass'>, at: Date, schedule: TradingSchedule): void {
  if (!isFxProduct(market)) return;
  if (schedule.kind !== 'sessions') return;

  const clock = venueClock(at, schedule.timezone);
  if (schedule.holidays.includes(clock.date)) {
    throw new TradeError(`${market.symbol} is closed — FX holiday ${clock.date} (named degrade; not a silent zero book)`, FX_HOLIDAY_CODE);
  }
  if (schedule.holidays.length === 0 && isScheduleOpen(schedule, at)) {
    throw new TradeError(
      `${market.symbol} FX holiday calendar unpublished — empty holidays fail OPEN; refuse rather than invent days`,
      FX_HOLIDAY_CALENDAR_UNPUBLISHED_CODE,
    );
  }
}
