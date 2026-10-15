import type { Sql } from 'postgres';
import type { PartialPayGuards } from '../guards.js';
import { createControlGuards } from '../../control/guards.js';
import { parseMerchantControlsMode, type MerchantControlsMode } from '../../control/mode.js';

/**
 * Guard slot for W1 merchant control room (caps, tiers, pricing, maker-checker).
 *
 * Owned by that workstream alone, built from code under `services/svc-pay/src/control/**`.
 * Caps, tiers, pricing snapshots and payout maker-checker; nothing unconfigured is
 * defaulted. A hook refuses by throwing a typed error; see seams/guards.ts.
 */
export function createW1ControlGuards(deps: { sql: Sql; merchantControls?: MerchantControlsMode }): PartialPayGuards {
  // PAY_MERCHANT_CONTROLS=off|required, default off; any other value throws at boot.
  const mode = deps.merchantControls ?? parseMerchantControlsMode(process.env.PAY_MERCHANT_CONTROLS);
  return createControlGuards({ sql: deps.sql, mode });
}
