import { AuthError, requireMfa } from '@intafaced/auth';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { publicProcedure, scopedProcedure } from '@intafaced/contracts';
import { CampaignsError } from '../codes.js';
import { STATUS } from './status.js';

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

/** The code leads in brackets and rides `cause.code`, so the screens quote it. */
export function mapError(err: unknown): never {
  if (err instanceof CampaignsError) {
    throw new TRPCError({ code: STATUS[err.code], message: `${err.message} [${err.code}]`, cause: err });
  }
  if (err instanceof AuthError) throw new TRPCError({ code: 'FORBIDDEN', message: err.message, cause: err });
  throw err;
}

/** Operator doors: `campaigns:ops` and a second factor on this session. The module's kill switch halts them too. */
export const opsProcedure = scopedProcedure('campaigns:ops', guard).use(({ ctx, next }) => {
  try {
    requireMfa(ctx.principal);
  } catch (err) {
    mapError(err);
  }
  return next();
});

export const health = publicProcedure
  .output(z.object({ ok: z.literal(true), service: z.literal('svc-campaigns') }))
  .query(() => ({ ok: true as const, service: 'svc-campaigns' as const }));
