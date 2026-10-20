import type { Sql, TransactionSql } from 'postgres';
import { QUANT_IDEMPOTENCY_CONFLICT, QuantError } from '../errors.js';
import type {
  DisclosureAcceptance,
  DisclosureAcceptInput,
  DisclosureCounts,
  DisclosurePublishInput,
  DisclosureRepository,
  DisclosureVersion,
} from './repository.js';

interface VersionSql {
  version: number;
  body: string;
  published_at: Date | string;
}

interface AcceptanceSql {
  account_id: string;
  strategy_id: string;
  strategy_version: number;
  disclosure_version: number;
  accepted_at: Date | string;
  write_key: string;
}

function relation(schema: string, table: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(schema) || !/^[a-z_]+$/.test(table)) {
    throw new Error(`refusing sql identifier ${schema}.${table}`);
  }
  return `"${schema}"."${table}"`;
}

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new QuantError('quant.params_invalid', 'timestamp is not readable');
  return date.toISOString();
}

function versionOf(row: VersionSql): DisclosureVersion {
  return { version: row.version, text: row.body, publishedAt: iso(row.published_at) };
}

function acceptanceOf(row: AcceptanceSql): DisclosureAcceptance {
  return {
    accountId: row.account_id,
    strategyId: row.strategy_id,
    strategyVersion: row.strategy_version,
    disclosureVersion: row.disclosure_version,
    acceptedAt: iso(row.accepted_at),
    key: row.write_key,
  };
}

export function createPostgresDisclosureRepository(sql: Sql, schema = 'quant', now: () => Date = () => new Date()): DisclosureRepository {
  const versions = relation(schema, 'disclosure_versions');
  const acceptances = relation(schema, 'disclosure_acceptances');

  async function query<T>(db: Sql | TransactionSql, text: string, params: readonly unknown[]): Promise<T[]> {
    return db.unsafe(text, params as never[]);
  }

  async function findAcceptance(db: Sql | TransactionSql, input: Omit<DisclosureAcceptInput, 'key'>): Promise<DisclosureAcceptance | null> {
    const rows = await query<AcceptanceSql>(
      db,
      `SELECT * FROM ${acceptances}
        WHERE account_id = $1 AND strategy_id = $2 AND strategy_version = $3 AND disclosure_version = $4`,
      [input.accountId, input.strategyId, input.strategyVersion, input.disclosureVersion],
    );
    return rows[0] ? acceptanceOf(rows[0]) : null;
  }

  return {
    async current() {
      const rows = await query<VersionSql>(sql, `SELECT version, body, published_at FROM ${versions} ORDER BY version DESC LIMIT 1`, []);
      return rows[0] ? versionOf(rows[0]) : null;
    },

    async publish(input: DisclosurePublishInput) {
      return sql.begin(async (tx) => {
        // One publisher at a time, so two operators never take the same next version.
        await query(tx, `SELECT pg_advisory_xact_lock(hashtext($1))`, [`${schema}.disclosure.publish`]);
        const prior = await query<VersionSql>(tx, `SELECT version, body, published_at FROM ${versions} WHERE idempotency_key = $1`, [
          input.idempotencyKey,
        ]);
        if (prior[0]) {
          if (prior[0].body !== input.text)
            throw new QuantError(QUANT_IDEMPOTENCY_CONFLICT, 'idempotencyKey was used for different wording');
          return versionOf(prior[0]);
        }
        const inserted = await query<VersionSql>(
          tx,
          `INSERT INTO ${versions} (version, body, reason, published_by, idempotency_key, published_at)
           VALUES ((SELECT COALESCE(MAX(version), 0) + 1 FROM ${versions}), $1, $2, $3, $4, $5)
           RETURNING version, body, published_at`,
          [input.text, input.reason, input.publishedBy, input.idempotencyKey, now().toISOString()],
        );
        const row = inserted[0];
        if (!row) throw new QuantError('quant.params_invalid', 'disclosure version was not stored');
        return versionOf(row);
      });
    },

    async accept(input: DisclosureAcceptInput) {
      return sql.begin(async (tx) => {
        const inserted = await query<AcceptanceSql>(
          tx,
          `INSERT INTO ${acceptances} (account_id, strategy_id, strategy_version, disclosure_version, accepted_at, write_key)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT DO NOTHING
           RETURNING *`,
          [input.accountId, input.strategyId, input.strategyVersion, input.disclosureVersion, now().toISOString(), input.key],
        );
        if (inserted[0]) return acceptanceOf(inserted[0]);
        const stored = await findAcceptance(tx, input);
        if (!stored) throw new QuantError('quant.params_invalid', 'acceptance was not stored');
        return stored;
      });
    },

    async acceptance(input) {
      return findAcceptance(sql, input);
    },

    async counts(): Promise<DisclosureCounts> {
      const rows = await query<VersionSql & { acceptances: string | number }>(
        sql,
        `SELECT v.version, v.body, v.published_at, COUNT(a.account_id) AS acceptances
           FROM ${versions} v
           LEFT JOIN ${acceptances} a ON a.disclosure_version = v.version
          GROUP BY v.version, v.body, v.published_at
          ORDER BY v.version`,
        [],
      );
      return {
        versions: rows.map((row) => ({ version: row.version, publishedAt: iso(row.published_at), acceptances: Number(row.acceptances) })),
      };
    },
  };
}
