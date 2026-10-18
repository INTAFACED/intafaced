import { TRPCError } from '@intafaced/contracts';

/**
 * Typed refusal for the desk reads. The code is the contract the room branches on.
 * The message repeats it in brackets so a tRPC client that only reads `message` still sees it.
 */
export class DeskError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'DeskError';
  }
}

export function deskTrpcError(err: unknown): TRPCError | null {
  if (!(err instanceof DeskError)) return null;
  const notFound = err.code.endsWith('_not_found');
  const precondition =
    err.code.endsWith('_unset') ||
    err.code.endsWith('_unconfigured') ||
    err.code.endsWith('_before_window') ||
    err.code.endsWith('_too_wide') ||
    err.code === 'trade.options_model_unset';
  const code = notFound ? 'NOT_FOUND' : precondition ? 'PRECONDITION_FAILED' : 'BAD_REQUEST';
  return new TRPCError({ code, message: `${err.message} [${err.code}]`, cause: err });
}
