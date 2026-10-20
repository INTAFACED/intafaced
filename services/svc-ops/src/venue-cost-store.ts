import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { OPS_COST_CATEGORIES, type OpsCostCategory, type OpsCostEntry } from '@intafaced/contracts';
import { OPS_IDEMPOTENCY_CONFLICT, OpsError } from './codes.js';

/** What the operator typed, already validated and with the amount normalised. */
export interface VenueCostFields {
  readonly period: string;
  readonly category: OpsCostCategory;
  readonly amount: string;
  readonly asset: string;
  readonly sourceNote: string;
}

export interface VenueCostActors {
  readonly enteredBy: string;
  readonly approverId: string;
  readonly enteredAt: string;
}

export interface VenueCostStore {
  /** The stored entry for this key. A different fingerprint is a conflict, never a second row. */
  find(key: string, fingerprint: string): Promise<OpsCostEntry | null>;
  /**
   * Appends the next version of (period, category), or returns the entry a racing call stored
   * first under the same key. An earlier version is never changed: the report reads the latest.
   */
  append(key: string, fingerprint: string, fields: VenueCostFields, actors: VenueCostActors): Promise<OpsCostEntry>;
  /** Every version for the period, oldest first within a category. */
  list(period: string): Promise<readonly OpsCostEntry[]>;
}

export const costFingerprint = (body: unknown): string => createHash('sha256').update(JSON.stringify(body)).digest('hex');

export const venueCostKey = (period: string, category: string, version: number): string => `venue-cost:${period}:${category}:${version}`;

const conflict = () => new OpsError(OPS_IDEMPOTENCY_CONFLICT, 'This idempotency key was already used for a different request');

const categoryRank = (category: string) => OPS_COST_CATEGORIES.indexOf(category as OpsCostCategory);

/** For tests that need a store without PostgreSQL. A running service uses the durable store. */
export function createMemoryVenueCostStore(): VenueCostStore {
  const byKey = new Map<string, { fingerprint: string; entry: OpsCostEntry }>();
  const all: OpsCostEntry[] = [];
  return {
    async find(key, fingerprint) {
      const hit = byKey.get(key);
      if (!hit) return null;
      if (hit.fingerprint !== fingerprint) throw conflict();
      return hit.entry;
    },
    async append(key, fingerprint, fields, actors) {
      const hit = byKey.get(key);
      if (hit) {
        if (hit.fingerprint !== fingerprint) throw conflict();
        return hit.entry;
      }
      const version = all.filter((e) => e.period === fields.period && e.category === fields.category).length + 1;
      const entry: OpsCostEntry = {
        key: venueCostKey(fields.period, fields.category, version),
        period: fields.period,
        category: fields.category,
        version,
        amount: fields.amount,
        asset: fields.asset,
        sourceNote: fields.sourceNote,
        enteredBy: actors.enteredBy,
        approverId: actors.approverId,
        enteredAt: actors.enteredAt,
      };
      byKey.set(key, { fingerprint, entry });
      all.push(entry);
      return entry;
    },
    async list(period) {
      return all
        .filter((e) => e.period === period)
        .sort((a, b) => categoryRank(a.category) - categoryRank(b.category) || a.version - b.version);
    },
  };
}

interface EntryRow {
  period: string;
  category: OpsCostCategory;
  version: number;
  amount: string;
  asset: string;
  source_note: string;
  entered_by: string;
  approver_id: string;
  entered_at: Date;
  fingerprint?: string;
}

/** numeric(38,18) comes back with trailing zeros; the wire form is the shortest decimal string. */
export function trimDecimal(value: string): string {
  if (!value.includes('.')) return value;
  const trimmed = value.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '' ? '0' : trimmed;
}

const toEntry = (row: EntryRow): OpsCostEntry => ({
  key: venueCostKey(row.period, row.category, row.version),
  period: row.period,
  category: row.category,
  version: row.version,
  amount: trimDecimal(row.amount),
  asset: row.asset,
  sourceNote: row.source_note,
  enteredBy: row.entered_by,
  approverId: row.approver_id,
  enteredAt: row.entered_at.toISOString(),
});

/** Entries live in `ops.venue_cost_entries`: append-only, one row per idempotency key and per (period, category, version). */
export function createPgVenueCostStore(sql: Sql): VenueCostStore {
  const byKey = async (q: Sql, key: string, fingerprint: string): Promise<OpsCostEntry | null> => {
    const [row] = await q<
      EntryRow[]
    >`SELECT period,category,version,amount::text AS amount,asset,source_note,entered_by,approver_id,entered_at,fingerprint FROM ops.venue_cost_entries WHERE idempotency_key=${key}`;
    if (!row) return null;
    if (row.fingerprint !== fingerprint) throw conflict();
    return toEntry(row);
  };
  return {
    find: (key, fingerprint) => byKey(sql, key, fingerprint),
    async append(key, fingerprint, fields, actors) {
      return sql.begin(async (tx) => {
        // One writer per (period, category) at a time, so versions count up without gaps.
        await tx`SELECT pg_advisory_xact_lock(hashtext(${`ops.venue_cost:${fields.period}:${fields.category}`}))`;
        const prior = await byKey(tx as unknown as Sql, key, fingerprint);
        if (prior) return prior;
        const [latest] = await tx<{ id: string; version: number }[]>`SELECT id, version FROM ops.venue_cost_entries
          WHERE period=${fields.period} AND category=${fields.category} ORDER BY version DESC LIMIT 1`;
        const [row] = await tx<EntryRow[]>`INSERT INTO ops.venue_cost_entries
          (idempotency_key,fingerprint,period,category,version,amount,asset,source_note,entered_by,approver_id,supersedes_id,entered_at)
          VALUES (${key},${fingerprint},${fields.period},${fields.category},${(latest?.version ?? 0) + 1},${fields.amount},${fields.asset},
            ${fields.sourceNote},${actors.enteredBy},${actors.approverId},${latest?.id ?? null},${actors.enteredAt})
          RETURNING period,category,version,amount::text AS amount,asset,source_note,entered_by,approver_id,entered_at,fingerprint`;
        return toEntry(row!);
      });
    },
    async list(period) {
      const rows = await sql<
        EntryRow[]
      >`SELECT period,category,version,amount::text AS amount,asset,source_note,entered_by,approver_id,entered_at,fingerprint FROM ops.venue_cost_entries WHERE period=${period}`;
      return rows.map(toEntry).sort((a, b) => categoryRank(a.category) - categoryRank(b.category) || a.version - b.version);
    },
  };
}
