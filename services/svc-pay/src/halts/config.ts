import { parseOwnerIntegerEnv } from '../fee-bps-env.js';

/**
 * AUTO-TRIP CONFIG. There is NO default count. Unset, blank, zero, negative or
 * non-integer = auto-trip is OFF (`failures: null`), and `payHalts.operatorStatus`
 * reports `autoTrip.enabled: false` so nobody believes a runaway loop would stop
 * on its own. Setting a count is a business decision the owner makes.
 */
export interface PayHaltAutoTripConfig {
  /** Consecutive failures that set one merchant or user halt, or null when that counter is disarmed. */
  readonly failures: number | null;
  /**
   * Consecutive rail-health failures across every merchant on one rail, or null
   * when that counter is disarmed. Unset does not copy `failures`.
   */
  readonly railFailures: number | null;
}

export const PAY_HALT_AUTOTRIP_ENV = 'PAY_HALT_AUTOTRIP_FAILURES';
export const PAY_HALT_AUTOTRIP_RAIL_ENV = 'PAY_HALT_AUTOTRIP_RAIL_FAILURES';

export function loadHaltAutoTripConfig(env: Record<string, string | undefined>): PayHaltAutoTripConfig {
  const parsed = parseOwnerIntegerEnv(env[PAY_HALT_AUTOTRIP_ENV]);
  const rail = parseOwnerIntegerEnv(env[PAY_HALT_AUTOTRIP_RAIL_ENV]);
  return {
    failures: parsed !== null && parsed >= 1 ? parsed : null,
    railFailures: rail !== null && rail >= 1 ? rail : null,
  };
}
