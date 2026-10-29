import type { WithdrawalRecord } from './withdrawal-reads';

/** svc-pay stores a cancelled withdrawal as failed with this code (`withdrawals/status.ts`). */
const WITHDRAWAL_CANCELED_CODE = 'withdrawal.canceled';

/**
 * A withdrawal's failure code in words, never the code itself (J-wallet-05 #8). svc-pay reverses the hold before it marks a
 * withdrawal failed (`withdrawals/status.ts`), so a failed row's sentence says the amount went back; a code these groups don't
 * name reads the general sentence rather than a guessed reason. A cancel is stored as failed with its own code, and a code on
 * a row that is not failed yet is a refusal still being finished, so neither says the amount went back.
 */
const FAILURE_WORDS: Record<string, 'failRefused' | 'failRoute' | 'failNotSent'> = {
  'rail.refused': 'failRefused',
  'rail.unhealthy': 'failRoute',
  'rail.marked_down': 'failRoute',
  'rail.health_stale': 'failRoute',
  'rail.probe_failed': 'failRoute',
  'rail.rpc_unset': 'failRoute',
  'rail.sandbox_only': 'failRoute',
  'rail.failed': 'failNotSent',
  'rail.not_sent': 'failNotSent',
  'custody.dropped_by_chain': 'failNotSent',
};
export function failureWords(record: Pick<WithdrawalRecord, 'status'> & { failureCode: string }) {
  if (record.failureCode === WITHDRAWAL_CANCELED_CODE) return 'failCanceled';
  if (record.status !== 'failed') return 'failHeld';
  return FAILURE_WORDS[record.failureCode] ?? 'failOther';
}
