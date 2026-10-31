import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import type { RestoreWatermarkRead } from '@intafaced/contracts';

/**
 * Identity's `restore.watermark.read` (OPS-ledger-desk-05). This service keeps no single write sequence, so the
 * position is the exact row count over the business tables of the `identity` schema, and `integrity` is a digest of
 * their per-table counts, with approvals counted per status so a revoke or a rejection shows there. A restored area
 * holds the same rows or it does not; the read changes nothing and takes no lock. `lastWriteAt` is the newest
 * `created_at` / `updated_at` in those tables (and an approval's or vote's own times), so a write after the
 * operator's cut-off shows. A hard delete lowers the count, which also differs from the stamp.
 *
 * Operator traffic is left out: the restore drill itself requests and approves each stamp and signs founders in, after
 * the stamps are taken and while the posting freeze holds, so counting those rows would make identity disagree with
 * its own stamp every time (J-ops-console-08 #7). A table added later counts unless it is named below. Sign-in also
 * never touches `users.updated_at` (the authenticator step, the passkey sign count and a password rehash leave it).
 */
export const IDENTITY_SCHEMA = 'identity';

export const WATERMARK_KIND = 'identity.business_rows';

/**
 * Each table left out of the watermark, and why: sign-in traffic or a ceremony's short-lived state. Measured on the
 * stack over J-ops-console-08: the drill grew sessions, their projection and the founder scope audit, and nothing else
 * of identity's but the restore approvals below. A person's explicit revocations still count (`session_revoke_receipts`),
 * as do trusted devices and device approvals.
 */
export const OPERATOR_TRAFFIC_TABLES: Readonly<Record<string, string>> = {
  sessions: 'signed-in sessions and their refresh tokens, opened by every sign-in and rotated by every refresh',
  navigator_session_projections: 'a projection of sessions, written with each one',
  founder_session_scope_audit: 'the scopes a founder session was given, written at every founder sign-in',
  auth_attempts: 'failed-attempt counters of signing in',
  auth_flows: 'sign-in ceremonies in progress',
  webauthn_challenges: 'passkey ceremony challenges',
  social_flows: 'social sign-in ceremonies in progress',
  mail_outbox: 'mail waiting to be sent, such as sign-in codes and new-device notices',
};

/**
 * Approval requests for the restore itself (`ops.restore.record` and the rest of `ops.restore.*`) are left out of these
 * two tables: the drill asks for one at each stamp and at the finalize. Every other approval counts, per status, with
 * its votes, since a restore that loses or brings one back changes what may happen next.
 */
export const RESTORE_APPROVAL_PREFIX = 'ops.restore.';
export const APPROVAL_TABLES = ['action_approvals', 'action_approval_votes'] as const;

export function digestCounts(counts: ReadonlyArray<{ table: string; rows: bigint }>): string {
  const lines = [...counts].sort((a, b) => (a.table < b.table ? -1 : 1)).map((c) => `${c.table}=${c.rows}`);
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

export async function readIdentityWatermark(
  sql: Sql,
  now: Date = new Date(),
  schema: string = IDENTITY_SCHEMA,
): Promise<RestoreWatermarkRead> {
  const skipped = [...Object.keys(OPERATOR_TRAFFIC_TABLES), ...APPROVAL_TABLES];
  const own = `${RESTORE_APPROVAL_PREFIX}%`;
  const approvals = sql`${sql(schema)}.action_approvals`;
  const votes = sql`${sql(schema)}.action_approval_votes`;
  const counts = await sql<Array<{ t: string; n: string }>>`
    SELECT c.relname AS t,
           (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text AS n
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ${schema} AND c.relkind = 'r' AND NOT (c.relname = ANY(${skipped}))
    UNION ALL
    SELECT 'action_approvals.' || status, count(*)::text FROM ${approvals} WHERE action_type NOT LIKE ${own} GROUP BY status
    UNION ALL
    SELECT 'action_approval_votes', count(*)::text
      FROM ${votes} v JOIN ${approvals} a ON a.approval_id = v.approval_id WHERE a.action_type NOT LIKE ${own}`;
  const stamped = await sql<Array<{ m: string | null }>>`
    SELECT (xpath('/row/m/text()', query_to_xml(format('SELECT extract(epoch FROM max(%I)) AS m FROM %I.%I', k.column_name, k.table_schema, k.table_name), false, true, '')))[1]::text AS m
      FROM information_schema.columns k
      JOIN information_schema.tables t ON t.table_schema = k.table_schema AND t.table_name = k.table_name AND t.table_type = 'BASE TABLE'
     WHERE k.table_schema = ${schema} AND k.column_name IN ('created_at', 'updated_at') AND NOT (k.table_name = ANY(${skipped}))
    UNION ALL
    SELECT extract(epoch FROM max(greatest(created_at, approved_at, consumed_at)))::text
      FROM ${approvals} WHERE action_type NOT LIKE ${own}
    UNION ALL
    SELECT extract(epoch FROM max(v.approved_at))::text
      FROM ${votes} v JOIN ${approvals} a ON a.approval_id = v.approval_id WHERE a.action_type NOT LIKE ${own}`;
  const rows = counts.map((r) => ({ table: r.t, rows: BigInt(r.n) }));
  const times = stamped.flatMap((r) => (r.m ? [Number(r.m) * 1000] : [])).filter((n) => Number.isFinite(n));
  return {
    service: 'identity',
    kind: WATERMARK_KIND,
    position: rows.reduce((sum, r) => sum + r.rows, 0n).toString(),
    integrity: digestCounts(rows),
    lastWriteAt: times.length ? new Date(Math.max(...times)).toISOString() : null,
    readAt: now.toISOString(),
  };
}
