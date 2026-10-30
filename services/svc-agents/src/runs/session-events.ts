import { z } from 'zod';
import { scopedProcedure } from '@intafaced/contracts';
import { actionOutput, toActionOutput, type AgentsRouterDeps } from '../router.js';
import { parseCursor, type RunRouteKit } from './routes.js';

/**
 * `session.events` (AG-sessions-04's developer read): one of the caller's sessions, its recorded actions after a cursor.
 *
 * The cursor is the last action sequence the caller has read, as a decimal string; none reads from the start (the
 * session's open, sequence 0), and the answer's cursor is null only while nothing has been read. A malformed one is the existing `agents.cursor_invalid`. Only later actions come back, oldest first, with the cursor to
 * pass next. The session must be the caller's: someone else's reads exactly like one that does not exist. `limit` is the
 * caller's page size and is never defaulted. An API key with `agents:read` may call it: it reads, it never runs.
 */
export function sessionEventsRoute(deps: AgentsRouterDeps, kit: Pick<RunRouteKit, 'guard' | 'ownedSession'>) {
  const { runtime } = deps;
  const { guard, ownedSession } = kit;
  return scopedProcedure('agents:read', { module: 'agents' })
    .input(
      z.object({ sessionId: z.string().guid(), cursor: z.string().max(16).optional(), limit: z.number().int().min(1).max(500) }).strict(),
    )
    .output(z.object({ events: z.array(actionOutput), cursor: z.string().nullable() }))
    .query(({ ctx, input }) =>
      guard(async () => {
        const after = input.cursor === undefined ? null : parseCursor(input.cursor);
        const session = await ownedSession(input.sessionId, ctx.principal.userId);
        const actions = await runtime.audit.forSessionAfter(session.id, after, input.limit);
        const last = actions.at(-1);
        return { events: actions.map(toActionOutput), cursor: last ? String(last.sequence) : after === null ? null : String(after) };
      }),
    );
}
