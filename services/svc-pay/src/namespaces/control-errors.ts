import { TRPCError } from '@intafaced/contracts';
import { ControlError, ControlRefusal } from '../control/errors.js';

const CODES = {
  not_found: 'NOT_FOUND',
  forbidden: 'FORBIDDEN',
  precondition: 'PRECONDITION_FAILED',
  conflict: 'CONFLICT',
  bad_request: 'BAD_REQUEST',
  unwired: 'NOT_IMPLEMENTED',
} as const;

/** Render a control-room error for the wire. The message is the code; the cause carries `code` to the client. */
export function toTrpcError(error: unknown): unknown {
  if (error instanceof ControlError) return new TRPCError({ code: CODES[error.errorClass], message: error.code, cause: error });
  if (error instanceof ControlRefusal) {
    return new TRPCError({ code: error.kind === 'unavailable' ? 'SERVICE_UNAVAILABLE' : 'FORBIDDEN', message: error.code, cause: error });
  }
  return error;
}

export async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw toTrpcError(error);
  }
}
