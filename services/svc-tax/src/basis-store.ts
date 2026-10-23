import { formatAmount, MoneyError, parseAmount } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { TAX_BASIS_OVERRIDE_ABSENT, TAX_BASIS_PRICE_INVALID, TaxError } from './codes.js';

/** One stored version. Append-only: a change is a new version, a removal is a tombstone. */
export interface BasisRow {
  readonly userId: string;
  readonly lotId: string;
  readonly version: number;
  readonly kind: 'override' | 'manual' | 'tombstone';
  readonly pricePerUnit: string | null;
  readonly acquiredAt: string | null;
  readonly sourceNote: string | null;
  readonly assetId: string | null;
  readonly qty: string | null;
  readonly businessKey: string;
}

export type ActiveBasis =
  | {
      readonly kind: 'override';
      readonly lotId: string;
      readonly version: number;
      readonly pricePerUnit: string;
      readonly acquiredAt: string;
      readonly sourceNote: string;
    }
  | {
      readonly kind: 'manual';
      readonly lotId: string;
      readonly version: number;
      readonly pricePerUnit: string;
      readonly acquiredAt: string;
      readonly sourceNote: string;
      readonly assetId: string;
      readonly qty: string;
    };

export interface BasisWrite {
  readonly userId: string;
  readonly lotId: string;
  readonly kind: 'override' | 'manual';
  readonly pricePerUnit: string;
  readonly acquiredAt: string;
  readonly sourceNote: string;
  readonly assetId: string | null;
  readonly qty: string | null;
}

export interface BasisStore {
  listActive(userId: string): Promise<readonly ActiveBasis[]>;
  /** Same payload as the latest row returns that row. A different payload appends the next version. */
  save(input: BasisWrite): Promise<BasisRow>;
  /** Tombstone. A second remove of the same lot returns the tombstone already stored. */
  clear(userId: string, lotId: string): Promise<BasisRow>;
}

interface Stored {
  user_id: string;
  lot_id: string;
  version: number;
  kind: BasisRow['kind'];
  price_per_unit: string | null;
  acquired_at: Date | null;
  source_note: string | null;
  asset_id: string | null;
  qty: string | null;
  business_key: string;
}

/** numeric(38,18) comes back with trailing zeros. The book compares the canonical decimal string. */
function decimalColumn(value: string | null): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new TaxError(TAX_BASIS_PRICE_INVALID, 'a stored basis figure was not a decimal string');
  try {
    return formatAmount(parseAmount(value));
  } catch (err) {
    if (err instanceof MoneyError) throw new TaxError(TAX_BASIS_PRICE_INVALID, 'a stored basis figure was not a decimal string');
    throw err;
  }
}

function toRow(row: Stored): BasisRow {
  return {
    userId: row.user_id,
    lotId: row.lot_id,
    version: Number(row.version),
    kind: row.kind,
    pricePerUnit: decimalColumn(row.price_per_unit),
    acquiredAt: row.acquired_at === null ? null : row.acquired_at.toISOString(),
    sourceNote: row.source_note,
    assetId: row.asset_id,
    qty: decimalColumn(row.qty),
    businessKey: row.business_key,
  };
}

function activeOf(row: BasisRow): ActiveBasis | null {
  if (row.kind === 'tombstone' || row.pricePerUnit === null || row.acquiredAt === null || row.sourceNote === null) return null;
  if (row.kind === 'manual') {
    if (row.assetId === null || row.qty === null) return null;
    return {
      kind: 'manual',
      lotId: row.lotId,
      version: row.version,
      pricePerUnit: row.pricePerUnit,
      acquiredAt: row.acquiredAt,
      sourceNote: row.sourceNote,
      assetId: row.assetId,
      qty: row.qty,
    };
  }
  return {
    kind: 'override',
    lotId: row.lotId,
    version: row.version,
    pricePerUnit: row.pricePerUnit,
    acquiredAt: row.acquiredAt,
    sourceNote: row.sourceNote,
  };
}

function sameWrite(row: BasisRow, input: BasisWrite): boolean {
  return (
    row.kind === input.kind &&
    row.pricePerUnit === input.pricePerUnit &&
    row.acquiredAt === input.acquiredAt &&
    row.sourceNote === input.sourceNote &&
    row.assetId === input.assetId &&
    row.qty === input.qty
  );
}

function businessKey(userId: string, lotId: string, version: number): string {
  return `basisoverride:${userId}:${lotId}:${version}`;
}

function lockKey(userId: string, lotId: string): string {
  return `tax.basis:${userId}:${lotId}`;
}

/** In-process stand-in for tests. One chain per lot, so two saves cannot both become version 1. */
export function createMemoryBasisStore(): BasisStore {
  const rows: BasisRow[] = [];
  const tails = new Map<string, Promise<void>>();

  const locked = async <T>(key: string, body: () => T | Promise<T>): Promise<T> => {
    const prev = tails.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    tails.set(
      key,
      prev.then(() => gate),
    );
    await prev;
    try {
      return await body();
    } finally {
      release();
    }
  };

  const latest = (userId: string, lotId: string): BasisRow | undefined => {
    let found: BasisRow | undefined;
    for (const row of rows) {
      if (row.userId === userId && row.lotId === lotId && (found === undefined || row.version > found.version)) found = row;
    }
    return found;
  };

  const append = (input: BasisWrite | { userId: string; lotId: string; kind: 'tombstone' }): BasisRow => {
    const prev = latest(input.userId, input.lotId);
    const version = (prev?.version ?? 0) + 1;
    const row: BasisRow =
      input.kind === 'tombstone'
        ? {
            userId: input.userId,
            lotId: input.lotId,
            version,
            kind: 'tombstone',
            pricePerUnit: null,
            acquiredAt: null,
            sourceNote: null,
            assetId: null,
            qty: null,
            businessKey: businessKey(input.userId, input.lotId, version),
          }
        : {
            userId: input.userId,
            lotId: input.lotId,
            version,
            kind: input.kind,
            pricePerUnit: input.pricePerUnit,
            acquiredAt: input.acquiredAt,
            sourceNote: input.sourceNote,
            assetId: input.assetId,
            qty: input.qty,
            businessKey: businessKey(input.userId, input.lotId, version),
          };
    rows.push(row);
    return row;
  };

  return {
    async listActive(userId) {
      const byLot = new Map<string, BasisRow>();
      for (const row of rows) {
        if (row.userId !== userId) continue;
        const prev = byLot.get(row.lotId);
        if (prev === undefined || row.version > prev.version) byLot.set(row.lotId, row);
      }
      const active: ActiveBasis[] = [];
      for (const row of byLot.values()) {
        const item = activeOf(row);
        if (item) active.push(item);
      }
      active.sort((a, b) => a.lotId.localeCompare(b.lotId));
      return active;
    },
    save(input) {
      return locked(lockKey(input.userId, input.lotId), () => {
        const prev = latest(input.userId, input.lotId);
        if (prev && sameWrite(prev, input)) return prev;
        return append(input);
      });
    },
    clear(userId, lotId) {
      return locked(lockKey(userId, lotId), () => {
        const prev = latest(userId, lotId);
        if (!prev) throw new TaxError(TAX_BASIS_OVERRIDE_ABSENT, 'no customer basis is stored for that lot');
        if (prev.kind === 'tombstone') return prev;
        return append({ userId, lotId, kind: 'tombstone' });
      });
    },
  };
}

export function createPgBasisStore(sql: Sql): BasisStore {
  const latest = async (tx: Sql, userId: string, lotId: string): Promise<BasisRow | undefined> => {
    const found = await tx<Stored[]>`
      SELECT user_id, lot_id, version, kind, price_per_unit::text AS price_per_unit, acquired_at, source_note, asset_id,
        qty::text AS qty, business_key
      FROM tax.basis_overrides
      WHERE user_id = ${userId} AND lot_id = ${lotId}
      ORDER BY version DESC
      LIMIT 1
    `;
    const row = found[0];
    return row === undefined ? undefined : toRow(row);
  };

  const insert = async (tx: Sql, row: BasisRow): Promise<void> => {
    await tx`
      INSERT INTO tax.basis_overrides (
        user_id, lot_id, version, kind, price_per_unit, acquired_at, source_note, asset_id, qty, business_key
      ) VALUES (
        ${row.userId},
        ${row.lotId},
        ${row.version},
        ${row.kind},
        ${row.pricePerUnit},
        ${row.acquiredAt},
        ${row.sourceNote},
        ${row.assetId},
        ${row.qty},
        ${row.businessKey}
      )
    `;
  };

  const locked = async <T>(userId: string, lotId: string, body: (tx: Sql) => Promise<T>): Promise<T> => {
    return sql.begin(async (tx) => {
      // The transaction client is the same tagged query as `Sql`, without the pool methods.
      const query = tx as unknown as Sql;
      await query`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey(userId, lotId)}, 0))`;
      return body(query);
    }) as Promise<T>;
  };

  return {
    async listActive(userId) {
      const found = await sql<Stored[]>`
        SELECT DISTINCT ON (lot_id)
          user_id, lot_id, version, kind, price_per_unit::text AS price_per_unit, acquired_at, source_note, asset_id,
          qty::text AS qty, business_key
        FROM tax.basis_overrides
        WHERE user_id = ${userId}
        ORDER BY lot_id, version DESC
      `;
      const active: ActiveBasis[] = [];
      for (const row of found) {
        const item = activeOf(toRow(row));
        if (item) active.push(item);
      }
      active.sort((a, b) => a.lotId.localeCompare(b.lotId));
      return active;
    },
    save(input) {
      return locked(input.userId, input.lotId, async (tx) => {
        const prev = await latest(tx, input.userId, input.lotId);
        if (prev && sameWrite(prev, input)) return prev;
        const version = (prev?.version ?? 0) + 1;
        const row: BasisRow = {
          userId: input.userId,
          lotId: input.lotId,
          version,
          kind: input.kind,
          pricePerUnit: input.pricePerUnit,
          acquiredAt: input.acquiredAt,
          sourceNote: input.sourceNote,
          assetId: input.assetId,
          qty: input.qty,
          businessKey: businessKey(input.userId, input.lotId, version),
        };
        await insert(tx, row);
        return row;
      });
    },
    clear(userId, lotId) {
      return locked(userId, lotId, async (tx) => {
        const prev = await latest(tx, userId, lotId);
        if (!prev) throw new TaxError(TAX_BASIS_OVERRIDE_ABSENT, 'no customer basis is stored for that lot');
        if (prev.kind === 'tombstone') return prev;
        const version = prev.version + 1;
        const row: BasisRow = {
          userId,
          lotId,
          version,
          kind: 'tombstone',
          pricePerUnit: null,
          acquiredAt: null,
          sourceNote: null,
          assetId: null,
          qty: null,
          businessKey: businessKey(userId, lotId, version),
        };
        await insert(tx, row);
        return row;
      });
    },
  };
}
