import type { Sql, TransactionSql } from 'postgres';
import { QUANT_SHARE_SEQ_STALE, QuantError } from '../errors.js';
import {
  resultShareKey,
  shareOpenKind,
  type ShareCreateInput,
  type ShareLink,
  type ShareOpenInput,
  type ShareOpened,
  type ShareRepository,
} from './repository.js';
import { newShareToken, shareHashEquals, shareTokenHash } from './token.js';

interface ShareSql {
  run_id: string;
  account_id: string;
  seq: number;
  write_key: string;
  token_hash: string;
  created_at: Date | string;
  revoked_at: Date | string | null;
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

function linkOf(row: ShareSql): ShareLink {
  return {
    runId: row.run_id,
    accountId: row.account_id,
    seq: row.seq,
    key: row.write_key,
    tokenHash: row.token_hash,
    createdAt: iso(row.created_at),
    revokedAt: row.revoked_at === null ? null : iso(row.revoked_at),
  };
}

export function createPostgresShareRepository(sql: Sql, schema = 'quant'): ShareRepository {
  const shares = relation(schema, 'result_shares');
  const reads = relation(schema, 'share_reads');

  async function query<T>(db: Sql | TransactionSql, text: string, params: readonly unknown[]): Promise<T[]> {
    return db.unsafe(text, params as never[]);
  }

  async function rowsOf(db: Sql | TransactionSql, accountId: string, runId: string): Promise<ShareLink[]> {
    const rows = await query<ShareSql>(
      db,
      `SELECT run_id, account_id, seq, write_key, token_hash, created_at, revoked_at
         FROM ${shares}
        WHERE account_id = $1 AND run_id = $2
        ORDER BY seq ASC`,
      [accountId, runId],
    );
    return rows.map(linkOf);
  }

  return {
    async list(input) {
      return rowsOf(sql, input.accountId, input.runId);
    },

    async create(input) {
      return sql.begin(async (tx) => {
        await query(tx, `SELECT pg_advisory_xact_lock(hashtext($1))`, [`${schema}.share.run:${input.runId}`]);
        const rows = await rowsOf(tx, input.accountId, input.runId);
        const key = resultShareKey(input.runId, input.seq);
        const existing = rows.find((link) => link.key === key);
        if (existing) return { link: existing, links: rows.length, token: null };
        const active = rows.find((link) => link.revokedAt === null);
        if (active) return { link: active, links: rows.length, token: null };
        if (input.seq !== rows.length) {
          throw new QuantError(QUANT_SHARE_SEQ_STALE, 'seq — the number of links the screen read is not the number stored');
        }
        const token = newShareToken();
        const inserted = await query<ShareSql>(
          tx,
          `INSERT INTO ${shares} (account_id, run_id, seq, write_key, token_hash, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           RETURNING run_id, account_id, seq, write_key, token_hash, created_at, revoked_at`,
          [input.accountId, input.runId, input.seq, key, shareTokenHash(token), input.now],
        );
        const row = inserted[0];
        if (!row) throw new QuantError('quant.params_invalid', 'share link was not stored');
        return { link: linkOf(row), links: rows.length + 1, token };
      });
    },

    async revoke(input) {
      return sql.begin(async (tx) => {
        await query(tx, `SELECT pg_advisory_xact_lock(hashtext($1))`, [`${schema}.share.run:${input.runId}`]);
        await query(tx, `UPDATE ${shares} SET revoked_at = $3 WHERE account_id = $1 AND run_id = $2 AND revoked_at IS NULL`, [
          input.accountId,
          input.runId,
          input.now,
        ]);
        const rows = await rowsOf(tx, input.accountId, input.runId);
        return { links: rows.length };
      });
    },

    async matchActive(input) {
      const presented = shareTokenHash(input.token);
      const rows = await query<ShareSql>(
        sql,
        `SELECT run_id, account_id, seq, write_key, token_hash, created_at, revoked_at
           FROM ${shares}
          WHERE account_id = $1 AND run_id = $2 AND revoked_at IS NULL`,
        [input.accountId, input.runId],
      );
      const active = rows[0] ? linkOf(rows[0]) : null;
      return shareHashEquals(active?.tokenHash ?? null, presented) && active ? active : null;
    },

    async openPublic(input) {
      return sql.begin(async (tx) => openPublic(tx, shares, reads, schema, query, input));
    },
  };
}

async function openPublic(
  tx: TransactionSql,
  shares: string,
  reads: string,
  schema: string,
  query: <T>(db: Sql | TransactionSql, text: string, params: readonly unknown[]) => Promise<T[]>,
  input: ShareOpenInput,
): Promise<ShareOpened> {
  await query(tx, `SELECT pg_advisory_xact_lock(hashtext($1))`, [`${schema}.share.rate`]);
  const presented = shareTokenHash(input.token);
  const found = await query<ShareSql>(
    tx,
    `SELECT run_id, account_id, seq, write_key, token_hash, created_at, revoked_at
       FROM ${shares}
      WHERE token_hash = $1 AND revoked_at IS NULL`,
    [presented],
  );
  const active = found[0] && shareHashEquals(found[0].token_hash, presented) ? linkOf(found[0]) : null;
  if (!active) return shareOpenKind(null, 0, input.rate);
  const from = new Date(input.nowMs - input.windowMs).toISOString();
  await query(tx, `DELETE FROM ${reads} WHERE read_at < $1::timestamptz`, [from]);
  const counted = await query<{ n: number }>(tx, `SELECT count(*)::int AS n FROM ${reads} WHERE bucket = $1`, [active.tokenHash]);
  const used = counted[0]?.n ?? 0;
  const opened = shareOpenKind(active, used, input.rate);
  if (opened.kind !== 'ok') return opened;
  await query(tx, `INSERT INTO ${reads} (bucket, read_at) VALUES ($1, $2)`, [active.tokenHash, new Date(input.nowMs).toISOString()]);
  return opened;
}
