import type { Sql, TransactionSql } from 'postgres';
import { quantSignalRulesSchema, type QuantSignalRules } from '@intafaced/contracts';
import { QUANT_STUDIO_NOT_FOUND, QuantError } from '../errors.js';
import { decodeListCursor, idempotencyConflict } from './keys.js';
import type {
  OperatorListPage,
  OwnedBacktest,
  StrategyDetail,
  StrategyDraft,
  StrategyHead,
  StrategyRepository,
  StrategyVersionRecord,
  WriteReceipt,
} from './repository.js';
import type { StrategyMetadata, StudioBlock, StudioRiskBlock } from './store.js';
import type { QuotaHold } from '../quota/postgres-store.js';
import { isQuotaRefusal } from '../quota/quota.js';

const sourceBytes = (source: string) => BigInt(Buffer.byteLength(source, 'utf8'));

const CLAIMS = ['Paper — not live performance', 'Historical simulation — not a forecast', 'Shadow — not live performance'] as const;

interface Joined {
  id: string;
  account_id: string;
  client_strategy_id: string;
  deleted_at: Date | string | null;
  created_at: Date | string;
  head_name: string | null;
  folder: string;
  description: string;
  organised: number;
  restores: number;
  version: number;
  name: string;
  language: string;
  source: string;
  cash: string;
  blocks: unknown;
  modules: unknown;
  risk: unknown;
  environment: string;
  kind: string;
  claim_label: string;
  live: boolean;
  simulated: boolean;
  release_note: string;
  version_created_at: Date | string;
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

function readBlocks(value: unknown): StudioBlock[] {
  if (!Array.isArray(value)) throw new QuantError('quant.params_invalid', 'blocks must be an array of decimal strings');
  return value.map((row, index) => {
    if (!row || typeof row !== 'object') throw new QuantError('quant.params_invalid', `blocks[${index}] must be an object`);
    const rec = row as Record<string, unknown>;
    if ((rec.side !== 'buy' && rec.side !== 'sell') || typeof rec.symbol !== 'string' || typeof rec.qty !== 'string') {
      throw new QuantError('quant.params_invalid', `blocks[${index}].qty must be a decimal string`);
    }
    return { side: rec.side, symbol: rec.symbol, qty: rec.qty };
  });
}

function readModules(value: unknown): QuantSignalRules | null {
  if (value === null || value === undefined) return null;
  const parsed = quantSignalRulesSchema.safeParse(value);
  if (!parsed.success) throw new QuantError('quant.params_invalid', 'modules are not signal rules');
  return parsed.data;
}

function readRisk(value: unknown): StudioRiskBlock {
  if (!value || typeof value !== 'object') throw new QuantError('quant.params_invalid', 'risk must be decimal strings');
  const rec = value as Record<string, unknown>;
  if (typeof rec.maxDrawdown !== 'string' || typeof rec.maxNotional !== 'string' || typeof rec.kill !== 'string') {
    throw new QuantError('quant.params_invalid', 'risk.maxDrawdown, risk.maxNotional and risk.kill must be decimal strings');
  }
  return { maxDrawdown: rec.maxDrawdown, maxNotional: rec.maxNotional, kill: rec.kill };
}

function readClaim(value: string): StrategyDraft['claimLabel'] {
  if (!(CLAIMS as readonly string[]).includes(value)) throw new QuantError('quant.params_invalid', 'claimLabel is not a paper stamp');
  return value as StrategyDraft['claimLabel'];
}

function readEnvironment(value: string): StrategyDraft['environment'] {
  if (value !== 'paper' && value !== 'backtest' && value !== 'shadow') {
    throw new QuantError('quant.params_invalid', 'environment is not paper, backtest, or shadow');
  }
  return value;
}

function readKind(value: string): StrategyDraft['kind'] {
  if (value !== 'paper' && value !== 'simulated') throw new QuantError('quant.params_invalid', 'kind is not paper or simulated');
  return value;
}

function versionOf(row: Joined): StrategyVersionRecord {
  if (row.language !== 'javascript') throw new QuantError('quant.params_invalid', 'language must be javascript');
  if (row.live !== false || row.simulated !== true) throw new QuantError('quant.params_invalid', 'live must stay false');
  return {
    version: row.version,
    name: row.name,
    language: 'javascript',
    source: row.source,
    cash: row.cash,
    blocks: readBlocks(row.blocks),
    modules: readModules(row.modules),
    risk: readRisk(row.risk),
    environment: readEnvironment(row.environment),
    kind: readKind(row.kind),
    claimLabel: readClaim(row.claim_label),
    live: false,
    simulated: true,
    releaseNote: row.release_note,
    createdAt: iso(row.version_created_at),
  };
}

function detailOf(rows: readonly Joined[]): StrategyDetail | null {
  const first = rows[0];
  if (!first) return null;
  const versions = rows.map(versionOf);
  const head = versions[versions.length - 1];
  if (!head) return null;
  return {
    ...head,
    name: first.head_name ?? head.name,
    id: first.id,
    accountId: first.account_id,
    clientStrategyId: first.client_strategy_id,
    deletedAt: first.deleted_at ? iso(first.deleted_at) : null,
    createdAt: iso(first.created_at),
    folder: first.folder,
    description: first.description,
    organised: first.organised,
    restores: first.restores,
    versions,
  };
}

function headOf(detail: StrategyDetail): StrategyHead {
  const { versions: _versions, ...head } = detail;
  return head;
}

function metadataOf(detail: StrategyDetail): StrategyMetadata {
  return {
    id: detail.id,
    accountId: detail.accountId,
    name: detail.name,
    language: detail.language,
    environment: detail.environment,
    kind: detail.kind,
    claimLabel: detail.claimLabel,
    live: false,
    simulated: true,
  };
}

function asReceipt(operation: string, response: unknown): WriteReceipt {
  if (operation === 'delete') return { operation: 'delete', response: { ok: true } };
  if (operation === 'backtest') return { operation: 'backtest', response: response as OwnedBacktest };
  if (operation === 'create' || operation === 'revise' || operation === 'organise' || operation === 'restore') {
    return { operation, response: response as StrategyDetail };
  }
  idempotencyConflict(operation);
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && (err as { code?: string }).code === '23505';
}

const JOINED = `
  s.id, s.account_id, s.client_strategy_id, s.deleted_at, s.created_at,
  s.name AS head_name, s.folder, s.description, s.organised, s.restores,
  v.version, v.name, v.language, v.source, v.cash, v.blocks, v.modules, v.risk,
  v.environment, v.kind, v.claim_label, v.live, v.simulated, v.release_note, v.created_at AS version_created_at
`;

/**
 * Postgres adapter. Schema defaults to quant. Tests pass a private schema name.
 * Version rows are insert-only; the table trigger rejects UPDATE and DELETE.
 */
/**
 * `quota` is the plan check (AL-limits-01) a new strategy and a new version run inside their own transaction before
 * they insert. The service always passes it; a store built without one (a test of something else) does not count.
 */
export function createPostgresStrategyRepository(sql: Sql, schema = 'quant', quota?: QuotaHold): StrategyRepository {
  const strategies = relation(schema, 'strategies');
  const versions = relation(schema, 'strategy_versions');
  const receipts = relation(schema, 'write_receipts');
  const runs = relation(schema, 'backtest_runs');

  async function query<T>(db: Sql | TransactionSql, text: string, params: readonly unknown[]): Promise<T[]> {
    return db.unsafe(text, params as never[]);
  }

  async function load(db: Sql | TransactionSql, accountId: string, id: string): Promise<StrategyDetail | null> {
    const rows = await query<Joined>(
      db,
      `SELECT ${JOINED} FROM ${strategies} s
       JOIN ${versions} v ON v.strategy_id = s.id
       WHERE s.id = $1 AND s.account_id = $2
       ORDER BY v.version ASC`,
      [id, accountId],
    );
    return detailOf(rows);
  }

  async function readReceipt(db: Sql | TransactionSql, accountId: string, idempotencyKey: string): Promise<WriteReceipt | null> {
    const rows = await query<{ operation: string; response: unknown }>(
      db,
      `SELECT operation, response FROM ${receipts} WHERE account_id = $1 AND idempotency_key = $2`,
      [accountId, idempotencyKey],
    );
    const row = rows[0];
    return row ? asReceipt(row.operation, row.response) : null;
  }

  async function writeReceipt(
    db: Sql | TransactionSql,
    accountId: string,
    idempotencyKey: string,
    operation: WriteReceipt['operation'],
    response: unknown,
  ): Promise<WriteReceipt> {
    await query(
      db,
      `INSERT INTO ${receipts} (account_id, idempotency_key, operation, response, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5)
       ON CONFLICT (account_id, idempotency_key) DO NOTHING`,
      [accountId, idempotencyKey, operation, response, new Date().toISOString()],
    );
    const stored = await readReceipt(db, accountId, idempotencyKey);
    if (!stored) throw new QuantError('quant.params_invalid', 'idempotencyKey receipt was not stored');
    if (stored.operation !== operation) idempotencyConflict(stored.operation);
    return stored;
  }

  async function insertVersion(
    db: Sql | TransactionSql,
    strategyId: string,
    version: number,
    draft: StrategyDraft,
    createdAt: string,
  ): Promise<void> {
    await query(
      db,
      `INSERT INTO ${versions} (
         strategy_id, version, name, language, source, cash, blocks, risk,
         environment, kind, claim_label, live, simulated, created_at, modules, release_note
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, false, true, $12, $13::jsonb, $14
       )`,
      [
        strategyId,
        version,
        draft.name,
        draft.language,
        draft.source,
        draft.cash,
        draft.blocks,
        draft.risk,
        draft.environment,
        draft.kind,
        draft.claimLabel,
        createdAt,
        draft.modules,
        draft.releaseNote,
      ],
    );
  }

  /** One page of the caller's heads: live ones for the list, deleted ones for the recycle bin. */
  async function page(input: { accountId: string; limit: number; cursor?: string | null }, deleted: 'IS NULL' | 'IS NOT NULL') {
    const cursor = input.cursor ? decodeListCursor(input.cursor) : null;
    const rows = await query<Joined>(
      sql,
      `SELECT ${JOINED} FROM ${strategies} s
       JOIN ${versions} v ON v.strategy_id = s.id
       WHERE s.account_id = $1
         AND s.deleted_at ${deleted}
         AND v.version = (SELECT MAX(v2.version) FROM ${versions} v2 WHERE v2.strategy_id = s.id)
         AND ($2::timestamptz IS NULL OR (s.created_at, s.id) > ($2::timestamptz, $3::text))
       ORDER BY s.created_at ASC, s.id ASC
       LIMIT $4`,
      [input.accountId, cursor?.createdAt ?? null, cursor?.id ?? null, input.limit + 1],
    );
    const page = rows.slice(0, input.limit);
    const heads = page.map((row) => {
      const detail = detailOf([row]);
      if (!detail) throw new QuantError(QUANT_STUDIO_NOT_FOUND, 'strategy not found');
      return headOf(detail);
    });
    const last = page[page.length - 1];
    const nextCursor =
      rows.length > input.limit && last ? Buffer.from(`${iso(last.created_at)}|${last.id}`, 'utf8').toString('base64url') : null;
    return { strategies: heads, nextCursor };
  }

  function requireDetail(detail: StrategyDetail | null): StrategyDetail {
    if (!detail || detail.deletedAt) throw new QuantError(QUANT_STUDIO_NOT_FOUND, 'strategy not found');
    return detail;
  }

  return {
    replay(accountId, idempotencyKey) {
      return readReceipt(sql, accountId, idempotencyKey);
    },

    async create(input) {
      return sql.begin(async (tx) => {
        const existing = await readReceipt(tx, input.accountId, input.idempotencyKey);
        if (existing) {
          if (existing.operation !== 'create') idempotencyConflict(existing.operation);
          return existing.response;
        }
        const found = await query<{ id: string }>(
          tx,
          `SELECT id FROM ${strategies} WHERE account_id = $1 AND client_strategy_id = $2 FOR UPDATE`,
          [input.accountId, input.clientStrategyId],
        );
        if (found[0]) {
          const detail = await load(tx, input.accountId, found[0].id);
          if (!detail) throw new QuantError(QUANT_STUDIO_NOT_FOUND, 'strategy not found');
          const stored = await writeReceipt(tx, input.accountId, input.idempotencyKey, 'create', detail);
          return stored.response as StrategyDetail;
        }
        try {
          await quota?.(tx, input.accountId, { strategies: 1n, storage_bytes: sourceBytes(input.draft.source) }, null);
        } catch (err) {
          // The same save may have committed while this one waited on the plan's lock and now counts against it: that
          // is a replay, not a refusal.
          if (!isQuotaRefusal(err)) throw err;
          const replayed = await readReceipt(tx, input.accountId, input.idempotencyKey);
          if (replayed?.operation === 'create') return replayed.response;
          throw err;
        }
        const now = new Date().toISOString();
        const id = `studio_${crypto.randomUUID()}`;
        await query(tx, 'SAVEPOINT quant_client_insert', []);
        try {
          await query(tx, `INSERT INTO ${strategies} (id, account_id, client_strategy_id, created_at) VALUES ($1, $2, $3, $4)`, [
            id,
            input.accountId,
            input.clientStrategyId,
            now,
          ]);
          await query(tx, 'RELEASE SAVEPOINT quant_client_insert', []);
        } catch (err) {
          if (!isUniqueViolation(err)) throw err;
          await query(tx, 'ROLLBACK TO SAVEPOINT quant_client_insert', []);
          const raced = await query<{ id: string }>(tx, `SELECT id FROM ${strategies} WHERE account_id = $1 AND client_strategy_id = $2`, [
            input.accountId,
            input.clientStrategyId,
          ]);
          const racedId = raced[0]?.id;
          if (!racedId) throw err;
          const detail = await load(tx, input.accountId, racedId);
          if (!detail) throw err;
          const stored = await writeReceipt(tx, input.accountId, input.idempotencyKey, 'create', detail);
          return stored.response as StrategyDetail;
        }
        await insertVersion(tx, id, 1, input.draft, now);
        const detail = await load(tx, input.accountId, id);
        if (!detail) throw new QuantError(QUANT_STUDIO_NOT_FOUND, 'strategy not found');
        const stored = await writeReceipt(tx, input.accountId, input.idempotencyKey, 'create', detail);
        return stored.response as StrategyDetail;
      });
    },

    async revise(input) {
      return sql.begin(async (tx) => {
        const existing = await readReceipt(tx, input.accountId, input.idempotencyKey);
        if (existing) {
          if (existing.operation !== 'revise') idempotencyConflict(existing.operation);
          return existing.response;
        }
        const locked = await query<{ id: string; deleted_at: Date | string | null }>(
          tx,
          `SELECT id, deleted_at FROM ${strategies} WHERE id = $1 AND account_id = $2 FOR UPDATE`,
          [input.id, input.accountId],
        );
        const row = locked[0];
        if (!row || row.deleted_at) throw new QuantError(QUANT_STUDIO_NOT_FOUND, 'strategy not found');
        const maxRows = await query<{ version: number }>(
          tx,
          `SELECT COALESCE(MAX(version), 0) AS version FROM ${versions} WHERE strategy_id = $1`,
          [input.id],
        );
        await quota?.(tx, input.accountId, { versions_per_strategy: 1n, storage_bytes: sourceBytes(input.draft.source) }, input.id);
        const next = (maxRows[0]?.version ?? 0) + 1;
        await insertVersion(tx, input.id, next, input.draft, new Date().toISOString());
        // A saved version names the strategy again; the head follows it until the next rename.
        await query(tx, `UPDATE ${strategies} SET name = NULL WHERE id = $1 AND account_id = $2`, [input.id, input.accountId]);
        const detail = requireDetail(await load(tx, input.accountId, input.id));
        const stored = await writeReceipt(tx, input.accountId, input.idempotencyKey, 'revise', detail);
        return stored.response as StrategyDetail;
      });
    },

    async softDelete(input) {
      return sql.begin(async (tx) => {
        const existing = await readReceipt(tx, input.accountId, input.idempotencyKey);
        if (existing) {
          if (existing.operation !== 'delete') idempotencyConflict(existing.operation);
          return { ok: true as const };
        }
        const updated = await query<{ id: string }>(
          tx,
          `UPDATE ${strategies} SET deleted_at = $3 WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL RETURNING id`,
          [input.id, input.accountId, new Date().toISOString()],
        );
        if (!updated[0]) throw new QuantError(QUANT_STUDIO_NOT_FOUND, 'strategy not found');
        await writeReceipt(tx, input.accountId, input.idempotencyKey, 'delete', { ok: true });
        return { ok: true as const };
      });
    },

    async organise(input) {
      return sql.begin(async (tx) => {
        const existing = await readReceipt(tx, input.accountId, input.idempotencyKey);
        if (existing) {
          if (existing.operation !== 'organise') idempotencyConflict(existing.operation);
          return existing.response;
        }
        // Lock the row, then read the receipt again: a racing call with the same key waits here and replays.
        const locked = await query<{ id: string }>(tx, `SELECT id FROM ${strategies} WHERE id = $1 AND account_id = $2 FOR UPDATE`, [
          input.id,
          input.accountId,
        ]);
        if (!locked[0]) throw new QuantError(QUANT_STUDIO_NOT_FOUND, 'strategy not found');
        const raced = await readReceipt(tx, input.accountId, input.idempotencyKey);
        if (raced) {
          if (raced.operation !== 'organise') idempotencyConflict(raced.operation);
          return raced.response;
        }
        const updated = await query<{ id: string }>(
          tx,
          `UPDATE ${strategies} SET name = $3, folder = $4, description = $5, organised = organised + 1
           WHERE id = $1 AND account_id = $2 AND deleted_at IS NULL RETURNING id`,
          [input.id, input.accountId, input.head.name, input.head.folder, input.head.description],
        );
        if (!updated[0]) throw new QuantError(QUANT_STUDIO_NOT_FOUND, 'strategy not found');
        const detail = requireDetail(await load(tx, input.accountId, input.id));
        const stored = await writeReceipt(tx, input.accountId, input.idempotencyKey, 'organise', detail);
        return stored.response as StrategyDetail;
      });
    },

    async restore(input) {
      return sql.begin(async (tx) => {
        const existing = await readReceipt(tx, input.accountId, input.idempotencyKey);
        if (existing) {
          if (existing.operation !== 'restore') idempotencyConflict(existing.operation);
          return existing.response;
        }
        const locked = await query<{ id: string; deleted_at: Date | string | null }>(
          tx,
          `SELECT id, deleted_at FROM ${strategies} WHERE id = $1 AND account_id = $2 FOR UPDATE`,
          [input.id, input.accountId],
        );
        if (!locked[0]) throw new QuantError(QUANT_STUDIO_NOT_FOUND, 'strategy not found');
        const raced = await readReceipt(tx, input.accountId, input.idempotencyKey);
        if (raced) {
          if (raced.operation !== 'restore') idempotencyConflict(raced.operation);
          return raced.response;
        }
        // Back from the recycle bin it is a saved strategy again, so it takes a slot of the plan; its versions and
        // their bytes were never released.
        if (locked[0].deleted_at) await quota?.(tx, input.accountId, { strategies: 1n }, null);
        await query(
          tx,
          `UPDATE ${strategies} SET deleted_at = NULL, restores = restores + 1
           WHERE id = $1 AND account_id = $2 AND deleted_at IS NOT NULL`,
          [input.id, input.accountId],
        );
        const detail = requireDetail(await load(tx, input.accountId, input.id));
        const stored = await writeReceipt(tx, input.accountId, input.idempotencyKey, 'restore', detail);
        return stored.response as StrategyDetail;
      });
    },

    listDeleted(input) {
      return page(input, 'IS NOT NULL');
    },

    list(input) {
      return page(input, 'IS NULL');
    },

    async get(input) {
      const detail = await load(sql, input.accountId, input.id);
      if (!detail || detail.deletedAt) return null;
      return detail;
    },

    async versions(input) {
      const detail = await load(sql, input.accountId, input.id);
      return detail ? detail.versions : null;
    },

    async operatorList(input): Promise<OperatorListPage> {
      const cursor = input.cursor ? decodeListCursor(input.cursor) : null;
      const rows = await query<Joined>(
        sql,
        `SELECT ${JOINED} FROM ${strategies} s
         JOIN ${versions} v ON v.strategy_id = s.id
         WHERE s.deleted_at IS NULL
           AND v.version = (SELECT MAX(v2.version) FROM ${versions} v2 WHERE v2.strategy_id = s.id)
           AND ($1::timestamptz IS NULL OR (s.created_at, s.id) > ($1::timestamptz, $2::text))
         ORDER BY s.created_at ASC, s.id ASC
         LIMIT $3`,
        [cursor?.createdAt ?? null, cursor?.id ?? null, input.limit + 1],
      );
      const page = rows.slice(0, input.limit);
      const last = page[page.length - 1];
      return {
        strategies: page.map((row) => {
          const detail = detailOf([row]);
          if (!detail) throw new QuantError(QUANT_STUDIO_NOT_FOUND, 'strategy not found');
          return metadataOf(detail);
        }),
        nextCursor:
          rows.length > input.limit && last ? Buffer.from(`${iso(last.created_at)}|${last.id}`, 'utf8').toString('base64url') : null,
        quarantineCount: 0,
      };
    },

    async saveBacktest(input) {
      return sql.begin(async (tx) => {
        const existing = await readReceipt(tx, input.accountId, input.idempotencyKey);
        if (existing) {
          if (existing.operation !== 'backtest') idempotencyConflict(existing.operation);
          return existing.response;
        }
        const locked = await query<{ deleted_at: Date | string | null }>(
          tx,
          `SELECT deleted_at FROM ${strategies} WHERE id = $1 AND account_id = $2 FOR UPDATE`,
          [input.strategyId, input.accountId],
        );
        const row = locked[0];
        if (!row || row.deleted_at) throw new QuantError(QUANT_STUDIO_NOT_FOUND, 'strategy not found');
        const version = await query<{ version: number }>(tx, `SELECT version FROM ${versions} WHERE strategy_id = $1 AND version = $2`, [
          input.strategyId,
          input.strategyVersion,
        ]);
        if (!version[0]) throw new QuantError(QUANT_STUDIO_NOT_FOUND, 'strategy not found');
        await query(
          tx,
          `INSERT INTO ${runs} (account_id, idempotency_key, strategy_id, strategy_version, symbol, result, created_at)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
          [
            input.accountId,
            input.idempotencyKey,
            input.strategyId,
            input.strategyVersion,
            input.symbol,
            input.result,
            new Date().toISOString(),
          ],
        );
        const stored = await writeReceipt(tx, input.accountId, input.idempotencyKey, 'backtest', input.result);
        return stored.response as OwnedBacktest;
      });
    },
  };
}
