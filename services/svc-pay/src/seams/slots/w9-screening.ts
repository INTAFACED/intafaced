import type { Sql } from 'postgres';
import { createScreeningGuards, type ScreeningGuardDeps } from '../../screening/guard.js';
import type { PartialPayGuards } from '../guards.js';

/**
 * Guard slot for W9 screening of a custodial send.
 *
 * A missing result, an unknown category, a blank sanctions list, or a screener
 * that is down or silent is unavailable, not clear. The send is refused before
 * the ledger payout or withdrawal hold. No supplier is wired here: Phantom has
 * not named one, and this slot does not invent list contents.
 */
export function createW9ScreeningGuards(deps: { sql: Sql } & Partial<Omit<ScreeningGuardDeps, 'sql'>>): PartialPayGuards {
  return createScreeningGuards(deps);
}
