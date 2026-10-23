/** Postgres store for incident postmortems, on the tables of 0031_notify_status_postmortems.sql. */
import type { Sql } from 'postgres';
import type { Postmortem, PostmortemStore } from './postmortems.js';

type Row = {
  incident_id: string;
  body: string;
  version: number;
  status: 'draft' | 'published';
  written_by: string;
  written_at: Date;
  published_at: Date | null;
};

const COLUMNS = 'incident_id, body, version, status, written_by, written_at, published_at';

const fromRow = (row: Row): Postmortem => ({
  incidentId: row.incident_id,
  body: row.body,
  version: row.version,
  status: row.status,
  writtenBy: row.written_by,
  writtenAt: row.written_at.toISOString(),
  publishedAt: row.published_at?.toISOString() ?? null,
});

export class SqlPostmortemStore implements PostmortemStore {
  constructor(private readonly sql: Sql) {}

  async get(incidentId: string): Promise<Postmortem | null> {
    const [row] = await this.sql<
      Row[]
    >`SELECT ${this.sql.unsafe(COLUMNS)} FROM notify.status_postmortems WHERE incident_id = ${incidentId}`;
    return row ? fromRow(row) : null;
  }

  async write(
    row: { incidentId: string; body: string; writtenBy: string; at: Date },
    expectedVersion: number,
  ): Promise<Postmortem | 'stale' | 'published'> {
    if (expectedVersion === 0) {
      const inserted = await this.sql<Row[]>`
        INSERT INTO notify.status_postmortems (incident_id, body, version, status, written_by, written_at)
        VALUES (${row.incidentId}, ${row.body}, 1, 'draft', ${row.writtenBy}, ${row.at})
        ON CONFLICT (incident_id) DO NOTHING
        RETURNING ${this.sql.unsafe(COLUMNS)}
      `;
      if (inserted[0]) return fromRow(inserted[0]);
    } else {
      const updated = await this.sql<Row[]>`
        UPDATE notify.status_postmortems
           SET body = ${row.body}, version = version + 1, written_by = ${row.writtenBy}, written_at = ${row.at}
         WHERE incident_id = ${row.incidentId} AND version = ${expectedVersion} AND status = 'draft'
        RETURNING ${this.sql.unsafe(COLUMNS)}
      `;
      if (updated[0]) return fromRow(updated[0]);
    }
    const current = await this.get(row.incidentId);
    return current?.status === 'published' ? 'published' : 'stale';
  }

  async approvalOutcome(approvalId: string): Promise<'published' | 'refused_same_operator' | null> {
    const [row] = await this.sql<{ outcome: 'published' | 'refused_same_operator' }[]>`
      SELECT outcome FROM notify.status_postmortem_approval_uses WHERE approval_id = ${approvalId}
    `;
    return row?.outcome ?? null;
  }

  async recordRefusal(approvalId: string, incidentId: string, publisherId: string): Promise<void> {
    await this.sql`
      INSERT INTO notify.status_postmortem_approval_uses (approval_id, incident_id, publisher_id, outcome)
      VALUES (${approvalId}, ${incidentId}, ${publisherId}, 'refused_same_operator')
      ON CONFLICT (approval_id) DO NOTHING
    `;
  }

  async publishWith(
    incidentId: string,
    version: number,
    patch: { approvalId: string; publishedBy: string; at: Date },
  ): Promise<'published' | 'spent' | 'stale'> {
    const stale = Symbol('stale');
    try {
      return await this.sql.begin(async (tx) => {
        const used = await tx`
          INSERT INTO notify.status_postmortem_approval_uses (approval_id, incident_id, publisher_id, outcome)
          VALUES (${patch.approvalId}, ${incidentId}, ${patch.publishedBy}, 'published')
          ON CONFLICT (approval_id) DO NOTHING
          RETURNING approval_id
        `;
        if (used.length === 0) return 'spent' as const;
        const rows = await tx`
          UPDATE notify.status_postmortems
             SET status = 'published', approval_id = ${patch.approvalId}, published_by = ${patch.publishedBy}, published_at = ${patch.at}
           WHERE incident_id = ${incidentId} AND version = ${version} AND status = 'draft'
          RETURNING incident_id
        `;
        // Neither the use nor the publish lands when the draft moved on.
        if (rows.length !== 1) throw stale;
        return 'published' as const;
      });
    } catch (err) {
      if (err === stale) return 'stale';
      throw err;
    }
  }

  async published(limit: number): Promise<readonly Postmortem[]> {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(COLUMNS)} FROM notify.status_postmortems
       WHERE status = 'published' ORDER BY published_at DESC, incident_id LIMIT ${limit}
    `;
    return rows.map(fromRow);
  }

  async list(limit: number): Promise<readonly Postmortem[]> {
    const rows = await this.sql<Row[]>`
      SELECT ${this.sql.unsafe(COLUMNS)} FROM notify.status_postmortems ORDER BY written_at DESC, incident_id LIMIT ${limit}
    `;
    return rows.map(fromRow);
  }
}
