import type { Sql } from 'postgres';

/**
 * PLACE DOOR for one API key or one session.
 *
 * After the user revokes either credential it cannot place, and its private
 * stream/COD must not keep firing as live. Fail-closed:
 *   - missing / empty / unknown id → denied (no existence oracle)
 *   - revoked (session also: expired) → revoked
 *
 * Ownership snapshots are { id, userId, revoked } only — no scopes, no
 * jurisdiction, no flatten.
 */
export class PlaceDoorError extends Error {
  constructor(
    message: string,
    readonly code: 'auth.api_key_denied' | 'auth.api_key_revoked' | 'auth.session_denied' | 'auth.session_revoked',
  ) {
    super(message);
    this.name = 'PlaceDoorError';
  }
}

export class PlaceDoor {
  constructor(private readonly sql: Sql) {}

  async getApiKeyOwnership(keyId: string): Promise<{ id: string; userId: string; revoked: boolean } | null> {
    const rows = await this.sql<Array<{ id: string; user_id: string; revoked: boolean }>>`
      SELECT id, user_id, revoked
        FROM api_keys
       WHERE id = ${keyId}
       LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    return { id: row.id, userId: row.user_id, revoked: row.revoked };
  }

  async assertApiKeyLive(keyId: string): Promise<{ id: string; userId: string }> {
    const id = typeof keyId === 'string' ? keyId.trim() : '';
    if (!id) {
      throw new PlaceDoorError('API key not found', 'auth.api_key_denied');
    }
    const row = await this.getApiKeyOwnership(id);
    if (!row) {
      throw new PlaceDoorError('API key not found', 'auth.api_key_denied');
    }
    if (row.revoked) {
      throw new PlaceDoorError('API key is revoked', 'auth.api_key_revoked');
    }
    return { id: row.id, userId: row.userId };
  }

  async getSessionOwnership(sessionId: string): Promise<{ id: string; userId: string; revoked: boolean } | null> {
    const rows = await this.sql<Array<{ id: string; user_id: string; revoked: boolean }>>`
      SELECT id, user_id, revoked
        FROM sessions
       WHERE id = ${sessionId}
       LIMIT 1
    `;
    const row = rows[0];
    if (!row) return null;
    return { id: row.id, userId: row.user_id, revoked: row.revoked };
  }

  async assertSessionLive(sessionId: string): Promise<{ id: string; userId: string }> {
    const id = typeof sessionId === 'string' ? sessionId.trim() : '';
    if (!id) {
      throw new PlaceDoorError('Session not found', 'auth.session_denied');
    }
    const rows = await this.sql<Array<{ id: string; user_id: string; revoked: boolean; expires_at: Date }>>`
      SELECT id, user_id, revoked, expires_at
        FROM sessions
       WHERE id = ${id}
       LIMIT 1
    `;
    const row = rows[0];
    if (!row) {
      throw new PlaceDoorError('Session not found', 'auth.session_denied');
    }
    if (row.revoked || row.expires_at.getTime() < Date.now()) {
      throw new PlaceDoorError('Session is revoked', 'auth.session_revoked');
    }
    return { id: row.id, userId: row.user_id };
  }
}
