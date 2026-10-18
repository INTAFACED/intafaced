import { TRPCError, type Context } from '@intafaced/contracts';

/**
 * Services that may name an account on a saved-strategy call.
 * Empty until a service is commissioned. Production does not pass a wider list.
 */
export const STUDIO_SERVICE_ALLOWLIST: readonly string[] = [];

const ADMIN_SCOPES: ReadonlySet<string> = new Set(['admin:read', 'admin:write', 'admin:treasury', 'admin:compliance']);

/**
 * Account id on the authenticated session.
 * A sub-account session is that sub-account. Otherwise the user id.
 * Never read from the request body.
 */
export function sessionAccountId(principal: NonNullable<Context['principal']>): string {
  return principal.sub_account ?? principal.userId;
}

/**
 * Session callers: account comes from the principal. A body accountId is ignored.
 * Service callers: allow-listed, and accountId on the input is required.
 * Anyone else is unauthenticated. There is no unscoped list on this path.
 */
export function resolveStudioAccount(ctx: Context, bodyAccountId: string | undefined, allowlist: ReadonlySet<string>): string {
  if (ctx.principal) return sessionAccountId(ctx.principal);
  if (ctx.service) {
    if (!allowlist.has(ctx.service)) {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'quant.studio_service_denied — this service is not allow-listed for saved strategies',
      });
    }
    if (!bodyAccountId) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'quant.studio_account_required — a service caller must pass accountId',
      });
    }
    return bodyAccountId;
  }
  throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required' });
}

/** Operator metadata. Any admin scope. No principal → unauthorized. */
export function requireStudioOperator(ctx: Context): void {
  if (!ctx.principal) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: 'Authentication required' });
  }
  if (!ctx.principal.scopes.some((scope) => ADMIN_SCOPES.has(scope))) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'quant.studio_operator_forbidden — admin scope required',
    });
  }
}
