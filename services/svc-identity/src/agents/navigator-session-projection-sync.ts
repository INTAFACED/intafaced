import type postgres from 'postgres';

/** Best-effort sync — auth must never fail when projection write fails. */
async function ignoreProjectionError(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch {
    // Projection table may be absent on partial migrations; auth stays authoritative.
  }
}

export async function syncNavigatorSessionOpen(sql: postgres.Sql, sessionId: string, userId: string): Promise<void> {
  await ignoreProjectionError(
    () =>
      sql`
      INSERT INTO navigator_session_projections (session_id, user_id, status)
      VALUES (${sessionId}, ${userId}, 'open')
      ON CONFLICT (session_id) DO UPDATE SET
        user_id = EXCLUDED.user_id,
        status = 'open',
        published_at = now()
    `,
  );
}

export async function syncNavigatorSessionClosed(sql: postgres.Sql, sessionId: string): Promise<void> {
  await ignoreProjectionError(
    () =>
      sql`
      UPDATE navigator_session_projections
      SET status = 'closed', published_at = now()
      WHERE session_id = ${sessionId}
    `,
  );
}

export async function syncNavigatorSessionsClosedForUser(sql: postgres.Sql, userId: string): Promise<void> {
  await ignoreProjectionError(
    () =>
      sql`
      UPDATE navigator_session_projections
      SET status = 'closed', published_at = now()
      WHERE user_id = ${userId} AND status = 'open'
    `,
  );
}
