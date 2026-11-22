import { TRPCError } from '@intafaced/contracts/trpc';
import type { RefusalOf } from '@intafaced/contracts/procedure-mount';

/**
 * svc-market's one reader of its own refusals, for `mountRecord`. Its handlers already throw the `TRPCError` they send
 * (`mapError` in `router.ts`), each with the refusal it came from as its cause, so the error leaves exactly as thrown and
 * the code a record lists is the cause's `code`. Anything else (a door this process has not wired, a bare NOT_FOUND) is
 * not a named refusal and goes on unchanged, so mounting a call from its record moves nothing on the wire.
 */
export const marketRefusal: RefusalOf = (err) => {
  // An outside read that failed (`market.stake_unavailable`) is ours to fix and sent as a 500, never a refusal.
  if (!(err instanceof TRPCError) || err.code === 'INTERNAL_SERVER_ERROR') return undefined;
  const cause: unknown = err.cause;
  return cause instanceof Error && 'code' in cause && typeof cause.code === 'string' ? { code: cause.code, error: err } : undefined;
};
