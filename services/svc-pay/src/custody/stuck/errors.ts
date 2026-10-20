import { TRPCError } from '@intafaced/contracts';

export type CustodyStuckErrorCode =
  | 'rail.crypto'
  | 'stuck.withdrawal_not_found'
  | 'stuck.wallet_not_found'
  | 'stuck.network_unknown'
  | 'stuck.already_linked'
  | 'stuck.not_linked'
  | 'stuck.not_in_flight'
  | 'stuck.nonce_mismatch'
  | 'stuck.threshold_unset'
  | 'stuck.action_differs'
  | 'stuck.action_not_found'
  | 'stuck.replacer_refused'
  | 'stuck.outcome_unknown'
  | 'stuck.cancel_unwired'
  | 'stuck.cancel_refused'
  | 'stuck.reverse_evidence_mismatch'
  | 'stuck.reverse_needs_drop'
  | 'stuck.reverse_exists'
  | 'stuck.reverse_stale'
  | 'stuck.reverse_original_mined'
  | 'stuck.reverse_not_found'
  | 'stuck.second_approver_required'
  | 'stuck.reverse_not_approved'
  | 'stuck.reverse_unwired'
  | 'stuck.reverse_failed';

const KIND: Record<CustodyStuckErrorCode, TRPCError['code']> = {
  'rail.crypto': 'SERVICE_UNAVAILABLE',
  'stuck.withdrawal_not_found': 'NOT_FOUND',
  'stuck.wallet_not_found': 'NOT_FOUND',
  'stuck.network_unknown': 'BAD_REQUEST',
  'stuck.already_linked': 'CONFLICT',
  'stuck.not_linked': 'PRECONDITION_FAILED',
  'stuck.not_in_flight': 'PRECONDITION_FAILED',
  'stuck.nonce_mismatch': 'CONFLICT',
  'stuck.threshold_unset': 'PRECONDITION_FAILED',
  'stuck.action_differs': 'CONFLICT',
  'stuck.action_not_found': 'NOT_FOUND',
  'stuck.replacer_refused': 'PRECONDITION_FAILED',
  'stuck.outcome_unknown': 'SERVICE_UNAVAILABLE',
  'stuck.cancel_unwired': 'SERVICE_UNAVAILABLE',
  'stuck.cancel_refused': 'PRECONDITION_FAILED',
  'stuck.reverse_evidence_mismatch': 'BAD_REQUEST',
  'stuck.reverse_needs_drop': 'PRECONDITION_FAILED',
  'stuck.reverse_exists': 'CONFLICT',
  'stuck.reverse_stale': 'PRECONDITION_FAILED',
  'stuck.reverse_original_mined': 'PRECONDITION_FAILED',
  'stuck.reverse_not_found': 'NOT_FOUND',
  'stuck.second_approver_required': 'FORBIDDEN',
  'stuck.reverse_not_approved': 'PRECONDITION_FAILED',
  'stuck.reverse_unwired': 'SERVICE_UNAVAILABLE',
  'stuck.reverse_failed': 'SERVICE_UNAVAILABLE',
};

/** One typed refusal per rule. `code` reaches the client in the message and as `error.data.cause.code`. */
export class CustodyStuckError extends Error {
  constructor(
    readonly code: CustodyStuckErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CustodyStuckError';
  }
}

export function custodyStuckToTrpcError(error: unknown): unknown {
  if (error instanceof TRPCError) return error;
  if (error instanceof CustodyStuckError) {
    return new TRPCError({ code: KIND[error.code], message: `${error.code}: ${error.message}`, cause: error });
  }
  return error;
}
