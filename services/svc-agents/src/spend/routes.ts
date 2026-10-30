import type { Sql } from 'postgres';
import { z } from 'zod';
import { hasScope, type Principal } from '@intafaced/auth';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import { AgentError } from '../errors.js';
import { UserSpendStore } from './store.js';

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof AgentError)) throw err;
    const code =
      err.code === 'agents.spend_limit' || err.code === 'agents.spend_limit_unset'
        ? 'FORBIDDEN'
        : err.code === 'agents.session_not_found' || err.code === 'agents.spend_reservation_not_found'
          ? 'NOT_FOUND'
          : 'BAD_REQUEST';
    throw new TRPCError({ code, message: err.userMessageKey, cause: err });
  }
}

const text = z.string().max(200).nullable().optional();

const limitView = z.object({
  assetId: z.string(),
  perCall: z.string(),
  perSession: z.string(),
  perPeriod: z.string(),
  period: z.enum(['day', 'week', 'month']),
});

function storeOf(sql: Sql | undefined): UserSpendStore {
  if (!sql) {
    throw new AgentError('Agents database is unset', 'agents.capability_unavailable', 'agents.error.capability_unavailable');
  }
  return new UserSpendStore(sql);
}

/**
 * The person sets the cap. Other user doors in this service use `agents:read`,
 * which a signed-in session already holds and which `agents:execute` does not
 * imply. `identity:write` is that same session's own write. A delegated token
 * (`kid` or `sub_account`) is not the person, even if it copied both scopes.
 * A service on the same request is refused by `scopedProcedure(..., { person: true })`.
 */
export function assertPersonSetsLimits(principal: Principal): void {
  if (principal.kid || principal.sub_account || !hasScope(principal.scopes, 'identity:write')) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'A signed-in user session is required' });
  }
}

/** User spend caps. The caller is the principal, never a user id in the body. Reserve, commit and release stay on the runtime. */
export function spendRouter(sql: Sql | undefined) {
  return router({
    limits: router({
      get: scopedProcedure('agents:read', { module: 'agents' })
        .output(z.object({ limits: limitView.nullable() }))
        .query(({ ctx }) => guard(async () => ({ limits: await storeOf(sql).get(ctx.principal.userId) }))),

      set: scopedProcedure('agents:read', { module: 'agents', person: true })
        .input(
          z.object({
            idempotencyKey: text,
            assetId: text,
            perCall: text,
            perSession: text,
            perPeriod: text,
            period: text,
          }),
        )
        .output(z.object({ limits: limitView, replayed: z.boolean() }))
        .mutation(({ ctx, input }) => {
          assertPersonSetsLimits(ctx.principal);
          return guard(() => storeOf(sql).set({ userId: ctx.principal.userId, ...input }));
        }),
    }),
  });
}
