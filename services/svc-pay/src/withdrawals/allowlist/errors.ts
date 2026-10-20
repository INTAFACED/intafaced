import { TRPCError } from '@intafaced/contracts';

export type AllowlistErrorCode =
  | 'pay.destination_not_allowlisted'
  | 'allowlist.quorum_unset'
  | 'allowlist.conflict'
  | 'allowlist.not_found'
  | 'allowlist.not_waiting'
  | 'allowlist.hash_mismatch'
  | 'allowlist.requester_cannot_approve'
  | 'allowlist.approver_not_eligible'
  | 'allowlist.eligibility_unavailable'
  | 'allowlist.eligibility_unwired'
  | 'allowlist.address_invalid'
  | 'allowlist.address_listed'
  | 'allowlist.label_taken'
  | 'allowlist.entry_not_found'
  | 'allowlist.entry_not_removable'
  | 'allowlist.mode_already_off'
  | 'allowlist.mode_already_on'
  | 'allowlist.policy_unchanged'
  | 'allowlist.list_limit_unset';

const KIND: Record<AllowlistErrorCode, TRPCError['code']> = {
  'pay.destination_not_allowlisted': 'FORBIDDEN',
  'allowlist.quorum_unset': 'PRECONDITION_FAILED',
  'allowlist.conflict': 'CONFLICT',
  'allowlist.not_found': 'NOT_FOUND',
  'allowlist.not_waiting': 'CONFLICT',
  'allowlist.hash_mismatch': 'CONFLICT',
  'allowlist.requester_cannot_approve': 'FORBIDDEN',
  'allowlist.approver_not_eligible': 'FORBIDDEN',
  'allowlist.eligibility_unavailable': 'SERVICE_UNAVAILABLE',
  'allowlist.eligibility_unwired': 'PRECONDITION_FAILED',
  'allowlist.address_invalid': 'BAD_REQUEST',
  'allowlist.address_listed': 'CONFLICT',
  'allowlist.label_taken': 'CONFLICT',
  'allowlist.entry_not_found': 'NOT_FOUND',
  'allowlist.entry_not_removable': 'CONFLICT',
  'allowlist.mode_already_off': 'CONFLICT',
  'allowlist.mode_already_on': 'CONFLICT',
  'allowlist.policy_unchanged': 'CONFLICT',
  'allowlist.list_limit_unset': 'BAD_REQUEST',
};

/** One typed refusal per rule. `code` reaches the client in the message and as `error.data.cause.code`; `detail` is safe to show. */
export class AllowlistError extends Error {
  constructor(
    readonly code: AllowlistErrorCode,
    message: string,
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'AllowlistError';
  }
}

export function allowlistToTrpcError(error: unknown): unknown {
  if (error instanceof TRPCError) return error;
  if (error instanceof AllowlistError) {
    return new TRPCError({ code: KIND[error.code], message: `${error.code}: ${error.message}`, cause: error });
  }
  return error;
}
