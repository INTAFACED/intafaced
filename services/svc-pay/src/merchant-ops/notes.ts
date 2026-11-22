import type { Sql } from 'postgres';
import { MerchantOpsError } from './errors.js';
import { iso } from './money.js';
import { decodeCursor, encodeCursor, requireLimit, toPage } from './pagination.js';

/**
 * OPERATOR NOTES: founder-only notes, tags and a flag on a merchant (G7).
 *
 * This file is reachable only from `founderAdmin.ops.notes.*`, every procedure
 * of which is built from `founderProcedure`. No merchant-facing procedure reads
 * `pay.operator_merchant_notes`, and a test pins that by reading the sources.
 *
 * Notes are append-only; "retract" records who withdrew one and why, and the
 * text stays so the operator history is complete.
 */
export interface OperatorNoteView {
  readonly noteId: string;
  readonly merchantId: string;
  readonly body: string;
  readonly tags: string[];
  readonly flagged: boolean;
  readonly authorId: string;
  readonly createdAt: string;
  readonly retractedAt: string | null;
  readonly retractedBy: string | null;
  readonly retractReason: string | null;
}

interface Row {
  id: string;
  merchant_id: string;
  body: string;
  tags: string[];
  flagged: boolean;
  author_id: string;
  created_at: Date;
  retracted_at: Date | null;
  retracted_by: string | null;
  retract_reason: string | null;
  seq_text: string;
}

const view = (r: Row): OperatorNoteView => ({
  noteId: r.id,
  merchantId: r.merchant_id,
  body: r.body,
  tags: r.tags,
  flagged: r.flagged,
  authorId: r.author_id,
  createdAt: iso(r.created_at),
  retractedAt: r.retracted_at ? iso(r.retracted_at) : null,
  retractedBy: r.retracted_by,
  retractReason: r.retract_reason,
});

export class OperatorNotes {
  constructor(private readonly sql: Sql) {}

  private async assertMerchant(merchantId: string) {
    const rows = await this.sql`SELECT 1 FROM pay.merchants WHERE id = ${merchantId}`;
    if (!rows[0]) throw new MerchantOpsError('pay.merchant_not_found', 'not_found');
  }

  async add(founderUserId: string, input: { merchantId: string; body: string; tags: string[]; flagged: boolean }) {
    await this.assertMerchant(input.merchantId);
    const sql = this.sql;
    const rows = await sql<Row[]>`
      INSERT INTO pay.operator_merchant_notes (merchant_id, body, tags, flagged, author_id)
      VALUES (${input.merchantId}, ${input.body}, ${sql.array(input.tags)}::text[], ${input.flagged}, ${founderUserId})
      RETURNING id, seq::text AS seq_text, merchant_id, body, tags, flagged, author_id, created_at, retracted_at, retracted_by, retract_reason`;
    return view(rows[0]!);
  }

  async list(input: {
    merchantId: string;
    limit?: number | undefined;
    cursor?: string;
    flaggedOnly?: boolean;
    includeRetracted?: boolean;
  }) {
    await this.assertMerchant(input.merchantId);
    const limit = requireLimit(input.limit);
    const after = decodeCursor(input.cursor);
    const sql = this.sql;
    const rows = await sql<Row[]>`
      SELECT id, seq::text AS seq_text, merchant_id, body, tags, flagged, author_id, created_at, retracted_at, retracted_by, retract_reason
        FROM pay.operator_merchant_notes
       WHERE merchant_id = ${input.merchantId}
         ${input.flaggedOnly ? sql`AND flagged` : sql``}
         ${input.includeRetracted ? sql`` : sql`AND retracted_at IS NULL`}
         ${after ? sql`AND seq < ${after.key}::bigint` : sql``}
       ORDER BY seq DESC
       LIMIT ${limit + 1}`;
    return toPage(rows, limit, view, (r) => encodeCursor('1970-01-01T00:00:00.000000Z', r.seq_text));
  }

  async retract(founderUserId: string, input: { noteId: string; reason: string }) {
    const rows = await this.sql<Row[]>`
      UPDATE pay.operator_merchant_notes
         SET retracted_at = now(), retracted_by = ${founderUserId}, retract_reason = ${input.reason}
       WHERE id = ${input.noteId}::uuid AND retracted_at IS NULL
      RETURNING id, seq::text AS seq_text, merchant_id, body, tags, flagged, author_id, created_at, retracted_at, retracted_by, retract_reason`;
    if (!rows[0]) throw new MerchantOpsError('pay.note_not_found', 'not_found');
    return view(rows[0]);
  }
}
