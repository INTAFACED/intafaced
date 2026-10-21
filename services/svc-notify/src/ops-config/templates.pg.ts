/** Postgres template store. Versions are appended in one transaction; the trigger in 0014 refuses an edit or delete. */

import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import { TEMPLATE_KEYS, type TemplateKey, type TemplateRow, type TemplateStore } from './templates.js';

type Pg = {
  template_key: string;
  version: number;
  subject: string;
  body: string;
  author_id: string;
  approval_id: string;
  created_at: Date;
};

function asKey(value: string): TemplateKey {
  if (!(TEMPLATE_KEYS as readonly string[]).includes(value)) throw new Error(`notify.template_corrupt:${value}`);
  return value as TemplateKey;
}

function fromPg(row: Pg): TemplateRow {
  return {
    key: asKey(row.template_key),
    version: row.version,
    subject: row.subject,
    body: row.body,
    authorId: row.author_id,
    approvalId: row.approval_id,
    createdAt: row.created_at,
  };
}

const COLUMNS = 'template_key, version, subject, body, author_id, approval_id, created_at';

export class PostgresTemplateStore implements TemplateStore {
  constructor(private readonly sql: Sql) {}

  async latest(): Promise<readonly TemplateRow[]> {
    const rows = await this.sql<Pg[]>`
      SELECT DISTINCT ON (template_key) ${this.sql.unsafe(COLUMNS)}
      FROM notify.message_templates ORDER BY template_key, version DESC
    `;
    return rows.map(fromPg);
  }

  async version(key: TemplateKey, version: number): Promise<TemplateRow | null> {
    const [row] = await this.sql<Pg[]>`
      SELECT ${this.sql.unsafe(COLUMNS)} FROM notify.message_templates WHERE template_key = ${key} AND version = ${version}
    `;
    return row ? fromPg(row) : null;
  }

  async history(key: TemplateKey): Promise<readonly TemplateRow[]> {
    const rows = await this.sql<Pg[]>`
      SELECT ${this.sql.unsafe(COLUMNS)} FROM notify.message_templates WHERE template_key = ${key} ORDER BY version DESC
    `;
    return rows.map(fromPg);
  }

  async append(input: {
    key: TemplateKey;
    subject: string;
    body: string;
    authorId: string;
    approvalId: string;
    now: Date;
  }): Promise<{ status: 'inserted'; row: TemplateRow } | { status: 'exists' }> {
    return transaction(this.sql, async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`notify.message_templates:${input.key}`}))`;
      const used = await tx`SELECT 1 FROM notify.message_templates WHERE approval_id = ${input.approvalId}`;
      if (used.length > 0) return { status: 'exists' as const };
      const [last] = await tx<{ version: number | null }[]>`
        SELECT max(version) AS version FROM notify.message_templates WHERE template_key = ${input.key}
      `;
      const version = (last?.version ?? 0) + 1;
      const [row] = await tx<Pg[]>`
        INSERT INTO notify.message_templates (template_key, version, subject, body, author_id, approval_id, created_at)
        VALUES (${input.key}, ${version}, ${input.subject}, ${input.body}, ${input.authorId}, ${input.approvalId}, ${input.now})
        RETURNING ${tx.unsafe(COLUMNS)}
      `;
      return { status: 'inserted' as const, row: fromPg(row!) };
    });
  }
}
