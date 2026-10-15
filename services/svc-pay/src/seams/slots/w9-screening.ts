import type { Sql } from 'postgres';
import type { PartialPayGuards } from '../guards.js';
import { PayScreeningService } from '../../screening/service.js';

/**
 * Guard slot for W9 KYT and name screening.
 *
 * Checks fresh payout execution before the ledger hold. Recovery must finish;
 * capture/refund remain halt-only and acquire no W9 screening locks.
 */
export function createW9ScreeningGuards(deps: { sql: Sql; screening?: PayScreeningService }): PartialPayGuards {
  const screening = deps.screening ?? new PayScreeningService(deps);
  return { beforePayoutExecute: (ctx) => screening.beforePayoutExecute(ctx) };
}
