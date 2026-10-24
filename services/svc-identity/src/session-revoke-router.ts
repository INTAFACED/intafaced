import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { revokeNamedSession, RevokeSessionError } from './auth/revoke-session.js';
import { SESSION_CURRENT_USE_LOGOUT } from './session-families-router.js';

/**
 * Top-level one-seat revoke (not nested under auth) so mergeRouters cannot
 * replace auth.logout. identity:write. Named userId + sessionId required.
 * Own user only. Already-revoked stay revoked (idempotent false).
 */
export function createSessionRevokeRouter(sql: Sql) {
  return router({
    revokeSession: scopedProcedure('identity:write')
      .input(z.object({ userId: z.string().guid(), sessionId: z.string().guid() }))
      .output(
        z.object({
          userId: z.string().guid(),
          sessionId: z.string().guid(),
          revoked: z.boolean(),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        // The device making the call ends through logout, never through this list.
        const [row] = await sql<Array<{ same: boolean }>>`
          SELECT family_id = (SELECT family_id FROM sessions WHERE id = ${ctx.principal.sid} AND user_id = ${ctx.principal.userId}) AS same
          FROM sessions WHERE id = ${input.sessionId} AND user_id = ${ctx.principal.userId}
        `;
        if (input.sessionId === ctx.principal.sid || row?.same === true) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: `This is the device you are using. Sign out instead. [${SESSION_CURRENT_USE_LOGOUT}]`,
          });
        }
        try {
          return await revokeNamedSession(sql, ctx.principal.userId, input.userId, input.sessionId);
        } catch (err) {
          if (err instanceof RevokeSessionError) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
          }
          throw err;
        }
      }),
  });
}
