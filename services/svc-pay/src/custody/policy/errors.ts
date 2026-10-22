import { TRPCError } from '@intafaced/contracts';

export type CustodyPolicyErrorCode =
  | 'custody_policy.draft_invalid'
  | 'custody_policy.no_draft'
  | 'custody_policy.draft_differs'
  | 'custody_policy.same_founder'
  | 'custody_policy.version_not_found'
  | 'custody_policy.unset';

const KIND: Record<CustodyPolicyErrorCode, TRPCError['code']> = {
  'custody_policy.draft_invalid': 'BAD_REQUEST',
  'custody_policy.no_draft': 'NOT_FOUND',
  'custody_policy.draft_differs': 'CONFLICT',
  'custody_policy.same_founder': 'FORBIDDEN',
  'custody_policy.version_not_found': 'NOT_FOUND',
  'custody_policy.unset': 'PRECONDITION_FAILED',
};

/** One typed refusal per rule. `code` reaches the client as `error.data.cause.code`. */
export class CustodyPolicyError extends Error {
  constructor(
    readonly code: CustodyPolicyErrorCode,
    message: string,
    /** Per-rule problems when a draft does not validate. */
    readonly problems?: readonly { readonly ruleId: string | null; readonly problem: string }[],
  ) {
    super(message);
    this.name = 'CustodyPolicyError';
  }
}

export function custodyPolicyToTrpcError(error: unknown): unknown {
  if (error instanceof TRPCError) return error;
  if (error instanceof CustodyPolicyError) {
    const detail = error.problems?.length ? ` (${error.problems.map((p) => `${p.ruleId ?? '-'}: ${p.problem}`).join('; ')})` : '';
    return new TRPCError({ code: KIND[error.code], message: `${error.code}: ${error.message}${detail}`, cause: error });
  }
  return error;
}
