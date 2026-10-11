import type postgres from 'postgres';
import { z } from 'zod';
import { transaction } from '@intafaced/db';
import { lockFounderControls } from '../controls/founder-control-lock.js';
import type { NavigatorSessionOk } from './navigator-session-routes.js';

export type NavigatorSessionProjection = NavigatorSessionOk['session'];
export type NavigatorSessionStore = {
  readSession(sessionId: string): Promise<NavigatorSessionProjection | null>;
  publishSession(session: NavigatorSessionProjection): Promise<void>;
  refreshFromAuthSessions(): Promise<number>;
};

export class NavigatorSessionPublishError extends Error {
  readonly code = 'session_authority_denied';
  constructor() {
    super('A matching durable session with current authority is required');
    this.name = 'NavigatorSessionPublishError';
  }
}
const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
type AuthSessionRow = { id: string; user_id: string; revoked: boolean; expires_at: Date; user_status: 'active' | 'frozen' | 'closed' };

/** Durable owner and current identity status determine whether a session is open. */
export function mapAuthSessionRow(row: AuthSessionRow, now = new Date()): NavigatorSessionProjection {
  return {
    sessionId: row.id,
    userId: row.user_id,
    status: row.user_status === 'active' && !row.revoked && row.expires_at > now ? 'open' : 'closed',
  };
}

export function createNavigatorSessionStore(sql: postgres.Sql): NavigatorSessionStore {
  return {
    async readSession(rawId) {
      const parsed = uuid.safeParse(rawId);
      if (!parsed.success) return null;
      return transaction(
        sql,
        async (tx) => {
          await lockFounderControls(tx);
          const [auth] = await tx<AuthSessionRow[]>`
          SELECT s.id, s.user_id, s.revoked, s.expires_at, u.status AS user_status
          FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ${parsed.data}::uuid
        `;
          if (!auth) return null;
          const [projection] = await tx<Array<{ status: 'open' | 'closed' }>>`
          SELECT status FROM navigator_session_projections WHERE session_id = ${parsed.data}
        `;
          const current = mapAuthSessionRow(auth);
          // A projection may conservatively close a real session. It can never
          // substitute its owner or open a revoked/frozen/expired identity.
          return projection?.status === 'closed' ? { ...current, status: 'closed' as const } : current;
        },
        { isolation: 'read committed' },
      );
    },
    async publishSession(session) {
      const sessionId = uuid.safeParse(session.sessionId);
      const userId = uuid.safeParse(session.userId);
      if (!sessionId.success || !userId.success || (session.status !== 'open' && session.status !== 'closed'))
        throw new NavigatorSessionPublishError();
      await transaction(
        sql,
        async (tx) => {
          await lockFounderControls(tx);
          const written = await tx<Array<{ session_id: string }>>`
          INSERT INTO navigator_session_projections (session_id, user_id, status)
          SELECT s.id::text, s.user_id::text, ${session.status}::text
          FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.id = ${sessionId.data}::uuid AND s.user_id = ${userId.data}::uuid
            AND (${session.status} = 'closed' OR (u.status = 'active' AND NOT s.revoked AND s.expires_at > clock_timestamp()))
          ON CONFLICT (session_id) DO UPDATE SET user_id = EXCLUDED.user_id, status = EXCLUDED.status, published_at = now()
          RETURNING session_id
        `;
          if (!written.length) throw new NavigatorSessionPublishError();
        },
        { isolation: 'read committed' },
      );
    },
    async refreshFromAuthSessions() {
      return transaction(
        sql,
        async (tx) => {
          await lockFounderControls(tx);
          await tx`
          UPDATE navigator_session_projections p SET status = 'closed', published_at = now()
          WHERE NOT EXISTS (SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
            WHERE s.id::text = p.session_id AND s.user_id::text = p.user_id
              AND u.status = 'active' AND NOT s.revoked AND s.expires_at > clock_timestamp())
        `;
          // Reload and materialize in the guarded statement; no earlier scan can
          // resurrect a session after a founder restriction or logout.
          const written = await tx<Array<{ session_id: string }>>`
          INSERT INTO navigator_session_projections (session_id, user_id, status)
          SELECT s.id::text, s.user_id::text,
            CASE WHEN u.status = 'active' AND NOT s.revoked AND s.expires_at > clock_timestamp() THEN 'open' ELSE 'closed' END
          FROM sessions s JOIN users u ON u.id = s.user_id
          ON CONFLICT (session_id) DO UPDATE SET user_id = EXCLUDED.user_id, status = EXCLUDED.status, published_at = now()
          RETURNING session_id
        `;
          return written.length;
        },
        { isolation: 'read committed' },
      );
    },
  };
}
