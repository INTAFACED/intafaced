import type postgres from 'postgres';
import type { NavigatorSessionOk } from './navigator-session-routes.js';

export type NavigatorSessionProjection = NavigatorSessionOk['session'];

export type NavigatorSessionStore = {
  readSession(sessionId: string): Promise<NavigatorSessionProjection | null>;
  publishSession(session: NavigatorSessionProjection): Promise<void>;
  refreshFromAuthSessions(): Promise<number>;
};

type ProjectionRow = {
  session_id: string;
  user_id: string;
  status: 'open' | 'closed';
};

type AuthSessionRow = {
  id: string;
  user_id: string;
  revoked: boolean;
  expires_at: Date;
};

function rowToSession(row: ProjectionRow): NavigatorSessionProjection {
  return {
    sessionId: row.session_id,
    userId: row.user_id,
    status: row.status,
  };
}

/** Map durable auth session row — never invents an open session. */
export function mapAuthSessionRow(row: AuthSessionRow, now: Date = new Date()): NavigatorSessionProjection {
  const open = !row.revoked && row.expires_at.getTime() > now.getTime();
  return {
    sessionId: row.id,
    userId: row.user_id,
    status: open ? 'open' : 'closed',
  };
}

async function readAuthSessionRow(sql: postgres.Sql, sessionId: string): Promise<AuthSessionRow | null> {
  try {
    const authRows = await sql<AuthSessionRow[]>`
      SELECT id, user_id, revoked, expires_at
      FROM sessions
      WHERE id = ${sessionId}::uuid
      LIMIT 1
    `;
    return authRows[0] ?? null;
  } catch {
    return null;
  }
}

export function createNavigatorSessionStore(sql: postgres.Sql): NavigatorSessionStore {
  return {
    async readSession(sessionId) {
      const projected = await sql<ProjectionRow[]>`
        SELECT session_id, user_id, status
        FROM navigator_session_projections
        WHERE session_id = ${sessionId}
        LIMIT 1
      `;
      const projection = projected[0];
      if (projection) {
        // Auth is truth. A stale `open` projection must not keep stream/COD live.
        if (projection.status === 'open') {
          const auth = await readAuthSessionRow(sql, sessionId);
          if (!auth || mapAuthSessionRow(auth).status === 'closed') {
            const closed: NavigatorSessionProjection = {
              sessionId: projection.session_id,
              userId: projection.user_id,
              status: 'closed',
            };
            try {
              await this.publishSession(closed);
            } catch {
              // Projection write is best-effort; the read already returns closed.
            }
            return closed;
          }
        }
        return rowToSession(projection);
      }

      const auth = await readAuthSessionRow(sql, sessionId);
      return auth ? mapAuthSessionRow(auth) : null;
    },
    async publishSession(session) {
      await sql`
        INSERT INTO navigator_session_projections (session_id, user_id, status)
        VALUES (${session.sessionId}, ${session.userId}, ${session.status})
        ON CONFLICT (session_id) DO UPDATE SET
          user_id = EXCLUDED.user_id,
          status = EXCLUDED.status,
          published_at = now()
      `;
    },
    async refreshFromAuthSessions() {
      const rows = await sql<AuthSessionRow[]>`
        SELECT id, user_id, revoked, expires_at
        FROM sessions
      `;
      const now = new Date();
      for (const row of rows) {
        await this.publishSession(mapAuthSessionRow(row, now));
      }
      return rows.length;
    },
  };
}
