/**
 * Log the cause of a tRPC server fault.
 *
 * `toTrpcError` turns an unexpected throw into `INTERNAL_SERVER_ERROR: Request
 * failed` and keeps the original on `cause`. The wire body is deliberately
 * generic, and fastify's request log only prints the 500, so without this the
 * real cause existed in no log (the Convert accept 500 on the local test stack
 * was found by hand for exactly that reason).
 *
 * Every 5xx is logged (an INTERNAL_SERVER_ERROR, but also a 503 such as
 * `authority.unavailable`). A typed refusal (BAD_REQUEST, FORBIDDEN, ...) is an
 * answer, not a fault, and stays quiet.
 *
 * Only name, message, code and stack are logged. Never the whole error object:
 * a database error carries `detail` and row values, and a ledger error can carry
 * account ids and amounts, none of which belong in a log line.
 */

import type { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';

export interface TrpcFaultLogger {
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface TrpcFaultInfo {
  readonly path: string | undefined;
  readonly type: string;
  readonly error: TRPCError;
}

/** The four fields that identify a fault without carrying its payload. */
export function safeErrorFields(err: unknown): { name: string; message: string; code?: string; stack?: string } {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    return {
      name: err.name,
      message: err.message,
      ...(typeof code === 'string' || typeof code === 'number' ? { code: String(code) } : {}),
      ...(err.stack ? { stack: err.stack } : {}),
    };
  }
  return { name: 'NonError', message: typeof err === 'string' ? err : 'non-error value thrown' };
}

export function logTrpcServerFault(log: TrpcFaultLogger, info: TrpcFaultInfo): void {
  if (getHTTPStatusCodeFromError(info.error) < 500) return;
  log.error({ err: safeErrorFields(info.error.cause ?? info.error), path: info.path, type: info.type }, 'trpc procedure failed');
}
