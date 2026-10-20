import { TRPCError } from '@intafaced/contracts';
import { ActionApprovalConsumeError } from '../action-approval-consume.js';
import { DualControlError } from '../dual-control.js';

export type LimitChangeErrorCode =
  | 'limits.not_found'
  | 'limits.already_exists'
  | 'limits.version_conflict'
  | 'limits.per_tx_above_rolling'
  | 'limits.unchanged'
  | 'limits.amount_invalid';

const KIND: Record<LimitChangeErrorCode, TRPCError['code']> = {
  'limits.not_found': 'NOT_FOUND',
  'limits.already_exists': 'CONFLICT',
  'limits.version_conflict': 'CONFLICT',
  'limits.per_tx_above_rolling': 'BAD_REQUEST',
  'limits.unchanged': 'BAD_REQUEST',
  'limits.amount_invalid': 'BAD_REQUEST',
};

/** One typed refusal per rule. `code` reaches the client as `error.data.cause.code`. */
export class LimitChangeError extends Error {
  constructor(
    readonly code: LimitChangeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LimitChangeError';
  }
}

export function limitChangeToTrpcError(error: unknown): unknown {
  if (error instanceof TRPCError) return error;
  if (error instanceof LimitChangeError) {
    return new TRPCError({ code: KIND[error.code], message: `${error.code}: ${error.message}`, cause: error });
  }
  if (error instanceof DualControlError || error instanceof ActionApprovalConsumeError) {
    return new TRPCError({ code: 'PRECONDITION_FAILED', message: error.message, cause: error });
  }
  return error;
}
