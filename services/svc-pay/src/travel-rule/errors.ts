import { TRPCError } from '@intafaced/contracts';

export type TravelRuleErrorCode =
  | 'wallet.travel_rule_undecided'
  | 'travel_rule.wait_limit_unset'
  | 'travel_rule.cipher_unwired'
  | 'travel_rule.key_unknown'
  | 'travel_rule.withdrawal_not_found'
  | 'travel_rule.transfer_not_found'
  | 'travel_rule.transfer_differs'
  | 'travel_rule.transition_refused'
  | 'travel_rule.operator_cannot_bypass'
  | 'travel_rule.message_missing'
  | 'travel_rule.fields_missing'
  | 'travel_rule.not_accepted'
  | 'travel_rule.record_missing'
  | 'vendor.travelrule';

const KIND: Record<TravelRuleErrorCode, TRPCError['code']> = {
  'wallet.travel_rule_undecided': 'PRECONDITION_FAILED',
  'travel_rule.wait_limit_unset': 'PRECONDITION_FAILED',
  'travel_rule.cipher_unwired': 'SERVICE_UNAVAILABLE',
  'travel_rule.key_unknown': 'PRECONDITION_FAILED',
  'travel_rule.withdrawal_not_found': 'NOT_FOUND',
  'travel_rule.transfer_not_found': 'NOT_FOUND',
  'travel_rule.transfer_differs': 'CONFLICT',
  'travel_rule.transition_refused': 'CONFLICT',
  'travel_rule.operator_cannot_bypass': 'FORBIDDEN',
  'travel_rule.message_missing': 'PRECONDITION_FAILED',
  'travel_rule.fields_missing': 'PRECONDITION_FAILED',
  'travel_rule.not_accepted': 'PRECONDITION_FAILED',
  'travel_rule.record_missing': 'PRECONDITION_FAILED',
  'vendor.travelrule': 'SERVICE_UNAVAILABLE',
};

/** One typed refusal per rule. `code` reaches the client as `error.data.cause.code`. */
export class TravelRuleError extends Error {
  constructor(
    readonly code: TravelRuleErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TravelRuleError';
  }
}

export function travelRuleToTrpcError(error: unknown): unknown {
  if (error instanceof TRPCError) return error;
  if (error instanceof TravelRuleError) {
    return new TRPCError({ code: KIND[error.code], message: `${error.code}: ${error.message}`, cause: error });
  }
  return error;
}
