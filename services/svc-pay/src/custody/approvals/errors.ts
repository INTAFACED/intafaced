import { TRPCError } from '@intafaced/contracts';

export type CustodyApprovalErrorCode =
  | 'custody_approval.quorum_unset'
  | 'custody_approval.executor_unwired'
  | 'custody_approval.conflict'
  | 'custody_approval.not_found'
  | 'custody_approval.not_pending'
  | 'custody_approval.expired'
  | 'custody_approval.hash_mismatch'
  | 'custody_approval.initiator_cannot_decide'
  | 'custody_approval.approver_not_registered'
  | 'custody_approval.wrong_kind'
  | 'custody_approval.approver_unknown'
  | 'custody_approval.list_limit_unset';

const KIND: Record<CustodyApprovalErrorCode, TRPCError['code']> = {
  'custody_approval.quorum_unset': 'PRECONDITION_FAILED',
  'custody_approval.executor_unwired': 'PRECONDITION_FAILED',
  'custody_approval.conflict': 'CONFLICT',
  'custody_approval.not_found': 'NOT_FOUND',
  'custody_approval.not_pending': 'CONFLICT',
  'custody_approval.expired': 'CONFLICT',
  'custody_approval.hash_mismatch': 'CONFLICT',
  'custody_approval.initiator_cannot_decide': 'FORBIDDEN',
  'custody_approval.approver_not_registered': 'FORBIDDEN',
  'custody_approval.wrong_kind': 'BAD_REQUEST',
  'custody_approval.approver_unknown': 'NOT_FOUND',
  'custody_approval.list_limit_unset': 'BAD_REQUEST',
};

/** One typed refusal per rule. `code` reaches the client in the message and as `error.data.cause.code`; `detail` is safe to show. */
export class CustodyApprovalError extends Error {
  constructor(
    readonly code: CustodyApprovalErrorCode,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'CustodyApprovalError';
  }
}

/** What an executor throws: `retryable` keeps the task `approved` so the same task runs again; otherwise it ends `failed` with `code`. */
export class CustodyTaskExecutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'CustodyTaskExecutionError';
  }
}

export function custodyApprovalToTrpcError(error: unknown): unknown {
  if (error instanceof TRPCError) return error;
  if (error instanceof CustodyApprovalError) {
    return new TRPCError({ code: KIND[error.code], message: `${error.code}: ${error.message}`, cause: error });
  }
  return error;
}
