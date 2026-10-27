import type { LedgerClient } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { createConversionInventory } from '../conversion/inventory.js';
import type { MerchantControlsMode } from '../control/mode.js';
import { composeGuards, type PayGuards } from './guards.js';
import { createCustodyPolicyGuards, type CustodyPolicyMode } from '../custody/policy/guards.js';
import { createWithdrawalLimitGuards, type KycTierOf } from '../limits/guards.js';
import type { LimitOverrideOf } from '../limits/identity-override.js';
import type { LimitSource } from '../limits/source.js';
import { createW1ControlGuards } from './slots/w1-control.js';
import { createW5HaltsGuards } from './slots/w5-halts.js';
import { createW6ConversionGuards } from './slots/w6-conversion.js';
import { createW9ScreeningGuards } from './slots/w9-screening.js';
import type { ScreeningGuardDeps } from '../screening/guard.js';
import { createW10B2bRampGuards } from './slots/w10-b2b-ramp.js';
import { createRcMerchant08CategoryGuards } from './slots/rc-merchant-08-category.js';

/**
 * The one place the guard slots are composed (W0 owns this file; streams edit
 * only their own slot file).
 *
 * ORDER IS A SAFETY DECISION. Halts run first (cheapest refusal, nothing else
 * should be consulted while a scope is stopped), then the business category
 * (RC-merchant-08: a read, no lock, new intake only), then screening, then the
 * per-customer withdrawal limits (D-148; one advisory lock, taken after the
 * treasury lock), then the
 * per-merchant control room (caps take row locks, so they come last and hold
 * them for the shortest time), then the conversion and B2B-ramp slots, which
 * only matter on their own paths.
 */
export function buildPayGuards(deps: {
  sql: Sql;
  ledger?: LedgerClient;
  merchantControls?: MerchantControlsMode;
  kycTierOf?: KycTierOf;
  /** A founder's override for the customer and asset (J-ops-console-04 #12). */
  limitOverrideOf?: LimitOverrideOf;
  /** Where the owner-set withdrawal figures live. Omitted: the retired environment source (tests). */
  limitSource?: LimitSource;
  /**
   * W-custody-ops-07 policy guard. The boot passes `loadCustodyPolicyMode(process.env)`, which defaults to `required`.
   * Omitted only by in-process tests that build guards without a policy table in play; they get no policy guard.
   */
  custodyPolicyMode?: CustodyPolicyMode;
  /** The W9 screener. Omitted: none is connected and every custodial send is refused as unavailable. */
  screening?: Partial<Omit<ScreeningGuardDeps, 'sql'>>;
}): PayGuards {
  return composeGuards(
    createW5HaltsGuards({
      sql: deps.sql,
      ledger: deps.ledger,
      conversionInventory: createConversionInventory(deps.sql, deps.ledger),
    }),
    createRcMerchant08CategoryGuards(deps),
    createW9ScreeningGuards({ ...deps, ...deps.screening }),
    createWithdrawalLimitGuards({ sql: deps.sql, tierOf: deps.kycTierOf, overrideOf: deps.limitOverrideOf, source: deps.limitSource }),
    createCustodyPolicyGuards({ sql: deps.sql, mode: deps.custodyPolicyMode ?? 'off' }),
    createW1ControlGuards(deps),
    createW6ConversionGuards(deps),
    createW10B2bRampGuards(deps),
  );
}
