import { TRPCError } from '@intafaced/contracts';

export type CustodyTxErrorCode =
  | 'custody_tx.not_found'
  | 'custody_tx.timeout_state_unknown'
  | 'custody_tx.cursor_invalid'
  | 'confirmation.network_unknown'
  | 'confirmation.default_unset'
  | 'confirmation.zero_needs_own_wallets'
  | 'confirmation.expiry_required'
  | 'confirmation.expiry_in_past'
  | 'confirmation.request_not_found'
  | 'confirmation.second_approver_required'
  | 'confirmation.request_expired'
  | 'confirmation.not_approved';

const KIND: Record<CustodyTxErrorCode, TRPCError['code']> = {
  'custody_tx.not_found': 'NOT_FOUND',
  'custody_tx.timeout_state_unknown': 'BAD_REQUEST',
  'custody_tx.cursor_invalid': 'BAD_REQUEST',
  'confirmation.network_unknown': 'BAD_REQUEST',
  'confirmation.default_unset': 'PRECONDITION_FAILED',
  'confirmation.zero_needs_own_wallets': 'PRECONDITION_FAILED',
  'confirmation.expiry_required': 'BAD_REQUEST',
  'confirmation.expiry_in_past': 'BAD_REQUEST',
  'confirmation.request_not_found': 'NOT_FOUND',
  'confirmation.second_approver_required': 'FORBIDDEN',
  'confirmation.request_expired': 'PRECONDITION_FAILED',
  'confirmation.not_approved': 'PRECONDITION_FAILED',
};

/** One typed refusal per rule. `code` reaches the client in the message and as `error.data.cause.code`. */
export class CustodyTxError extends Error {
  constructor(
    readonly code: CustodyTxErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CustodyTxError';
  }
}

export function custodyTxToTrpcError(error: unknown): unknown {
  if (error instanceof TRPCError) return error;
  if (error instanceof CustodyTxError) {
    return new TRPCError({ code: KIND[error.code], message: `${error.code}: ${error.message}`, cause: error });
  }
  return error;
}
