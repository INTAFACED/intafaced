import type { WithdrawalRecord } from './withdrawal-reads';

/** svc-pay stores a cancelled withdrawal as failed with this code (`withdrawals/status.ts`). */
const WITHDRAWAL_CANCELED_CODE = 'withdrawal.canceled';

/** Codes that say the way of sending was down or not connected (svc-pay `withdrawals/reasons.ts`, `halts/rail-health.ts`). */
const ROUTE_CODES = new Set([
  'rail.unhealthy',
  'rail.marked_down',
  'rail.health_stale',
  'rail.probe_failed',
  'rail.rpc_unset',
  'rail.sandbox_only',
  'rail.down',
  'rail.unavailable',
  'rail.timeout',
  'rail.auth_failed',
]);

export type FailureWord = 'failRefused' | 'failRoute' | 'failDropped' | 'failOther' | 'failBack' | 'failCanceled' | 'failChecking';

/**
 * A withdrawal's failure code in words, never the code itself (J-wallet-05 #8). Only a row svc-pay marked `failed` gets a
 * reason and the closing sentence: a failed withdrawal sent nothing, and anything held for it was put back before it was marked
 * failed (`withdrawals/status.ts`), or nothing was ever held (a send inside INTAFACED refused before its hold). A row that
 * carries a code but is not failed is a problem still being checked, so it never says the send was refused or the money is
 * back. A code these groups don't name reads the general sentence rather than a guessed reason.
 */
export function failureWords(status: WithdrawalRecord['status'], code: string): readonly FailureWord[] {
  if (code === WITHDRAWAL_CANCELED_CODE) return ['failCanceled'];
  if (status !== 'failed') return ['failChecking'];
  const reason: FailureWord =
    code === 'rail.refused'
      ? 'failRefused'
      : code === 'custody.dropped_by_chain'
        ? 'failDropped'
        : ROUTE_CODES.has(code)
          ? 'failRoute'
          : 'failOther';
  return [reason, 'failBack'];
}
