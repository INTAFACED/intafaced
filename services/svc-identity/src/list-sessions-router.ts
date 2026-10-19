import { z } from 'zod';
import { router, scopedProcedure, TRPCError } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { listSessions, ListSessionsError, SessionsListLimitUnsetError } from './auth/list-sessions.js';

/**
 * Top-level list (not nested under auth) so mergeRouters cannot replace
 * auth.logout. identity:read (write implies read). Named userId required.
 * Limit required — omit never dumps seats. Live seats only. No refresh hash.
 * A caller lists only their own seats; the operator view is the ops router.
 */
export function createListSessionsRouter(sql: Sql) {
  return router({
    listSessions: scopedProcedure('identity:read')
      .input(z.object({ userId: z.string().uuid(), limit: z.number().int().min(1).max(200) }))
      .output(
        z.object({
          userId: z.string().uuid(),
          sessions: z.array(
            z.object({
              id: z.string().uuid(),
              createdAt: z.string(),
              revoked: z.literal(false),
            }),
          ),
        }),
      )
      .query(async ({ ctx, input }) => {
        if (ctx.principal.userId !== input.userId) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'You can list only your own sessions' });
        }
        try {
          const out = await listSessions(sql, input.userId, input.limit);
          return {
            userId: out.userId,
            sessions: out.sessions.map((s) => ({
              id: s.id,
              createdAt: s.createdAt.toISOString(),
              revoked: false as const,
            })),
          };
        } catch (err) {
          if (err instanceof SessionsListLimitUnsetError) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: `${err.message} [${err.code}]`, cause: err });
          }
          if (err instanceof ListSessionsError) {
            throw new TRPCError({ code: 'BAD_REQUEST', message: err.message, cause: err });
          }
          throw err;
        }
      }),
  });
}
