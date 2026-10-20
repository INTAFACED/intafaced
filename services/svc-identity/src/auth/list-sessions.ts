/**
 * List live sessions for one named user. Operator before/after panic.
 * Live = revoked false. Missing userId refuses. Limit required — omit never dumps seats.
 * No other user. No secrets.
 */
import type { Sql } from 'postgres';
import { requireUserId } from './revoke-all-api-keys.js';
import { maskIp } from './request-meta.js';

export type LiveSession = {
  id: string;
  familyId: string;
  createdAt: Date;
  lastUsedAt: Date;
  device: string | null;
  userAgent: string | null;
  /** Last part hidden. The stored address never leaves the service. */
  ip: string | null;
  country: string | null;
  isCurrent: boolean;
  revoked: false;
};

export class ListSessionsError extends Error {
  constructor(
    message: string,
    readonly code: 'auth.user_id_missing' | 'identity.cursor_invalid',
  ) {
    super(message);
    this.name = 'ListSessionsError';
  }
}

/** Blank / non-integer / out of 1..200 live-seats window. Never invent a page size. */
export const IDENTITY_SESSIONS_LIST_LIMIT_UNSET = 'identity.sessions_list_limit_unset' as const;
export const SESSIONS_LIST_LIMIT_MAX = 200;

export class SessionsListLimitUnsetError extends Error {
  constructor(
    message: string,
    readonly code: typeof IDENTITY_SESSIONS_LIST_LIMIT_UNSET,
  ) {
    super(message);
    this.name = 'SessionsListLimitUnsetError';
  }
}

/** Owner-published live-seats window. Missing / null / non-int / out of 1..max refuses. */
export function publishedSessionsListLimit(value: number | undefined | null): number {
  if (value === undefined || value === null || !Number.isInteger(value) || value < 1 || value > SESSIONS_LIST_LIMIT_MAX) {
    throw new SessionsListLimitUnsetError('Sessions list limit is unset — refuse to dump live seats', IDENTITY_SESSIONS_LIST_LIMIT_UNSET);
  }
  return value;
}

export function requireListSessionsUserId(value: string | null | undefined): string {
  try {
    return requireUserId(value);
  } catch {
    throw new ListSessionsError('userId is required', 'auth.user_id_missing');
  }
}

function encodeCursor(row: { created_at: Date; id: string }): string {
  return Buffer.from(`${row.created_at.toISOString()}|${row.id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const createdAt = new Date(at ?? '');
  if (!id || Number.isNaN(createdAt.getTime()) || !/^[0-9a-f-]{36}$/i.test(id)) {
    throw new ListSessionsError('That page cursor is not valid', 'identity.cursor_invalid');
  }
  return { createdAt, id };
}

/**
 * One row per live sign-in family, newest first. A family's only live row is its newest, so five
 * refreshes on one device are still one row. `currentSessionId` marks the caller's own device.
 */
export async function listSessions(
  sql: Sql,
  namedUserId: string | null | undefined,
  limit: number,
  options: { cursor?: string | null | undefined; currentSessionId?: string | null | undefined } = {},
): Promise<{ userId: string; sessions: LiveSession[]; nextCursor: string | null }> {
  const named = requireListSessionsUserId(namedUserId);
  const published = publishedSessionsListLimit(limit);
  const after = options.cursor ? decodeCursor(options.cursor) : null;
  const rows = await sql<
    Array<{
      id: string;
      family_id: string;
      created_at: Date;
      last_used_at: Date;
      device: string | null;
      user_agent: string | null;
      ip: string | null;
      country: string | null;
    }>
  >`
    SELECT id, family_id, created_at, last_used_at, device, user_agent, ip, country
    FROM (
      SELECT DISTINCT ON (family_id) id, family_id, created_at, last_used_at, device, user_agent, ip, country
      FROM sessions
      WHERE user_id = ${named} AND revoked = false AND expires_at > now()
      ORDER BY family_id, created_at DESC, id DESC
    ) live
    WHERE ${after ? sql`(created_at, id) < (${after.createdAt}, ${after.id})` : sql`true`}
    ORDER BY created_at DESC, id DESC
    LIMIT ${published + 1}
  `;
  const page = rows.slice(0, published);
  const last = page[page.length - 1];
  return {
    userId: named,
    sessions: page.map((row) => ({
      id: row.id,
      familyId: row.family_id,
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at,
      device: row.device,
      userAgent: row.user_agent,
      ip: maskIp(row.ip),
      country: row.country,
      isCurrent: options.currentSessionId === row.id,
      revoked: false as const,
    })),
    nextCursor: rows.length > published && last ? encodeCursor(last) : null,
  };
}
