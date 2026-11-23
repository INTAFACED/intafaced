import { TRPCError } from '@intafaced/contracts/trpc';
import type { RefusalOf } from '@intafaced/contracts/procedure-mount';

/**
 * svc-protocol's one reader of its own refusals, for `mountRecord`/`mountRecords`. Its handlers already throw the
 * `TRPCError` they send (`toTrpcError` and the guards), so the error leaves exactly as thrown, and the code a record lists
 * is the one its cause carries (`cause.code`, as the error formatter sends `intafacedCode`). Anything else is not a named
 * refusal and goes on unchanged, so mounting a call from its record moves nothing on the wire.
 */
export const protocolRefusal: RefusalOf = (err) => {
  if (!(err instanceof TRPCError)) return undefined;
  const code = (err.cause as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? { code, error: err } : undefined;
};
