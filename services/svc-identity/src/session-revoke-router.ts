import { router, TRPCError } from '@intafaced/contracts/trpc';
import type { Sql } from 'postgres';
import { revokeNamedSession, RevokeSessionError } from './auth/revoke-session.js';
import { SESSION_CURRENT_USE_LOGOUT } from './session-families-router.js';
import { IDENTITY_REVOKE_SESSION } from '@intafaced/contracts/identity-revoke-session-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { codedRefusal } from './record-refusal.js';

/**
 * Top-level one-seat revoke (not nested under auth) so mergeRouters cannot
 * replace auth.logout. identity:write. Named userId + sessionId required.
 * Own user only. Already-revoked stay revoked (idempotent false).
 */
export function createSessionRevokeRouter(sql: Sql) {
  return router({
    revokeSession: mountRecord(
      IDENTITY_REVOKE_SESSION,
      async ({ ctx, input }) => {
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
      },
      codedRefusal,
    ),
  });
}
