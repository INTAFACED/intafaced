import { TRPCError } from '@intafaced/contracts';
import type { RefusalOf } from '@intafaced/contracts/procedure-mount';

/**
 * svc-dex's one reader of its own refusals, for `mountRecord`. Its handlers already throw the `TRPCError` they send
 * (`toTrpcError` in `router.ts`, `orderSessionTrpcError` in `auth/router.ts`), each with the refusal it came from as its
 * cause, so the error leaves exactly as thrown and the code a record lists is the cause's `code`. Anything else is not a
 * named refusal and goes on unchanged, so mounting a call from its record moves nothing on the wire.
 */
export const dexRefusal: RefusalOf = (err) => {
  if (!(err instanceof TRPCError)) return undefined;
  const cause: unknown = err.cause;
  return cause instanceof Error && 'code' in cause && typeof cause.code === 'string' ? { code: cause.code, error: err } : undefined;
};
