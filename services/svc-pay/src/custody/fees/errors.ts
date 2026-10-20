import { TRPCError } from '@intafaced/contracts';

export type CustodyFeesErrorCode =
  | 'custody_fees.network_unknown'
  | 'custody_fees.not_configured'
  | 'custody_fees.estimator_unwired'
  | 'custody_fees.estimate_failed'
  | 'custody_fees.cap_unset'
  | 'custody_fees.unit_mismatch'
  | 'custody_fees.fee_above_cap'
  | 'custody_fees.refuel_differs';

const KIND: Record<CustodyFeesErrorCode, TRPCError['code']> = {
  'custody_fees.network_unknown': 'BAD_REQUEST',
  'custody_fees.not_configured': 'NOT_FOUND',
  'custody_fees.estimator_unwired': 'PRECONDITION_FAILED',
  'custody_fees.estimate_failed': 'PRECONDITION_FAILED',
  'custody_fees.cap_unset': 'PRECONDITION_FAILED',
  'custody_fees.unit_mismatch': 'PRECONDITION_FAILED',
  'custody_fees.fee_above_cap': 'PRECONDITION_FAILED',
  'custody_fees.refuel_differs': 'CONFLICT',
};

/** One typed refusal per rule. `code` reaches the client as `error.data.cause.code`. */
export class CustodyFeesError extends Error {
  constructor(
    readonly code: CustodyFeesErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CustodyFeesError';
  }
}

export function custodyFeesToTrpcError(error: unknown): unknown {
  if (error instanceof TRPCError) return error;
  if (error instanceof CustodyFeesError) {
    return new TRPCError({ code: KIND[error.code], message: `${error.code}: ${error.message}`, cause: error });
  }
  return error;
}
