/**
 * Operator account directory. Search is an exact email or a handle prefix.
 * The email leaves this module only masked. Every search is audited as a hash.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import type { Context } from '@intafaced/contracts';

export const IDENTITY_ACCOUNT_SEARCH_UNSET = 'identity.account_search_unset' as const;
export const IDENTITY_HANDLE_PREFIX_SHORT = 'identity.handle_prefix_short' as const;

export class AccountDirectoryError extends Error {
  constructor(
    message: string,
    readonly code: typeof IDENTITY_ACCOUNT_SEARCH_UNSET | typeof IDENTITY_HANDLE_PREFIX_SHORT | 'operator.denied',
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

type SearchInput = { email?: string | undefined; handle?: string | undefined };

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
  email: string;
  kyc_tier: 'none' | 'basic' | 'full' | 'institutional';
  identity_restricted: boolean;
  trading_restricted: boolean;
};

export async function searchAccounts(sql: Sql, context: Context, input: SearchInput): Promise<{ rows: AccountSearchRow[] }> {
  const actorId = requireReader(context, 'admin:compliance');
  const key = searchKey(input);
  const pattern = key.kind === 'handle' ? likePrefix(key.value) : null;
  const rows = await sql<SqlRow[]>`
    SELECT u.id,
           u.handle::text AS handle,
           u.status,
           u.created_at,
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
    ORDER BY u.created_at ASC, u.id ASC
    LIMIT ${SEARCH_CAP}
  `;
  const queryHash = createHash('sha256').update(`${key.kind}\0${key.value}`).digest('hex');
  await sql`
    INSERT INTO operator_read_audit (audit_id, actor_id, kind, query_hash)
    VALUES (${randomUUID()}, ${actorId}, 'account_search', ${queryHash})
  `;
  return {
    rows: rows.map((row) => ({
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
