import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import type { RestoreWatermarkRead } from '@intafaced/contracts';

/**
 * Identity's `restore.watermark.read` (OPS-ledger-desk-05). This service keeps no single write sequence, so the
 * position is the exact row count over the business tables of the `identity` schema, and `integrity` is a digest of
 * their per-table counts. A restored area holds the same rows or it does not; the read changes nothing and takes no
 * lock. `lastWriteAt` is the newest `created_at` / `updated_at` in those tables, so a write after the operator's
 * cut-off shows. A hard delete lowers the count, which also differs from the stamp.
 *
 * Operator traffic is left out (OPERATOR_TRAFFIC_TABLES): the restore drill itself requests and approves each stamp,
 * signs founders in and mails them, all after the stamps are taken and while the posting freeze holds, so counting
 * those rows would make identity disagree with its own stamp every time (J-ops-console-08 #7). A table added later
 * counts unless it is named below.
 */
export const IDENTITY_SCHEMA = 'identity';

export const WATERMARK_KIND = 'identity.business_rows';

/** Each table left out of the watermark, and why: every one is written by signing in or by approving an operator action. */
export const OPERATOR_TRAFFIC_TABLES: Readonly<Record<string, string>> = {
  action_approvals: 'four-eyes requests: the drill requests each stamp and the finalize step here',
  action_approval_votes: 'the votes on those requests',
  sessions: 'signed-in sessions and their refresh tokens, opened by every sign-in',
  session_revoke_receipts: 'receipts of signing out',
  navigator_session_projections: 'a projection of sessions',
  auth_attempts: 'sign-in attempts',
  auth_flows: 'sign-in ceremonies in progress',
  webauthn_challenges: 'passkey ceremony challenges',
  device_authorisations: 'new-device approvals at sign-in',
  oauth_codes: 'one-time authorisation codes of a sign-in',
  customer_step_ups: 'confirmations given before a sensitive action',
  step_up_audit: 'the audit of those confirmations',
  founder_control_audit: 'the audit of founder console actions',
  founder_session_scope_audit: 'the audit of founder session scopes, written at founder sign-in',
  operator_read_audit: "the audit of operators' reads",
  api_key_request_nonces: 'per-request replay nonces',
  mail_outbox: 'mail waiting to be sent, such as sign-in codes and new-device notices',
};

/**
 * For these business tables `lastWriteAt` reads `created_at` only: signing in advances the second-factor counters
 * (authenticator step, passkey sign count) and touches `updated_at`, which says nothing about restored data. Their
 * rows still count in the position.
 */
export const CREATED_AT_ONLY_TABLES: Readonly<Record<string, string>> = {
  users: 'a sign-in with the authenticator or a passkey moves totp_last_step or the sign count and updated_at',
};

export function digestCounts(counts: ReadonlyArray<{ table: string; rows: bigint }>): string {
  const lines = [...counts].sort((a, b) => (a.table < b.table ? -1 : 1)).map((c) => `${c.table}=${c.rows}`);
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

export async function readIdentityWatermark(
  sql: Sql,
  now: Date = new Date(),
  schema: string = IDENTITY_SCHEMA,
): Promise<RestoreWatermarkRead> {
  const skipped = Object.keys(OPERATOR_TRAFFIC_TABLES);
  const createdOnly = Object.keys(CREATED_AT_ONLY_TABLES);
  const counts = await sql<Array<{ t: string; n: string }>>`
    SELECT c.relname AS t,
           (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text AS n
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ${schema} AND c.relkind = 'r' AND NOT (c.relname = ANY(${skipped}))
     ORDER BY c.relname`;
  const stamped = await sql<Array<{ m: string | null }>>`
    SELECT (xpath('/row/m/text()', query_to_xml(format('SELECT extract(epoch FROM max(%I)) AS m FROM %I.%I', k.column_name, k.table_schema, k.table_name), false, true, '')))[1]::text AS m
      FROM information_schema.columns k
      JOIN information_schema.tables t ON t.table_schema = k.table_schema AND t.table_name = k.table_name AND t.table_type = 'BASE TABLE'
     WHERE k.table_schema = ${schema} AND k.column_name IN ('created_at', 'updated_at')
       AND NOT (k.table_name = ANY(${skipped}))
       AND NOT (k.column_name = 'updated_at' AND k.table_name = ANY(${createdOnly}))`;
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
