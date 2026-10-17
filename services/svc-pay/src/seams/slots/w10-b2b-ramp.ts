import type { Sql } from 'postgres';
import type { PartialPayGuards } from '../guards.js';
import { loadB2bRampConfig, type B2bRampEnv } from '../../b2b-ramp/config.js';

/**
 * Guard slot for W10 switched-off B2B ramp.
 *
 * Boot reads the raw env here, because `buildPayGuards` runs before the
 * listener opens. Enabling `pay.b2b_ramp` in staging/prod (or with APP_ENV
 * unset) without a licence attestation throws and the process does not start.
 * Payment hooks stay empty: this line is not intake, and it must not change
 * today's payment, payout or settlement behaviour. The ramp's own routes
 * refuse while the flag is off.
 */
export function createW10B2bRampGuards(deps: { sql: Sql; env?: B2bRampEnv }): PartialPayGuards {
  void deps.sql;
  loadB2bRampConfig(deps.env ?? process.env);
  return {};
}
