import { TRPCError } from '@intafaced/contracts';
import { ActionApprovalConsumeError } from '../action-approval-consume.js';
import { DualControlError } from '../dual-control.js';

export type ScreeningDeskErrorCode =
  | 'screening.case_not_found'
  | 'screening.case_decided'
  | 'screening.case_clear'
  | 'screening.case_context_missing'
  | 'screening.release_not_allowed'
  | 'screening.release_blocked_blank_list'
  | 'screening.release_unsupported_kind'
  | 'screening.release_ttl_unset';

const KIND: Record<ScreeningDeskErrorCode, TRPCError['code']> = {
  'screening.case_not_found': 'NOT_FOUND',
  'screening.case_decided': 'CONFLICT',
  'screening.case_clear': 'BAD_REQUEST',
  'screening.case_context_missing': 'PRECONDITION_FAILED',
  'screening.release_not_allowed': 'FORBIDDEN',
  'screening.release_blocked_blank_list': 'PRECONDITION_FAILED',
  'screening.release_unsupported_kind': 'PRECONDITION_FAILED',
  'screening.release_ttl_unset': 'PRECONDITION_FAILED',
};

export class ScreeningDeskError extends Error {
  constructor(
    readonly code: ScreeningDeskErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ScreeningDeskError';
  }
}

export function screeningDeskToTrpcError(error: unknown): unknown {
  if (error instanceof TRPCError) return error;
  if (error instanceof ScreeningDeskError) {
    return new TRPCError({ code: KIND[error.code], message: `${error.code}: ${error.message}`, cause: error });
  }
  if (error instanceof DualControlError || error instanceof ActionApprovalConsumeError) {
    return new TRPCError({ code: 'PRECONDITION_FAILED', message: error.message, cause: error });
  }
  return error;
}
