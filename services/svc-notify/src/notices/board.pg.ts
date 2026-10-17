/**
 * Postgres notice store. Publishing updates a draft once. The trigger in
 * 0011_notify_public_notices.sql refuses a later edit of a published row.
 */

import type { Sql } from 'postgres';
import { NOTICE_KINDS, NoticeError, type NoticeKind, type NoticeRow, type NoticeStore } from './board.js';

type NoticePg = {
  id: string;
  kind: string;
  title: string;
  body: string;
  status: string;
  published_at: Date | null;
  starts_at: Date | null;
  ends_at: Date | null;
  version: number;
  author_id: string;
  client_request_id: string;
  publish_client_request_id: string | null;
  approval_id: string | null;
  created_at: Date;
};

function asKind(value: string): NoticeKind {
  if (!(NOTICE_KINDS as readonly string[]).includes(value)) throw new NoticeError('notify.notice_kind_unknown');
  return value as NoticeKind;
}

function fromPg(row: NoticePg): NoticeRow {
  return {
    id: row.id,
    kind: asKind(row.kind),
    title: row.title,
    body: row.body,
    status: row.status === 'published' ? 'published' : 'draft',
    publishedAt: row.published_at,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    version: row.version,
    authorId: row.author_id,
    clientRequestId: row.client_request_id,
    publishClientRequestId: row.publish_client_request_id,
    approvalId: row.approval_id,
    createdAt: row.created_at,
  };
}

const COLUMNS = `
  id, kind, title, body, status, published_at, starts_at, ends_at, version,
  author_id, client_request_id, publish_client_request_id, approval_id, created_at
`;

export class PostgresNoticeStore implements NoticeStore {
  constructor(private readonly sql: Sql) {}

  async insert(row: NoticeRow): Promise<void> {
    await this.sql`
      INSERT INTO notify.notices (
        id, kind, title, body, status, published_at, starts_at, ends_at, version,
        author_id, client_request_id
      ) VALUES (
        ${row.id}, ${row.kind}, ${row.title}, ${row.body}, ${row.status},
        ${row.publishedAt}, ${row.startsAt}, ${row.endsAt}, ${row.version},
        ${row.authorId}, ${row.clientRequestId}
      )
    `;
  }

  async findByDraftRequest(authorId: string, clientRequestId: string): Promise<NoticeRow | null> {
    const rows = await this.sql<NoticePg[]>`
      SELECT ${this.sql.unsafe(COLUMNS)} FROM notify.notices
       WHERE author_id = ${authorId} AND client_request_id = ${clientRequestId}
       LIMIT 1
    `;
    return rows[0] ? fromPg(rows[0]) : null;
  }

  async findById(id: string): Promise<NoticeRow | null> {
    const rows = await this.sql<NoticePg[]>`
      SELECT ${this.sql.unsafe(COLUMNS)} FROM notify.notices WHERE id = ${id} LIMIT 1
    `;
    return rows[0] ? fromPg(rows[0]) : null;
  }

  async listPublished(kind: NoticeKind | null, limit: number): Promise<readonly NoticeRow[]> {
    const rows =
      kind == null
        ? await this.sql<NoticePg[]>`
            SELECT ${this.sql.unsafe(COLUMNS)} FROM notify.notices
             WHERE status = 'published'
             ORDER BY published_at DESC, id ASC
             LIMIT ${limit}
          `
        : await this.sql<NoticePg[]>`
            SELECT ${this.sql.unsafe(COLUMNS)} FROM notify.notices
             WHERE status = 'published' AND kind = ${kind}
             ORDER BY published_at DESC, id ASC
             LIMIT ${limit}
          `;
    return rows.map(fromPg);
  }

  async markPublished(id: string, patch: { publishedAt: Date; approvalId: string; publishClientRequestId: string }): Promise<void> {
    const rows = await this.sql<{ id: string }[]>`
      UPDATE notify.notices
         SET status = 'published',
             published_at = ${patch.publishedAt},
             approval_id = ${patch.approvalId},
             publish_client_request_id = ${patch.publishClientRequestId}
       WHERE id = ${id} AND status = 'draft'
       RETURNING id
    `;
    if (rows.length === 0) throw new NoticeError('notify.notice_published_immutable');
  }

  async approvalOutcome(approvalId: string): Promise<'published' | 'refused_same_operator' | null> {
    const rows = await this.sql<{ outcome: 'published' | 'refused_same_operator' }[]>`
      SELECT outcome FROM notify.notice_approval_uses WHERE approval_id = ${approvalId}
    `;
    return rows[0]?.outcome ?? null;
  }

  async recordApproval(
    approvalId: string,
    noticeId: string,
    publisherId: string,
    outcome: 'published' | 'refused_same_operator',
  ): Promise<'inserted' | 'exists'> {
    const rows = await this.sql<{ approval_id: string }[]>`
      INSERT INTO notify.notice_approval_uses (approval_id, notice_id, publisher_id, outcome)
      VALUES (${approvalId}, ${noticeId}, ${publisherId}, ${outcome})
      ON CONFLICT (approval_id) DO NOTHING
      RETURNING approval_id
    `;
    return rows.length > 0 ? 'inserted' : 'exists';
  }
}
