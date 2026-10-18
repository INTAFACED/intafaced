import type { Sql } from 'postgres';
import type { PartialPayGuards } from '../guards.js';
import { createControlGuards } from '../../control/guards.js';
import { resolveMerchantControlsMode, type MerchantControlsMode } from '../../control/mode.js';
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
  // PAY_MERCHANT_CONTROLS=off|required. Unset or `off` outside an explicit dev or test
  // APP_ENV, and any other value, throws at boot: the controls are never silently off.
  const mode = deps.merchantControls ?? resolveMerchantControlsMode(process.env.PAY_MERCHANT_CONTROLS, process.env.APP_ENV);
  return createControlGuards({ sql: deps.sql, mode, ledger: deps.ledger });
}
