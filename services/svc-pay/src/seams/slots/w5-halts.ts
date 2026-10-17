import type { Sql } from 'postgres';
import type { SettlementBookReader } from '../../settlement-book.js';
import { createHaltGuards } from '../../halts/guards.js';
import { loadTreasuryLimits, loadTreasuryMode } from '../../treasury/config.js';
import { UNWIRED_CONVERSION_INVENTORY, type ConversionInventorySource } from '../../treasury/exposure.js';
import { createTreasuryGuards } from '../../treasury/guards.js';
import { composeGuards, type PartialPayGuards } from '../guards.js';

/**
 * Guard slot for W5 granular halts and treasury exposure.
 *
 * Halts run first (cheapest refusal), then exposure limits. Both are built from
 * code under `services/svc-pay/src/halts/**` and `src/treasury/**`. Halts are
 * always on (no halt set = pass). Auto-trip is not counted here. A rail-health
 * refusal records itself on `PayHaltStore` (one merchant and rail, or one user,
 * plus the rail across merchants when that count is set). The store does not
 * arm a count that is unset. These guards only enforce the halt written when
 * a count is reached. Exposure limits come from
 * the environment with NO defaults. Enforcement is behind
 * `PAY_TREASURY_LIMITS=off|required` (default off; any other value throws here,
 * which fails boot).
 */
export function createW5HaltsGuards(deps: {
  sql: Sql;
  env?: Record<string, string | undefined>;
  /** The conversion path (W6) supplies its own open-inventory reader here. */
  conversionInventory?: ConversionInventorySource;
  /** Settlement-key reader for the personal-withdrawal halt. */
  ledger?: SettlementBookReader;
}): PartialPayGuards {
  const env = deps.env ?? process.env;
  const halts = createHaltGuards({ sql: deps.sql, ledger: deps.ledger });
  const treasury = createTreasuryGuards({
    mode: loadTreasuryMode(env),
    limits: loadTreasuryLimits(env),
    inventory: deps.conversionInventory ?? UNWIRED_CONVERSION_INVENTORY,
  });
  // composeGuards runs `halts` then `treasury` for each hook and normalises anything unexpected to a refusal.
  return composeGuards(halts, treasury);
}
