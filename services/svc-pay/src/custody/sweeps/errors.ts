import { TRPCError } from '@intafaced/contracts';

export type CustodySweepErrorCode =
  | 'custody_sweep.policy_unset'
  | 'custody_sweep.policy_invalid'
  | 'custody_sweep.deposit_not_found'
  | 'custody_sweep.deposit_not_credited'
  | 'custody_sweep.sweep_not_found'
  | 'custody_sweep.in_flight'
  | 'custody_sweep.sweep_final'
  | 'custody_sweep.policy_changed'
  | 'custody_sweep.stale_ttl_unset'
  | 'rail.crypto';

const KIND: Record<CustodySweepErrorCode, TRPCError['code']> = {
  'custody_sweep.policy_unset': 'PRECONDITION_FAILED',
  'custody_sweep.policy_invalid': 'BAD_REQUEST',
  'custody_sweep.deposit_not_found': 'NOT_FOUND',
  'custody_sweep.deposit_not_credited': 'PRECONDITION_FAILED',
  'custody_sweep.sweep_not_found': 'NOT_FOUND',
  'custody_sweep.in_flight': 'CONFLICT',
  'custody_sweep.sweep_final': 'CONFLICT',
  'custody_sweep.policy_changed': 'CONFLICT',
  'custody_sweep.stale_ttl_unset': 'PRECONDITION_FAILED',
  'rail.crypto': 'SERVICE_UNAVAILABLE',
};

/** One typed refusal per rule. `code` reaches the client as `error.data.cause.code`. */
export class CustodySweepError extends Error {
  constructor(
    readonly code: CustodySweepErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CustodySweepError';
  }
}

export function custodySweepToTrpcError(error: unknown): unknown {
  if (error instanceof TRPCError) return error;
  if (error instanceof CustodySweepError) {
    return new TRPCError({ code: KIND[error.code], message: `${error.code}: ${error.message}`, cause: error });
  }
  return error;
}
