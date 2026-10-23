import type { Sql } from 'postgres';
import { z } from 'zod';
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

const reservationView = z.object({
  reservationKey: z.string(),
  sessionId: z.string().uuid(),
  assetId: z.string(),
  amount: z.string(),
  committedAmount: z.string().nullable(),
  status: z.enum(['held', 'committed', 'released']),
  replayed: z.boolean(),
});

function storeOf(sql: Sql | undefined): UserSpendStore {
  if (!sql) {
    throw new AgentError('Agents database is unset', 'agents.capability_unavailable', 'agents.error.capability_unavailable');
  }
  return new UserSpendStore(sql);
}

/** User spend caps. The caller is the principal, never a user id in the body. */
export function spendRouter(sql: Sql | undefined) {
  return router({
    limits: router({
      get: scopedProcedure('agents:read', { module: 'agents' })
        .output(z.object({ limits: limitView.nullable() }))
        .query(({ ctx }) => guard(async () => ({ limits: await storeOf(sql).get(ctx.principal.userId) }))),

      set: scopedProcedure('agents:execute', { module: 'agents' })
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
        .mutation(({ ctx, input }) => guard(() => storeOf(sql).set({ userId: ctx.principal.userId, ...input }))),
    }),

    reserve: scopedProcedure('agents:execute', { module: 'agents' })
      .input(
        z.object({
          reservationKey: text,
          sessionId: text,
          assetId: text,
          amount: text,
        }),
      )
      .output(reservationView)
      .mutation(({ ctx, input }) =>
        guard(() =>
          storeOf(sql).reserve({
            userId: ctx.principal.userId,
            sessionId: input.sessionId ?? '',
            reservationKey: input.reservationKey ?? '',
            assetId: input.assetId ?? '',
            amount: input.amount ?? '',
          }),
        ),
      ),

    commit: scopedProcedure('agents:execute', { module: 'agents' })
      .input(z.object({ reservationKey: text, amount: text }))
      .output(reservationView)
      .mutation(({ ctx, input }) =>
        guard(() =>
          storeOf(sql).commit({
            userId: ctx.principal.userId,
            reservationKey: input.reservationKey ?? '',
            amount: input.amount ?? '',
          }),
        ),
      ),

    release: scopedProcedure('agents:execute', { module: 'agents' })
      .input(z.object({ reservationKey: text }))
      .output(reservationView)
      .mutation(({ ctx, input }) =>
        guard(() => storeOf(sql).release({ userId: ctx.principal.userId, reservationKey: input.reservationKey ?? '' })),
      ),
  });
}
