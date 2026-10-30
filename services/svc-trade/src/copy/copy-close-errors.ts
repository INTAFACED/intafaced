/**
 * Refusals of a follower's close of one copied position (CB-copy-10) and of a leader close that has nothing copied
 * left to close (CB-copy-09). Kept apart from `CopyErrorCode` so the closed copy union is not widened here; the
 * router maps them with `copyCloseTrpcError`.
 */
import { TRPCError } from '@intafaced/contracts';

export const COPY_CLOSE_ERROR_STATUS = {
  /** The amount asked is above what is open on that copied position. */
  'trade.copy_close_qty_exceeds': 'BAD_REQUEST',
  /** The amount is not a positive decimal. */
  'trade.copy_close_qty_invalid': 'BAD_REQUEST',
  /** No copied buy of this follow has that id. */
  'trade.copy_position_not_found': 'NOT_FOUND',
  /** Nothing copied is open to close (the position is closed, or still closing). */
  'trade.copy_position_closed': 'PRECONDITION_FAILED',
  /** The close cannot be priced or placed: no place port, flag off, or no spot tables. */
  'trade.copy_close_unavailable': 'PRECONDITION_FAILED',
} as const satisfies Record<string, TRPCError['code']>;

export type CopyCloseErrorCode = keyof typeof COPY_CLOSE_ERROR_STATUS;

export class CopyCloseError extends Error {
  constructor(
    message: string,
    readonly code: CopyCloseErrorCode,
  ) {
    super(message);
    this.name = 'CopyCloseError';
  }
}

export function copyCloseTrpcError(err: unknown): TRPCError | null {
  if (!(err instanceof CopyCloseError)) return null;
  return new TRPCError({ code: COPY_CLOSE_ERROR_STATUS[err.code], message: err.message, cause: err });
}
