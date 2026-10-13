/**
 * Log the cause of a tRPC server fault.
 *
 * `toTrpcError` turns an unexpected throw into `INTERNAL_SERVER_ERROR: Request
 * failed` and keeps the original on `cause`. The wire body is deliberately
 * generic, and fastify's request log only prints the 500, so without this the
 * real cause existed in no log (the Convert accept 500 on the local test stack
 * was found by hand for exactly that reason).
 *
 * Only 5xx faults are logged here. A typed refusal (BAD_REQUEST, FORBIDDEN, ...)
 * is an answer, not a fault.
 */

export interface TrpcFaultLogger {
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface TrpcFaultInfo {
  readonly path: string | undefined;
  readonly type: string;
  readonly error: { readonly code: string; readonly cause?: unknown; readonly message: string };
}

export function logTrpcServerFault(log: TrpcFaultLogger, info: TrpcFaultInfo): void {
  if (info.error.code !== 'INTERNAL_SERVER_ERROR') return;
  log.error({ err: info.error.cause ?? info.error, path: info.path, type: info.type }, 'trpc procedure failed');
}
