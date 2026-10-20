import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import type { RestoreWatermarkRead } from '@intafaced/contracts';

/**
 * Identity's `restore.watermark.read` (OPS-ledger-desk-05). This service keeps no single write sequence, so the
 * position is the exact row count over every table in the `identity` schema, and `integrity` is a digest of the
 * per-table counts. A restored area holds the same rows or it does not; the read changes nothing and takes no lock.
 * `lastWriteAt` is the newest `created_at` / `updated_at` in any of those tables, so a write after the operator's
 * cut-off shows. A hard delete lowers the count, which also differs from the stamp.
 */
export const IDENTITY_SCHEMA = 'identity';

export function digestCounts(counts: ReadonlyArray<{ table: string; rows: bigint }>): string {
  const lines = [...counts].sort((a, b) => (a.table < b.table ? -1 : 1)).map((c) => `${c.table}=${c.rows}`);
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

export async function readIdentityWatermark(
  sql: Sql,
  now: Date = new Date(),
  schema: string = IDENTITY_SCHEMA,
): Promise<RestoreWatermarkRead> {
  const counts = await sql<Array<{ t: string; n: string }>>`
    SELECT c.relname AS t,
           (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text AS n
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = ${schema} AND c.relkind = 'r'
     ORDER BY c.relname`;
  const stamped = await sql<Array<{ m: string | null }>>`
    SELECT (xpath('/row/m/text()', query_to_xml(format('SELECT extract(epoch FROM max(%I)) AS m FROM %I.%I', k.column_name, k.table_schema, k.table_name), false, true, '')))[1]::text AS m
      FROM information_schema.columns k
      JOIN information_schema.tables t ON t.table_schema = k.table_schema AND t.table_name = k.table_name AND t.table_type = 'BASE TABLE'
     WHERE k.table_schema = ${schema} AND k.column_name IN ('created_at', 'updated_at')`;
  const rows = counts.map((r) => ({ table: r.t, rows: BigInt(r.n) }));
  const times = stamped.flatMap((r) => (r.m ? [Number(r.m) * 1000] : [])).filter((n) => Number.isFinite(n));
  return {
    service: 'identity',
    kind: 'identity.rows',
    position: rows.reduce((sum, r) => sum + r.rows, 0n).toString(),
    integrity: digestCounts(rows),
    lastWriteAt: times.length ? new Date(Math.max(...times)).toISOString() : null,
    readAt: now.toISOString(),
  };
}
