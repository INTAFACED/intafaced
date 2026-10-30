import { QUANT_STUDIO_NOT_FOUND, QuantError } from '../errors.js';
import { decodeListCursor, encodeListCursor, idempotencyConflict } from './keys.js';
import type {
  OperatorListPage,
  OwnedBacktest,
  StrategyDetail,
  StrategyHead,
  StrategyRepository,
  StrategyVersionRecord,
  WriteReceipt,
} from './repository.js';
import type { StrategyMetadata } from './store.js';

interface MemoryRow {
  id: string;
  accountId: string;
  clientStrategyId: string;
  deletedAt: string | null;
  createdAt: string;
  name: string | null;
  folder: string;
  description: string;
  organised: number;
  restores: number;
  versions: StrategyVersionRecord[];
}

interface MemoryReceipt {
  operation: WriteReceipt['operation'];
  response: WriteReceipt['response'];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function detailOf(row: MemoryRow): StrategyDetail {
  const head = row.versions[row.versions.length - 1];
  if (!head) throw new QuantError(QUANT_STUDIO_NOT_FOUND, 'strategy not found');
  return clone({
    ...head,
    name: row.name ?? head.name,
    id: row.id,
    accountId: row.accountId,
    clientStrategyId: row.clientStrategyId,
    deletedAt: row.deletedAt,
    createdAt: row.createdAt,
    folder: row.folder,
    description: row.description,
    organised: row.organised,
    restores: row.restores,
    versions: row.versions,
  });
}

function headOf(row: MemoryRow): StrategyHead {
  const detail = detailOf(row);
  const { versions: _versions, ...head } = detail;
  return head;
}

function metadataOf(row: MemoryRow): StrategyMetadata {
  const head = headOf(row);
  return {
    id: head.id,
    accountId: head.accountId,
    name: head.name,
    language: head.language,
    environment: head.environment,
    kind: head.kind,
    claimLabel: head.claimLabel,
    live: false,
    simulated: true,
  };
}

function receiptOf(stored: MemoryReceipt): WriteReceipt {
  if (stored.operation === 'delete') return { operation: 'delete', response: { ok: true as const } };
  if (stored.operation === 'backtest') {
    return { operation: 'backtest', response: clone(stored.response as OwnedBacktest) };
  }
  return { operation: stored.operation, response: clone(stored.response as StrategyDetail) };
}

/**
 * In-memory port for tests. Production does not construct this.
 * Version objects are appended, never rewritten.
 */
export function createMemoryStrategyRepository(): StrategyRepository {
  const rows = new Map<string, MemoryRow>();
  const receipts = new Map<string, MemoryReceipt>();

  function receiptKey(accountId: string, idempotencyKey: string): string {
    return `${accountId}\0${idempotencyKey}`;
  }

  function owned(accountId: string, id: string): MemoryRow | undefined {
    const row = rows.get(id);
    if (!row || row.accountId !== accountId) return undefined;
    return row;
  }

  function remember(
    accountId: string,
    idempotencyKey: string,
    operation: MemoryReceipt['operation'],
    response: MemoryReceipt['response'],
  ): void {
    receipts.set(receiptKey(accountId, idempotencyKey), { operation, response: clone(response) });
  }

  function prior(accountId: string, idempotencyKey: string): WriteReceipt | null {
    const stored = receipts.get(receiptKey(accountId, idempotencyKey));
    return stored ? receiptOf(stored) : null;
  }

  function page(
    list: readonly MemoryRow[],
    limit: number,
    cursor: string | null | undefined,
  ): { rows: MemoryRow[]; nextCursor: string | null } {
    const sorted = [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    let start = 0;
    if (cursor) {
      const decoded = decodeListCursor(cursor);
      const after = sorted.findIndex(
        (row) => row.createdAt > decoded.createdAt || (row.createdAt === decoded.createdAt && row.id > decoded.id),
      );
      start = after < 0 ? sorted.length : after;
    }
    const slice = sorted.slice(start, start + limit);
    const last = slice[slice.length - 1];
    const nextCursor = last && start + limit < sorted.length ? encodeListCursor(last.createdAt, last.id) : null;
    return { rows: slice, nextCursor };
  }

  return {
    async replay(accountId, idempotencyKey) {
      return prior(accountId, idempotencyKey);
    },

    async create(input) {
      const existing = prior(input.accountId, input.idempotencyKey);
      if (existing) {
        if (existing.operation !== 'create') idempotencyConflict(existing.operation);
        return existing.response;
      }
      const sameClient = [...rows.values()].find(
        (row) => row.accountId === input.accountId && row.clientStrategyId === input.clientStrategyId,
      );
      if (sameClient) {
        const detail = detailOf(sameClient);
        remember(input.accountId, input.idempotencyKey, 'create', detail);
        return detail;
      }
      const now = new Date().toISOString();
      const row: MemoryRow = {
        id: `studio_${crypto.randomUUID()}`,
        accountId: input.accountId,
        clientStrategyId: input.clientStrategyId,
        deletedAt: null,
        createdAt: now,
        name: null,
        folder: '',
        description: '',
        organised: 0,
        restores: 0,
        versions: [{ ...clone(input.draft), version: 1, createdAt: now }],
      };
      rows.set(row.id, row);
      const detail = detailOf(row);
      remember(input.accountId, input.idempotencyKey, 'create', detail);
      return detail;
    },

    async revise(input) {
      const existing = prior(input.accountId, input.idempotencyKey);
      if (existing) {
        if (existing.operation !== 'revise') idempotencyConflict(existing.operation);
        return existing.response;
      }
      const row = owned(input.accountId, input.id);
      if (!row || row.deletedAt) throw new QuantError(QUANT_STUDIO_NOT_FOUND, 'strategy not found');
      const previous = row.versions[row.versions.length - 1];
      if (!previous) throw new QuantError(QUANT_STUDIO_NOT_FOUND, 'strategy not found');
      const next: StrategyVersionRecord = { ...clone(input.draft), version: previous.version + 1, createdAt: new Date().toISOString() };
      row.versions.push(next);
      // A saved version names the strategy again; the head follows it until the next rename.
      row.name = null;
      const detail = detailOf(row);
      remember(input.accountId, input.idempotencyKey, 'revise', detail);
      return detail;
    },

    async softDelete(input) {
      const existing = prior(input.accountId, input.idempotencyKey);
      if (existing) {
        if (existing.operation !== 'delete') idempotencyConflict(existing.operation);
        return { ok: true as const };
      }
      const row = owned(input.accountId, input.id);
      if (!row || row.deletedAt) throw new QuantError(QUANT_STUDIO_NOT_FOUND, 'strategy not found');
      row.deletedAt = new Date().toISOString();
      remember(input.accountId, input.idempotencyKey, 'delete', { ok: true });
      return { ok: true as const };
    },

    async organise(input) {
      const existing = prior(input.accountId, input.idempotencyKey);
      if (existing) {
        if (existing.operation !== 'organise') idempotencyConflict(existing.operation);
        return existing.response;
      }
      const row = owned(input.accountId, input.id);
      if (!row || row.deletedAt) throw new QuantError(QUANT_STUDIO_NOT_FOUND, 'strategy not found');
      row.name = input.head.name;
      row.folder = input.head.folder;
      row.description = input.head.description;
      row.organised += 1;
      const detail = detailOf(row);
      remember(input.accountId, input.idempotencyKey, 'organise', detail);
      return detail;
    },

    async restore(input) {
      const existing = prior(input.accountId, input.idempotencyKey);
      if (existing) {
        if (existing.operation !== 'restore') idempotencyConflict(existing.operation);
        return existing.response;
      }
      const row = owned(input.accountId, input.id);
      if (!row) throw new QuantError(QUANT_STUDIO_NOT_FOUND, 'strategy not found');
      if (row.deletedAt) {
        row.deletedAt = null;
        row.restores += 1;
      }
      const detail = detailOf(row);
      remember(input.accountId, input.idempotencyKey, 'restore', detail);
      return detail;
    },

    async listDeleted(input) {
      const deleted = [...rows.values()].filter((row) => row.accountId === input.accountId && row.deletedAt !== null);
      const paged = page(deleted, input.limit, input.cursor);
      return { strategies: paged.rows.map(headOf), nextCursor: paged.nextCursor };
    },

    async list(input) {
      const live = [...rows.values()].filter((row) => row.accountId === input.accountId && row.deletedAt === null);
      const paged = page(live, input.limit, input.cursor);
      return { strategies: paged.rows.map(headOf), nextCursor: paged.nextCursor };
    },

    async get(input) {
      const row = owned(input.accountId, input.id);
      if (!row || row.deletedAt) return null;
      return detailOf(row);
    },

    async versions(input) {
      const row = owned(input.accountId, input.id);
      if (!row) return null;
      return clone(row.versions);
    },

    async operatorList(input): Promise<OperatorListPage> {
      const live = [...rows.values()].filter((row) => row.deletedAt === null);
      const paged = page(live, input.limit, input.cursor);
      return { strategies: paged.rows.map(metadataOf), nextCursor: paged.nextCursor, quarantineCount: 0 };
    },

    async saveBacktest(input) {
      const existing = prior(input.accountId, input.idempotencyKey);
      if (existing) {
        if (existing.operation !== 'backtest') idempotencyConflict(existing.operation);
        return existing.response;
      }
      const row = owned(input.accountId, input.strategyId);
      if (!row || row.deletedAt) throw new QuantError(QUANT_STUDIO_NOT_FOUND, 'strategy not found');
      if (!row.versions.some((version) => version.version === input.strategyVersion)) {
        throw new QuantError(QUANT_STUDIO_NOT_FOUND, 'strategy not found');
      }
      const result = clone(input.result);
      remember(input.accountId, input.idempotencyKey, 'backtest', result);
      return result;
    },
  };
}
