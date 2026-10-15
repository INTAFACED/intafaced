import { parseOwnerIntegerEnv } from '../fee-bps-env.js';

/**
 * AUTO-TRIP CONFIG. There is NO default count. Unset, blank, zero, negative or
 * non-integer = auto-trip is OFF (`failures: null`), and `payHalts.operatorStatus`
 * reports `autoTrip.enabled: false` so nobody believes a runaway loop would stop
 * on its own. Setting a count is a business decision the owner makes.
 */
export interface PayHaltAutoTripConfig {
  /** Consecutive failures that set the halt, or null when auto-trip is disabled. */
  readonly failures: number | null;
}

export const PAY_HALT_AUTOTRIP_ENV = 'PAY_HALT_AUTOTRIP_FAILURES';

export function loadHaltAutoTripConfig(env: Record<string, string | undefined>): PayHaltAutoTripConfig {
  const parsed = parseOwnerIntegerEnv(env[PAY_HALT_AUTOTRIP_ENV]);
  return { failures: parsed !== null && parsed >= 1 ? parsed : null };
}
