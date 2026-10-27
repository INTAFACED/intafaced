import { TRPCError } from '@intafaced/contracts';

export type WithdrawalReturnErrorCode =
  | 'withdrawal_return.withdrawal_not_found'
  | 'withdrawal_return.not_sent'
  | 'withdrawal_return.amount_invalid'
  | 'withdrawal_return.amount_exceeds_withdrawal'
  | 'withdrawal_return.already_recorded'
  | 'withdrawal_return.ref_differs'
  | 'withdrawal_return.not_found'
  | 'withdrawal_return.same_founder'
  | 'withdrawal_return.internal_settlement'
  | 'withdrawal_return.ledger_refused'
  | 'withdrawal_return.ledger_outcome_unknown';

const KIND: Record<WithdrawalReturnErrorCode, TRPCError['code']> = {
  'withdrawal_return.withdrawal_not_found': 'NOT_FOUND',
  'withdrawal_return.not_sent': 'CONFLICT',
  'withdrawal_return.amount_invalid': 'BAD_REQUEST',
  'withdrawal_return.amount_exceeds_withdrawal': 'BAD_REQUEST',
  'withdrawal_return.already_recorded': 'CONFLICT',
  'withdrawal_return.ref_differs': 'CONFLICT',
  'withdrawal_return.not_found': 'NOT_FOUND',
  'withdrawal_return.same_founder': 'FORBIDDEN',
  'withdrawal_return.internal_settlement': 'CONFLICT',
  'withdrawal_return.ledger_refused': 'CONFLICT',
  'withdrawal_return.ledger_outcome_unknown': 'SERVICE_UNAVAILABLE',
};

/** One typed refusal per rule. `code` reaches the client as `error.data.cause.code`. */
export class WithdrawalReturnError extends Error {
  constructor(
    readonly code: WithdrawalReturnErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WithdrawalReturnError';
  }
}

export function withdrawalReturnToTrpcError(error: unknown): unknown {
  if (error instanceof TRPCError) return error;
  if (error instanceof WithdrawalReturnError) {
    return new TRPCError({ code: KIND[error.code], message: `${error.code}: ${error.message}`, cause: error });
  }
  return error;
}
