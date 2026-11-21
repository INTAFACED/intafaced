import { TRPCError, type Context } from '@intafaced/contracts';
import type { RefusalOf } from '@intafaced/contracts/procedure-mount';

/**
 * svc-identity's refusals for calls mounted from records inside its routers: a `TRPCError` whose cause carries a string
 * `code` is that named refusal, sent unchanged. Any other error is not a named refusal and leaves as the handler threw it.
 */
export const codedRefusal: RefusalOf = (err) => {
  if (!(err instanceof TRPCError)) return undefined;
  const cause: unknown = err.cause;
  const code: unknown = typeof cause === 'object' && cause !== null && 'code' in cause ? cause.code : undefined;
  return typeof code === 'string' ? { code, error: err } : undefined;
};

/** The signed-in person a `signedIn` record's guard has already admitted. */
export function signedInUser(ctx: Context): string {
  if (ctx.principal === null || ctx.principal === undefined)
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required' });
  return ctx.principal.userId;
}
