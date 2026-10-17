import { TRPCError } from '@intafaced/contracts';
import { PayGuardRefusal } from '../seams/guards.js';

/** A conversion refusal. `code` is what the client sees; `trpc` is the transport status. */
export class ConversionError extends Error {
  constructor(
    readonly code: `pay.${string}`,
    readonly trpc: 'NOT_FOUND' | 'PRECONDITION_FAILED' | 'FORBIDDEN' | 'SERVICE_UNAVAILABLE' | 'BAD_REQUEST',
  ) {
    super(code);
    this.name = 'ConversionError';
  }
}

export function conversionNotFound(): ConversionError {
  return new ConversionError('pay.conversion_not_found', 'PRECONDITION_FAILED');
}

export function merchantNotOnTeam(): ConversionError {
  return new ConversionError('pay.merchant_not_found', 'NOT_FOUND');
}

/** Map a conversion or guard failure onto a tRPC error. Anything else stays a typed unavailable. */
export function mapConversionError(error: unknown): TRPCError {
  if (error instanceof TRPCError) return error;
  if (error instanceof ConversionError) {
    return new TRPCError({ code: error.trpc, message: error.code, cause: error });
  }
  if (error instanceof PayGuardRefusal) {
    const trpc = error.kind === 'unavailable' ? 'SERVICE_UNAVAILABLE' : 'FORBIDDEN';
    return new TRPCError({ code: trpc, message: error.code, cause: error });
  }
  const cause = new ConversionError('pay.conversion_unavailable', 'SERVICE_UNAVAILABLE');
  return new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: cause.code, cause });
}
