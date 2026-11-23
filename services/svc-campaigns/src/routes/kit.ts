import { AuthError, requireMfa, type Principal } from '@intafaced/auth';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { publicProcedure, scopedProcedure } from '@intafaced/contracts/trpc';
import type { RefusalOf } from '@intafaced/contracts/procedure-mount';
import { CAMPAIGNS_REFUSAL_STATUS } from '@intafaced/contracts/campaigns-procedures';
import { CampaignsError } from '../codes.js';

/**
 * What every route file shares: the module guard, the error mapping, the operator door and the caller's address. A
 * feature's procedures live in its own file in this folder; `../router.ts` only composes them.
 */
export const guard = { module: 'campaigns', plane: 'fiat' } as const;

/**
 * The caller's address as the edge resolved it and forwarded it (`x-real-ip`, set by svc-edge from the connection, never
 * from a client header); null when the call did not come through the edge.
 */
export const sourceOf = (ctx: object): string | null => (ctx as { sourceAddress?: string | null }).sourceAddress ?? null;

/** A named refusal in its wire form: the code leads the message in brackets and rides `cause.code`, so the screens quote it. */
export const refusalOf: RefusalOf = (err) =>
  err instanceof CampaignsError
    ? {
        code: err.code,
        error: new TRPCError({ code: CAMPAIGNS_REFUSAL_STATUS[err.code], message: `${err.message} [${err.code}]`, cause: err }),
      }
    : undefined;

export function mapError(err: unknown): never {
  const refusal = refusalOf(err);
  if (refusal) throw refusal.error;
  if (err instanceof AuthError) throw new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });
  throw err;
}

/** The second factor an operator door needs on this session; a record's handler for `ops.*` calls it first. */
export function requireOpsMfa(ctx: { principal: Principal }): void {
  try {
    requireMfa(ctx.principal);
  } catch (err) {
    mapError(err);
  }
}

/** Operator doors: `campaigns:ops` and a second factor on this session. The module's kill switch halts them too. */
export const opsProcedure = scopedProcedure('campaigns:ops', guard).use(({ ctx, next }) => {
  requireOpsMfa(ctx);
  return next();
});

export const health = publicProcedure
  .output(z.object({ ok: z.literal(true), service: z.literal('svc-campaigns') }))
  .query(() => ({ ok: true as const, service: 'svc-campaigns' as const }));
