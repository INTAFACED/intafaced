import type { Sql } from 'postgres';
import { createHaltGuards } from '../../halts/guards.js';
import { loadHaltAutoTripConfig } from '../../halts/config.js';
import { PayHaltStore } from '../../halts/store.js';
import { loadTreasuryLimits } from '../../treasury/config.js';
import { UNWIRED_CONVERSION_INVENTORY, type ConversionInventorySource } from '../../treasury/exposure.js';
import { createTreasuryGuards } from '../../treasury/guards.js';
import { composeGuards, type PartialPayGuards } from '../guards.js';

/**
 * Guard slot for W5 granular halts and treasury exposure.
 *
 * Halts run first (cheapest refusal), then exposure limits. Both are built from
 * code under `services/svc-pay/src/halts/**` and `src/treasury/**`. The auto-trip
 * count and the exposure limits come from the environment with NO defaults; leave
 * them unset and auto-trip is off and every exposure-adding operation is refused.
 */
export function createW5HaltsGuards(deps: {
  sql: Sql;
  env?: Record<string, string | undefined>;
  /** The conversion path (W6) supplies its own open-inventory reader here. */
  conversionInventory?: ConversionInventorySource;
}): PartialPayGuards {
  const env = deps.env ?? process.env;
  const store = new PayHaltStore(deps.sql, loadHaltAutoTripConfig(env));
  const halts = createHaltGuards({ sql: deps.sql, store });
  const treasury = createTreasuryGuards({
    limits: loadTreasuryLimits(env),
    inventory: deps.conversionInventory ?? UNWIRED_CONVERSION_INVENTORY,
  });
  // composeGuards runs `halts` then `treasury` for each hook and normalises anything unexpected to a refusal.
  return composeGuards(halts, treasury);
}
