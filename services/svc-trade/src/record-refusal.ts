import { TRPCError } from '@intafaced/contracts';
import type { RefusalOf } from '@intafaced/contracts/procedure-mount';

/**
 * svc-trade's one reader of its own refusals, for `mountRecord`. Its handlers already throw the `TRPCError` they send
 * (`toTrpcError` in `router.ts`, `convertHistoryTrpcError` and the like), each with the refusal it came from as its
 * cause, so the error leaves exactly as thrown and the code a record lists is the cause's `code`. Anything else is not
 * a named refusal and goes on unchanged, so mounting a call from its record moves nothing on the wire. A router whose
 * handlers throw their domain error unmapped (grid, recurring, builder fee) keeps its own reader beside it.
 */
export const tradeRefusal: RefusalOf = (err) => {
  if (!(err instanceof TRPCError)) return undefined;
  const cause: unknown = err.cause;
  const code = typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined;
  return typeof code === 'string' ? { code, error: err } : undefined;
};
