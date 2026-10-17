/**
 * Currently restricted accounts. Identity (status frozen) and trading
 * (trading_restrictions.restricted). A lifted row is not here. No email, no name.
 * Reason and actor are the ones stored on the restrict audit, not invented.
 */
import type { Sql } from 'postgres';
import type { Context } from '@intafaced/contracts';

export class RestrictedListDeniedError extends Error {
  readonly code = 'operator.denied' as const;
  constructor() {
    super('admin:read is required');
    this.name = 'RestrictedListDeniedError';
  }
}

export const IDENTITY_RESTRICTED_LIST_LIMIT_UNSET = 'identity.restricted_list_limit_unset' as const;
export const IDENTITY_RESTRICTED_LIST_CURSOR_INVALID = 'identity.restricted_list_cursor_invalid' as const;
export const RESTRICTED_LIST_LIMIT_MAX = 200;

export class RestrictedListLimitUnsetError extends Error {
  readonly code = IDENTITY_RESTRICTED_LIST_LIMIT_UNSET;
  constructor() {
    super(`Restricted-account list limit is unset (${IDENTITY_RESTRICTED_LIST_LIMIT_UNSET})`);
    this.name = 'RestrictedListLimitUnsetError';
  }
}

export class RestrictedListCursorError extends Error {
  readonly code = IDENTITY_RESTRICTED_LIST_CURSOR_INVALID;
  constructor() {
    super(`Restricted-account list cursor is invalid (${IDENTITY_RESTRICTED_LIST_CURSOR_INVALID})`);
    this.name = 'RestrictedListCursorError';
  }
}

export type RestrictedAccountRow = {
  readonly accountId: string;
  readonly area: 'identity' | 'trading';
  readonly since: string;
  readonly reason: string;
  readonly actor: string;
};

export type RestrictedAccountPage = {
  readonly rows: RestrictedAccountRow[];
  readonly nextCursor: string | null;
};

type Cursor = { readonly sinceUs: string; readonly accountId: string; readonly area: 'identity' | 'trading' };

function publishedLimit(value: number | undefined | null): number {
  if (value === undefined || value === null || !Number.isInteger(value) || value < 1 || value > RESTRICTED_LIST_LIMIT_MAX) {
    throw new RestrictedListLimitUnsetError();
  }
  return value;
}

function decodeCursor(raw: string | undefined): Cursor | null {
  if (raw === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw new RestrictedListCursorError();
  }
  if (!parsed || typeof parsed !== 'object') throw new RestrictedListCursorError();
  const row = parsed as { sinceUs?: unknown; accountId?: unknown; area?: unknown };
  if (typeof row.sinceUs !== 'string' || !/^[0-9]+$/.test(row.sinceUs)) throw new RestrictedListCursorError();
  if (typeof row.accountId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.accountId)) {
    throw new RestrictedListCursorError();
  }
  if (row.area !== 'identity' && row.area !== 'trading') throw new RestrictedListCursorError();
  return { sinceUs: row.sinceUs, accountId: row.accountId.toLowerCase(), area: row.area };
}

function encodeCursor(row: { sinceUs: string; accountId: string; area: string }): string {
  return Buffer.from(JSON.stringify({ sinceUs: row.sinceUs, accountId: row.accountId, area: row.area }), 'utf8').toString('base64url');
}

export function assertRestrictedListReader(context: Context): void {
  const principal = context.principal;
  if (!principal || context.service !== null || principal.kid || principal.sub_account || !principal.scopes.includes('admin:read')) {
    throw new RestrictedListDeniedError();
  }
}

type SqlRow = {
  account_id: string;
  area: 'identity' | 'trading';
  since: Date;
  reason: string;
  actor: string;
  since_us: string;
};

export async function listRestrictedAccounts(
  sql: Sql,
  input: { area?: 'identity' | 'trading' | undefined; limit?: number | null | undefined; cursor?: string | undefined },
): Promise<RestrictedAccountPage> {
  const limit = publishedLimit(input.limit);
  const cursor = decodeCursor(input.cursor);
  const area = input.area ?? null;
  const rows = await sql<SqlRow[]>`
    WITH current AS (
      SELECT u.id AS account_id,
             'identity'::text AS area,
             a.since,
             a.reason,
             a.actor,
             a.since_us
      FROM users u
      JOIN LATERAL (
        SELECT (result->>'occurredAt')::timestamptz AS since,
               result->>'reason' AS reason,
               lower(result->>'actorUserId') AS actor,
               (EXTRACT(EPOCH FROM (result->>'occurredAt')::timestamptz) * 1000000)::bigint::text AS since_us
        FROM founder_control_audit
        WHERE kind = 'identity'
          AND result->>'outcome' = 'changed'
          AND result->>'action' = 'restrict'
          AND result->'target'->>'area' = 'identity'
          AND lower(result->'target'->>'userId') = u.id::text
          AND result->>'reason' IS NOT NULL
          AND result->>'actorUserId' IS NOT NULL
        ORDER BY created_at DESC, audit_id DESC
        LIMIT 1
      ) a ON true
      WHERE u.status = 'frozen'
        AND (${area}::text IS NULL OR ${area}::text = 'identity')
      UNION ALL
      SELECT t.user_id,
             'trading'::text,
             a.since,
             a.reason,
             a.actor,
             a.since_us
      FROM trading_restrictions t
      JOIN LATERAL (
        SELECT (result->>'occurredAt')::timestamptz AS since,
               result->>'reason' AS reason,
               lower(result->>'actorUserId') AS actor,
               (EXTRACT(EPOCH FROM (result->>'occurredAt')::timestamptz) * 1000000)::bigint::text AS since_us
        FROM founder_control_audit
        WHERE kind = 'identity'
          AND result->>'outcome' = 'changed'
          AND result->>'action' = 'restrict'
          AND result->'target'->>'area' = 'trading'
          AND lower(result->'target'->>'userId') = t.user_id::text
          AND result->>'reason' IS NOT NULL
          AND result->>'actorUserId' IS NOT NULL
        ORDER BY created_at DESC, audit_id DESC
        LIMIT 1
      ) a ON true
      WHERE t.restricted = true
        AND (${area}::text IS NULL OR ${area}::text = 'trading')
    )
    SELECT account_id, area, since, reason, actor, since_us
    FROM current
    WHERE (
      ${cursor?.sinceUs ?? null}::bigint IS NULL
      OR since_us::bigint < ${cursor?.sinceUs ?? null}::bigint
      OR (
        since_us::bigint = ${cursor?.sinceUs ?? null}::bigint
        AND account_id < ${cursor?.accountId ?? null}::uuid
      )
      OR (
        since_us::bigint = ${cursor?.sinceUs ?? null}::bigint
        AND account_id = ${cursor?.accountId ?? null}::uuid
        AND area < ${cursor?.area ?? null}
      )
    )
    ORDER BY since_us::bigint DESC, account_id DESC, area DESC
    LIMIT ${limit + 1}
  `;
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    rows: page.map((row) => ({
      accountId: row.account_id,
      area: row.area,
      since: row.since.toISOString(),
      reason: row.reason,
      actor: row.actor,
    })),
    nextCursor: rows.length > limit && last ? encodeCursor({ sinceUs: last.since_us, accountId: last.account_id, area: last.area }) : null,
  };
}
