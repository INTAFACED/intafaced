import { quantSignalRulesSchema } from '@intafaced/contracts';
import type { Sql, TransactionSql } from 'postgres';
import { QUANT_IDEMPOTENCY_CONFLICT, QuantError } from '../errors.js';
import { sameContent, type TemplatePublishInput, type TemplateRepository, type TemplateVersion } from './repository.js';

interface TemplateSql {
  template_id: string;
  version: number;
  name: string;
  description: string;
  rules: unknown;
  release_note: string;
  published_at: Date | string;
}

function relation(schema: string, table: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(schema) || !/^[a-z_]+$/.test(table)) {
    throw new Error(`refusing sql identifier ${schema}.${table}`);
  }
  return `"${schema}"."${table}"`;
}

function versionOf(row: TemplateSql): TemplateVersion {
  const rules = quantSignalRulesSchema.safeParse(row.rules);
  if (!rules.success) throw new QuantError('quant.params_invalid', 'template rules are not signal rules');
  const at = row.published_at instanceof Date ? row.published_at : new Date(row.published_at);
  if (Number.isNaN(at.getTime())) throw new QuantError('quant.params_invalid', 'timestamp is not readable');
  return {
    id: row.template_id,
    version: row.version,
    name: row.name,
    description: row.description,
    rules: rules.data,
    releaseNote: row.release_note,
    publishedAt: at.toISOString(),
  };
}

const COLUMNS = 'template_id, version, name, description, rules, release_note, published_at';

export function createPostgresTemplateRepository(sql: Sql, schema = 'quant', now: () => Date = () => new Date()): TemplateRepository {
  const templates = relation(schema, 'templates');

  async function query<T>(db: Sql | TransactionSql, text: string, params: readonly unknown[]): Promise<T[]> {
    return db.unsafe(text, params as never[]);
  }

  return {
    async publish(input: TemplatePublishInput) {
      return sql.begin(async (tx) => {
        // One publisher per template at a time, so two operators never take the same next version.
        await query(tx, `SELECT pg_advisory_xact_lock(hashtext($1))`, [`${schema}.template.publish:${input.id}`]);
        const prior = await query<TemplateSql>(tx, `SELECT ${COLUMNS} FROM ${templates} WHERE idempotency_key = $1`, [
          input.idempotencyKey,
        ]);
        if (prior[0]) {
          const stored = versionOf(prior[0]);
          if (!sameContent(stored, input))
            throw new QuantError(QUANT_IDEMPOTENCY_CONFLICT, 'idempotencyKey was used for a different template');
          return stored;
        }
        const inserted = await query<TemplateSql>(
          tx,
          `INSERT INTO ${templates} (template_id, version, name, description, rules, release_note, reason, published_by, idempotency_key, published_at)
           VALUES ($1, (SELECT COALESCE(MAX(version), 0) + 1 FROM ${templates} WHERE template_id = $1), $2, $3, $4::jsonb, $5, $6, $7, $8, $9)
           RETURNING ${COLUMNS}`,
          [
            input.id,
            input.name,
            input.description,
            input.rules,
            input.releaseNote,
            input.reason,
            input.publishedBy,
            input.idempotencyKey,
            now().toISOString(),
          ],
        );
        if (!inserted[0]) throw new QuantError('quant.params_invalid', 'template version was not stored');
        return versionOf(inserted[0]);
      });
    },

    async list({ limit, cursor }) {
      const rows = await query<TemplateSql>(
        sql,
        `SELECT DISTINCT ON (template_id) ${COLUMNS} FROM ${templates}
          WHERE ($1::text IS NULL OR template_id > $1)
          ORDER BY template_id, version DESC
          LIMIT $2`,
        [cursor ?? null, limit + 1],
      );
      const page = rows.slice(0, limit).map(versionOf);
      return { templates: page, nextCursor: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null };
    },

    async get(id) {
      const rows = await query<TemplateSql>(sql, `SELECT ${COLUMNS} FROM ${templates} WHERE template_id = $1 ORDER BY version DESC`, [id]);
      return rows.length ? rows.map(versionOf) : null;
    },
  };
}
