import type postgres from 'postgres';
import { transaction } from '@intafaced/db';
import { lockFounderControls } from '../controls/founder-control-lock.js';

/** Best-effort sync — auth must never fail when projection write fails. */
async function ignoreProjectionError(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Projection table may be absent on partial migrations; auth stays authoritative.
  }
}

export async function syncNavigatorSessionOpen(sql: postgres.Sql, sessionId: string, userId: string): Promise<void> {
  await ignoreProjectionError(() =>
    transaction(
      sql,
      async (tx) => {
        await lockFounderControls(tx);
        await tx`
      INSERT INTO navigator_session_projections (session_id, user_id, status)
      SELECT s.id::text, s.user_id::text, 'open'
      FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.id = ${sessionId}::uuid AND u.id = ${userId}::uuid
        AND u.status = 'active' AND NOT s.revoked AND s.expires_at > clock_timestamp()
      ON CONFLICT (session_id) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        status = 'open',
        published_at = now()
    `;
      },
      { isolation: 'read committed' },
    ),
  );
}

export async function syncNavigatorSessionClosed(sql: postgres.Sql, sessionId: string): Promise<void> {
  await ignoreProjectionError(() =>
    transaction(
      sql,
      async (tx) => {
        await lockFounderControls(tx);
        await tx`
      UPDATE navigator_session_projections
      SET status = 'closed', published_at = now()
      WHERE session_id = ${sessionId}
    `;
      },
      { isolation: 'read committed' },
    ),
  );
}

export async function syncNavigatorSessionsClosedForUser(sql: postgres.Sql, userId: string): Promise<void> {
  await ignoreProjectionError(() =>
    transaction(
      sql,
      async (tx) => {
        await lockFounderControls(tx);
        await tx`
      UPDATE navigator_session_projections
      SET status = 'closed', published_at = now()
      WHERE user_id = ${userId} AND status = 'open'
    `;
      },
      { isolation: 'read committed' },
    ),
  );
}
