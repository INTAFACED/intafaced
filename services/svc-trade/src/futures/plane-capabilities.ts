/**
 * One read of the trade-plane switches.
 *
 * Futures orders refuse with `trade.futures_disabled` when `TRADE_FUTURES_ENABLED`
 * is off (`spot/risk.ts`). This is that same flag: unset, blank, and "false"
 * stay off. Spot follows `TRADE_SPOT_ENABLED`, which defaults on. Neither
 * function invents a second switch.
 */
export const FUTURES_DISABLED = 'trade.futures_disabled' as const;
export const SPOT_DISABLED = 'trade.spot_disabled' as const;

export interface PlaneState {
  readonly enabled: boolean;
  readonly reason?: typeof FUTURES_DISABLED | typeof SPOT_DISABLED;
}

export interface TradePlanes {
  readonly spot: PlaneState;
  readonly futures: PlaneState;
}

/** Same truthy set as `env.ts` for `TRADE_FUTURES_ENABLED`. Unset stays off. */
export function futuresFlagOn(raw: string | boolean | undefined): boolean {
  if (typeof raw === 'boolean') return raw;
  if (raw == null) return false;
  return ['1', 'true', 'on', 'yes'].includes(raw.trim().toLowerCase());
}

/** Same rule as `env.ts` for `TRADE_SPOT_ENABLED`. Unset stays on. */
export function spotFlagOn(raw: string | boolean | undefined): boolean {
  if (typeof raw === 'boolean') return raw;
  if (raw == null || raw.trim() === '') return true;
  return !['0', 'false', 'off', 'no'].includes(raw.trim().toLowerCase());
}

export function readTradePlanes(env: NodeJS.ProcessEnv = process.env): TradePlanes {
  const futuresOn = futuresFlagOn(env.TRADE_FUTURES_ENABLED);
  const spotOn = spotFlagOn(env.TRADE_SPOT_ENABLED);
  return {
    spot: spotOn ? { enabled: true } : { enabled: false, reason: SPOT_DISABLED },
    futures: futuresOn ? { enabled: true } : { enabled: false, reason: FUTURES_DISABLED },
  };
}
