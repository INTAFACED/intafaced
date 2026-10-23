/**
 * Operator account directory. Search is an exact email or a handle prefix.
 * The email leaves this module only masked. Every search (and every page of
 * one) is audited as a hash. Results come a page at a time in sign-up order;
 * `nextCursor` says exactly whether more match, so a long result is paged,
 * never cut silently.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import type { Context } from '@intafaced/contracts';

export const IDENTITY_ACCOUNT_SEARCH_UNSET = 'identity.account_search_unset' as const;
export const IDENTITY_HANDLE_PREFIX_SHORT = 'identity.handle_prefix_short' as const;
export const IDENTITY_SEARCH_CURSOR_INVALID = 'identity.search_cursor_invalid' as const;

export class AccountDirectoryError extends Error {
  constructor(
    message: string,
    readonly code:
      | typeof IDENTITY_ACCOUNT_SEARCH_UNSET
      | typeof IDENTITY_HANDLE_PREFIX_SHORT
      | typeof IDENTITY_SEARCH_CURSOR_INVALID
      | 'operator.denied',
  ) {
    super(message);
    this.name = 'AccountDirectoryError';
  }
}

export type AccountSearchRow = {
  readonly id: string;
  readonly handle: string;
  readonly status: 'active' | 'frozen' | 'closed';
  readonly created: string;
  readonly kycTier: 'none' | 'basic' | 'full' | 'institutional';
  readonly restrictedAreas: Array<'identity' | 'trading'>;
  readonly emailMasked: string;
};

const SEARCH_CAP = 25;

function requireReader(context: Context, scope: 'admin:compliance' | 'admin:read'): string {
  const principal = context.principal;
  if (!principal || context.service !== null || principal.kid || principal.sub_account || !principal.scopes.includes(scope)) {
    throw new AccountDirectoryError(`${scope} is required`, 'operator.denied');
  }
  return principal.userId;
}

export function maskEmail(email: string): string {
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email.slice(0, 1)}***@${email.slice(at + 1)}`;
}

function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

function likePrefix(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

type SearchInput = { email?: string | undefined; handle?: string | undefined; cursor?: string | undefined };

type Cursor = { readonly createdAt: string; readonly id: string };

const CURSOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The page marker is the last row's sign-up time (as Postgres printed it, full precision) and id. */
function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([cursor.createdAt, cursor.id]), 'utf8').toString('base64url');
}

function decodeCursor(raw: string | undefined): Cursor | null {
  if (raw === undefined) return null;
  const invalid = () =>
    new AccountDirectoryError(
      `This page marker was not issued by the account search (${IDENTITY_SEARCH_CURSOR_INVALID})`,
      IDENTITY_SEARCH_CURSOR_INVALID,
    );
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 2 ||
    typeof parsed[0] !== 'string' ||
    typeof parsed[1] !== 'string' ||
    !CURSOR_ID.test(parsed[1]) ||
    Number.isNaN(Date.parse(parsed[0]))
  ) {
    throw invalid();
  }
  return { createdAt: parsed[0], id: parsed[1] };
}

function searchKey(input: SearchInput): { kind: 'email' | 'handle'; value: string } {
  const email = typeof input.email === 'string' ? normaliseEmail(input.email) : '';
  const handle = typeof input.handle === 'string' ? input.handle.trim() : '';
  const hasEmail = email.length > 0;
  const hasHandle = handle.length > 0;
  if (hasEmail === hasHandle) {
    throw new AccountDirectoryError(`Provide an email or a handle (${IDENTITY_ACCOUNT_SEARCH_UNSET})`, IDENTITY_ACCOUNT_SEARCH_UNSET);
  }
  if (hasHandle && [...handle].length < 3) {
    throw new AccountDirectoryError(
      `Handle prefix must be at least 3 characters (${IDENTITY_HANDLE_PREFIX_SHORT})`,
      IDENTITY_HANDLE_PREFIX_SHORT,
    );
  }
  if (hasHandle && [...handle].length > 32) {
    throw new AccountDirectoryError(
      `Handle prefix must be at least 3 characters (${IDENTITY_HANDLE_PREFIX_SHORT})`,
      IDENTITY_HANDLE_PREFIX_SHORT,
    );
  }
  return hasEmail ? { kind: 'email', value: email } : { kind: 'handle', value: handle };
}

type SqlRow = {
  id: string;
  handle: string;
  status: 'active' | 'frozen' | 'closed';
  created_at: Date;
  created_key: string;
  email: string;
  kyc_tier: 'none' | 'basic' | 'full' | 'institutional';
  identity_restricted: boolean;
  trading_restricted: boolean;
};

export async function searchAccounts(
  sql: Sql,
  context: Context,
  input: SearchInput,
): Promise<{ rows: AccountSearchRow[]; nextCursor: string | null }> {
  const actorId = requireReader(context, 'admin:compliance');
  const key = searchKey(input);
  const after = decodeCursor(input.cursor);
  const pattern = key.kind === 'handle' ? likePrefix(key.value) : null;
  const rows = await sql<SqlRow[]>`
    SELECT u.id,
           u.handle::text AS handle,
           u.status,
           u.created_at,
           u.created_at::text AS created_key,
           u.email::text AS email,
           COALESCE((
             SELECT k.tier::text FROM kyc_records k
             WHERE k.user_id = u.id AND k.status = 'approved' AND (k.expires_at IS NULL OR k.expires_at > now())
             ORDER BY CASE k.tier WHEN 'institutional' THEN 3 WHEN 'full' THEN 2 WHEN 'basic' THEN 1 ELSE 0 END DESC
             LIMIT 1
           ), 'none') AS kyc_tier,
           (u.status = 'frozen') AS identity_restricted,
           EXISTS (SELECT 1 FROM trading_restrictions t WHERE t.user_id = u.id AND t.restricted) AS trading_restricted
    FROM users u
    WHERE (
      (${key.kind} = 'email' AND u.email = ${key.kind === 'email' ? key.value : ''})
      OR (${key.kind} = 'handle' AND u.handle LIKE ${pattern ?? ''} ESCAPE '\\')
    )
    AND (${after === null} OR (u.created_at, u.id) > (${after?.createdAt ?? null}::timestamptz, ${after?.id ?? null}::uuid))
    ORDER BY u.created_at ASC, u.id ASC
    LIMIT ${SEARCH_CAP + 1}
  `;
  const page = rows.slice(0, SEARCH_CAP);
  const last = page.at(-1);
  const queryHash = createHash('sha256').update(`${key.kind}\0${key.value}`).digest('hex');
  await sql`
    INSERT INTO operator_read_audit (audit_id, actor_id, kind, query_hash)
    VALUES (${randomUUID()}, ${actorId}, 'account_search', ${queryHash})
  `;
  return {
    nextCursor: rows.length > SEARCH_CAP && last ? encodeCursor({ createdAt: last.created_key, id: last.id }) : null,
    rows: page.map((row) => ({
      id: row.id,
      handle: row.handle,
      status: row.status,
      created: row.created_at.toISOString(),
      kycTier: row.kyc_tier,
      restrictedAreas: [
        ...(row.identity_restricted ? (['identity'] as const) : []),
        ...(row.trading_restricted ? (['trading'] as const) : []),
      ],
      emailMasked: maskEmail(row.email),
    })),
  };
}

export async function accountCounts(
  sql: Sql,
  context: Context,
): Promise<{
  asOf: string;
  byStatus: { active: number; frozen: number; closed: number };
}> {
  requireReader(context, 'admin:read');
  const rows = await sql<Array<{ as_of: Date; status: 'active' | 'frozen' | 'closed' | null; n: string }>>`
    WITH snap AS (SELECT clock_timestamp() AS as_of)
    SELECT snap.as_of, u.status, count(u.id)::text AS n
    FROM snap
    LEFT JOIN users u ON true
    GROUP BY snap.as_of, u.status
  `;
  const byStatus = { active: 0, frozen: 0, closed: 0 };
  let asOf = new Date();
  for (const row of rows) {
    asOf = row.as_of;
    if (row.status === 'active' || row.status === 'frozen' || row.status === 'closed') {
      byStatus[row.status] = Number(row.n);
    }
  }
  return { asOf: asOf.toISOString(), byStatus };
}
