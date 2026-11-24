import { router, TRPCError } from '@intafaced/contracts/trpc';
import type { Sql } from 'postgres';
import { listSessions, ListSessionsError, SessionsListLimitUnsetError } from './auth/list-sessions.js';
import { IDENTITY_LIST_SESSIONS } from '@intafaced/contracts/identity-list-sessions-procedures';
import { mountRecord } from '@intafaced/contracts/procedure-mount';
import { codedRefusal } from './record-refusal.js';

/**
 * Top-level list (not nested under auth) so mergeRouters cannot replace
 * auth.logout. identity:read (write implies read). Named userId required.
 * Limit required — omit never dumps seats. Live seats only. No refresh hash.
 * A caller lists only their own seats; the operator view is the ops router.
 */
export function createListSessionsRouter(sql: Sql) {
  return router({
    listSessions: mountRecord(
      IDENTITY_LIST_SESSIONS,
      async ({ ctx, input }) => {
        if (ctx.principal.userId !== input.userId) {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'You can list only your own sessions' });
        }
        try {
          const out = await listSessions(sql, input.userId, input.limit, { cursor: input.cursor, currentSessionId: ctx.principal.sid });
          return {
            userId: out.userId,
            sessions: out.sessions.map((s) => ({
              ...s,
              createdAt: s.createdAt.toISOString(),
              lastUsedAt: s.lastUsedAt.toISOString(),
            })),
            nextCursor: out.nextCursor,
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
      },
      codedRefusal,
    ),
  });
}
