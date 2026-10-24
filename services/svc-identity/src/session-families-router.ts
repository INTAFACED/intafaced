import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { syncNavigatorSessionClosed } from './agents/navigator-session-projection-sync.js';

/**
 * Sign-in families (ENGINE SES-1, SES-5). Top-level, not nested under auth, so mergeRouters cannot
 * replace auth.logout. identity:write. Sign-out is not a security-weakening change, so no step-up.
 * The caller's own device is never ended here: that is logout.
 */
export const SESSION_CURRENT_USE_LOGOUT = 'auth.session_current' as const;

/** The family of the session the call came in on, or a refusal when the call is not a signed-in session. */
async function callerFamily(sql: Sql, userId: string, sessionId: string): Promise<string> {
  const [row] = await sql<Array<{ family_id: string }>>`SELECT family_id FROM sessions WHERE id = ${sessionId} AND user_id = ${userId}`;
  if (!row) throw new TRPCError({ code: 'FORBIDDEN', message: 'Sign in on a device to manage your other devices' });
  return row.family_id;
}

async function closeNavigatorRows(sql: Sql, ids: readonly string[]): Promise<void> {
  await Promise.all(ids.map((id) => syncNavigatorSessionClosed(sql, id)));
}

export function createSessionFamiliesRouter(sql: Sql) {
  return router({
    /** Ends every sign-in except the one making the call. Idempotent: a second call ends nothing. */
    revokeOtherSessions: scopedProcedure('identity:write')
      .input(z.object({}).strict())
      .output(z.object({ revokedFamilies: z.number().int() }).strict())
      .mutation(async ({ ctx }) => {
        const own = await callerFamily(sql, ctx.principal.userId, ctx.principal.sid);
        const ended = await sql<Array<{ id: string; family_id: string }>>`
          UPDATE sessions SET revoked = true
          WHERE user_id = ${ctx.principal.userId} AND revoked = false AND family_id <> ${own}
          RETURNING id, family_id
        `;
        await closeNavigatorRows(
          sql,
          ended.map((row) => row.id),
        );
        return { revokedFamilies: new Set(ended.map((row) => row.family_id)).size };
      }),

    /** Ends one sign-in by its family id. Another account's family answers like one that does not exist. */
    revokeSessionFamily: scopedProcedure('identity:write')
      .input(z.object({ familyId: z.string().guid() }).strict())
      .output(z.object({ familyId: z.string().guid(), revoked: z.boolean() }).strict())
      .mutation(async ({ ctx, input }) => {
        const own = await callerFamily(sql, ctx.principal.userId, ctx.principal.sid);
        if (input.familyId === own) {
          throw new TRPCError({
            code: 'PRECONDITION_FAILED',
            message: `This is the device you are using. Sign out instead. [${SESSION_CURRENT_USE_LOGOUT}]`,
          });
        }
        const [known] = await sql`SELECT 1 FROM sessions WHERE user_id = ${ctx.principal.userId} AND family_id = ${input.familyId} LIMIT 1`;
        if (!known) throw new TRPCError({ code: 'NOT_FOUND', message: 'auth.not_found' });
        const ended = await sql<Array<{ id: string }>>`
          UPDATE sessions SET revoked = true
          WHERE user_id = ${ctx.principal.userId} AND family_id = ${input.familyId} AND revoked = false
          RETURNING id
        `;
        await closeNavigatorRows(
          sql,
          ended.map((row) => row.id),
        );
        return { familyId: input.familyId, revoked: ended.length > 0 };
      }),
  });
}
