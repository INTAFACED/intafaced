import type { Sql } from 'postgres';
import type { PartialPayGuards } from '../guards.js';
import { createControlGuards } from '../../control/guards.js';
import { parseMerchantControlsMode, type MerchantControlsMode } from '../../control/mode.js';
import type { SettlementBookReader } from '../../settlement-book.js';

/**
 * Guard slot for W1 merchant control room (caps, tiers, pricing, maker-checker).
 *
 * Owned by that workstream alone, built from code under `services/svc-pay/src/control/**`.
 * Caps, tiers, pricing snapshots and payout maker-checker; nothing unconfigured is
 * defaulted. A hook refuses by throwing a typed error; see seams/guards.ts.
 */
export function createW1ControlGuards(deps: {
  sql: Sql;
  merchantControls?: MerchantControlsMode;
  ledger?: SettlementBookReader;
}): PartialPayGuards {
  // PAY_MERCHANT_CONTROLS=required outside exact dev/test. Unset, blank and off
  // throw at boot unless APP_ENV is exactly dev or test (then they mean off).
  const mode = deps.merchantControls ?? parseMerchantControlsMode(process.env);
  return createControlGuards({ sql: deps.sql, mode, ledger: deps.ledger });
}
