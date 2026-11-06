import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { SessionLimitError, sessionLimitsView, setChosenIdleSeconds, type SessionLimitsPolicy } from './auth/session-limits.js';

/**
 * Idle sign-out and the limit on signed-in devices, for Security (I-signin-sessions-06; J-identity-06 #4). Top-level,
 * beside the session families. The read shows the owner's two settings (null while unpublished) and the customer's own
 * idle choice; the write sets a shorter idle time or clears it. Both need a signed-in session on a device: an API key
 * cannot change how the account's sign-ins end.
 */
const view = z
  .object({
    ownerIdleSeconds: z.number().int().nullable(),
    chosenIdleSeconds: z.number().int().nullable(),
    maxConcurrent: z.number().int().nullable(),
  })
  .strict();

async function requireDeviceSession(sql: Sql, userId: string, sessionId: string): Promise<void> {
  const [row] =
    await sql`SELECT 1 FROM sessions WHERE id = ${sessionId} AND user_id = ${userId} AND revoked = false AND expires_at > now()`;
  if (!row) throw new TRPCError({ code: 'FORBIDDEN', message: 'Sign in on a device to manage how your sign-ins end' });
}

export function createSessionLimitsRouter(sql: Sql, policy: () => SessionLimitsPolicy) {
  return router({
    sessionLimits: scopedProcedure('identity:read')
      .input(z.object({}).strict().optional())
      .output(view)
      .query(async ({ ctx }) => {
        await requireDeviceSession(sql, ctx.principal.userId, ctx.principal.sid);
        return sessionLimitsView(sql, policy(), ctx.principal.userId);
      }),

    setIdleSignOut: scopedProcedure('identity:write')
      .input(z.object({ seconds: z.number().int().nullable() }).strict())
      .output(view)
      .mutation(async ({ ctx, input }) => {
        await requireDeviceSession(sql, ctx.principal.userId, ctx.principal.sid);
        try {
          await setChosenIdleSeconds(sql, policy(), ctx.principal.userId, input.seconds);
        } catch (err) {
          if (err instanceof SessionLimitError) {
            throw new TRPCError({
              code: err.code === 'identity.session_idle_unset' ? 'PRECONDITION_FAILED' : 'BAD_REQUEST',
              message: `${err.message} [${err.code}]`,
            });
          }
          throw err;
        }
        return sessionLimitsView(sql, policy(), ctx.principal.userId);
      }),
  });
}
