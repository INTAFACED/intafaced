import { TRPCError } from '@intafaced/contracts';

export type WithdrawalApprovalErrorCode =
  | 'withdrawal_approval.policy_unset'
  | 'withdrawal_approval.not_required'
  | 'withdrawal_approval.required'
  | 'withdrawal_approval.conflict'
  | 'withdrawal_approval.not_found'
  | 'withdrawal_approval.not_pending'
  | 'withdrawal_approval.expired'
  | 'withdrawal_approval.initiator_cannot_approve'
  | 'withdrawal_approval.approver_not_eligible'
  | 'withdrawal_approval.eligibility_unavailable'
  | 'withdrawal_approval.eligibility_unwired'
  | 'withdrawal_approval.list_limit_unset'
  | 'withdrawal_approval.amount_invalid'
  | 'withdrawal_approval.insufficient_funds';

const KIND: Record<WithdrawalApprovalErrorCode, TRPCError['code']> = {
  'withdrawal_approval.policy_unset': 'PRECONDITION_FAILED',
  'withdrawal_approval.not_required': 'PRECONDITION_FAILED',
  'withdrawal_approval.required': 'PRECONDITION_FAILED',
  'withdrawal_approval.conflict': 'CONFLICT',
  'withdrawal_approval.not_found': 'NOT_FOUND',
  'withdrawal_approval.not_pending': 'CONFLICT',
  'withdrawal_approval.expired': 'CONFLICT',
  'withdrawal_approval.initiator_cannot_approve': 'FORBIDDEN',
  'withdrawal_approval.approver_not_eligible': 'FORBIDDEN',
  'withdrawal_approval.eligibility_unavailable': 'SERVICE_UNAVAILABLE',
  'withdrawal_approval.eligibility_unwired': 'PRECONDITION_FAILED',
  'withdrawal_approval.list_limit_unset': 'BAD_REQUEST',
  'withdrawal_approval.amount_invalid': 'BAD_REQUEST',
  'withdrawal_approval.insufficient_funds': 'PRECONDITION_FAILED',
};

/** One typed refusal per rule. `code` reaches the client in the message and as `error.data.cause.code`; `detail` is safe to show. */
export class WithdrawalApprovalError extends Error {
  constructor(
    readonly code: WithdrawalApprovalErrorCode,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'WithdrawalApprovalError';
  }
}

export function withdrawalApprovalToTrpcError(error: unknown): unknown {
  if (error instanceof TRPCError) return error;
  if (error instanceof WithdrawalApprovalError) {
    return new TRPCError({ code: KIND[error.code], message: `${error.code}: ${error.message}`, cause: error });
  }
  return error;
}
