import { TRPCError } from '@intafaced/contracts';

export type WithdrawalQuoteErrorCode =
  | 'pay.fee_unset'
  | 'withdrawal_quote.policy_unset'
  | 'withdrawal_quote.fee_source_unwired'
  | 'withdrawal_quote.network_unknown'
  | 'withdrawal_quote.network_disabled'
  | 'withdrawal_quote.asset_not_on_network'
  | 'withdrawal_quote.below_minimum'
  | 'withdrawal_quote.above_maximum'
  | 'withdrawal_quote.off_step'
  | 'withdrawal_quote.amount_invalid'
  | 'withdrawal_quote.fee_exceeds_amount'
  | 'withdrawal_quote.quote_differs'
  | 'withdrawal_quote.not_found'
  | 'withdrawal_quote.expired'
  | 'withdrawal_quote.already_used'
  | 'withdrawal_quote.client_ref_taken'
  | 'withdrawal_quote.unwired'
  /** A send out of the platform named no quote (J-wallet-05 #6): its fee would be a guess. */
  | 'withdrawal_quote.required'
  /** The accepted quote is for another asset, network or amount than the send. */
  | 'withdrawal_quote.terms_differ'
  /** The quote takes its fee out of the amount; a send does not carry that mode yet, so it refuses rather than guess. */
  | 'withdrawal_quote.fee_mode_unsupported';

const KIND: Record<WithdrawalQuoteErrorCode, TRPCError['code']> = {
  'pay.fee_unset': 'PRECONDITION_FAILED',
  'withdrawal_quote.policy_unset': 'PRECONDITION_FAILED',
  'withdrawal_quote.fee_source_unwired': 'PRECONDITION_FAILED',
  'withdrawal_quote.network_unknown': 'BAD_REQUEST',
  'withdrawal_quote.network_disabled': 'PRECONDITION_FAILED',
  'withdrawal_quote.asset_not_on_network': 'BAD_REQUEST',
  'withdrawal_quote.below_minimum': 'BAD_REQUEST',
  'withdrawal_quote.above_maximum': 'BAD_REQUEST',
  'withdrawal_quote.off_step': 'BAD_REQUEST',
  'withdrawal_quote.amount_invalid': 'BAD_REQUEST',
  'withdrawal_quote.fee_exceeds_amount': 'BAD_REQUEST',
  'withdrawal_quote.quote_differs': 'CONFLICT',
  'withdrawal_quote.not_found': 'NOT_FOUND',
  'withdrawal_quote.expired': 'PRECONDITION_FAILED',
  'withdrawal_quote.already_used': 'CONFLICT',
  'withdrawal_quote.client_ref_taken': 'CONFLICT',
  'withdrawal_quote.unwired': 'SERVICE_UNAVAILABLE',
  'withdrawal_quote.required': 'BAD_REQUEST',
  'withdrawal_quote.terms_differ': 'CONFLICT',
  'withdrawal_quote.fee_mode_unsupported': 'PRECONDITION_FAILED',
};

/** One typed refusal per rule. `code` reaches the client as `error.data.cause.code`. */
export class WithdrawalQuoteError extends Error {
  constructor(
    readonly code: WithdrawalQuoteErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WithdrawalQuoteError';
  }
}

export function withdrawalQuoteToTrpcError(error: unknown): unknown {
  if (error instanceof TRPCError) return error;
  if (error instanceof WithdrawalQuoteError) {
    return new TRPCError({ code: KIND[error.code], message: `${error.code}: ${error.message}`, cause: error });
  }
  return error;
}
