import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { SCREENING_CASE_STATUSES, type ScreeningCaseStatus, type ScreeningFactor } from './decision.js';

export type ScreeningSubjectKind = 'payout' | 'withdrawal';

export interface ScreeningCaseRecord {
  readonly subjectKind: ScreeningSubjectKind;
  readonly subjectKey: string;
  readonly status: ScreeningCaseStatus;
  readonly factors: readonly ScreeningFactor[];
}

export interface ScreeningCaseStore {
  save(record: ScreeningCaseRecord): Promise<void>;
  read(subjectKind: ScreeningSubjectKind, subjectKey: string): Promise<ScreeningCaseRecord | null>;
}

/** Subject key is a hash. The case row does not store names, addresses, or client text. */
export function screeningSubjectKey(kind: ScreeningSubjectKind, parts: readonly string[]): string {
  return createHash('sha256')
    .update([kind, ...parts].join('\0'), 'utf8')
    .digest('hex');
}

const KEY = /^[a-f0-9]{64}$/;
const STATUSES = new Set<string>(SCREENING_CASE_STATUSES);

export function createMemoryScreeningCaseStore(): ScreeningCaseStore & { size(): number } {
  const rows = new Map<string, ScreeningCaseRecord>();
  const id = (record: Pick<ScreeningCaseRecord, 'subjectKind' | 'subjectKey'>) => `${record.subjectKind}:${record.subjectKey}`;
  return {
    size: () => rows.size,
    async save(record) {
      rows.set(id(record), {
        subjectKind: record.subjectKind,
        subjectKey: record.subjectKey,
        status: record.status,
        factors: record.factors.map((item) => ({ code: item.code })),
      });
    },
    async read(subjectKind, subjectKey) {
      return rows.get(id({ subjectKind, subjectKey })) ?? null;
    },
  };
}

function asRecord(subjectKind: string, subjectKey: string, status: string, factors: unknown): ScreeningCaseRecord | null {
  if (subjectKind !== 'payout' && subjectKind !== 'withdrawal') return null;
  if (!KEY.test(subjectKey) || !STATUSES.has(status)) return null;
  if (!Array.isArray(factors)) return null;
  const parsed: ScreeningFactor[] = [];
  for (const item of factors) {
    if (!item || typeof item !== 'object' || typeof (item as { code?: unknown }).code !== 'string') return null;
    parsed.push({ code: (item as { code: string }).code });
  }
  return { subjectKind, subjectKey, status: status as ScreeningCaseStatus, factors: parsed };
}

/** Durable cases. No party name, registration number, or wallet address is written. */
export function createSqlScreeningCaseStore(sql: Sql): ScreeningCaseStore {
  return {
    async save(record) {
      if (!KEY.test(record.subjectKey) || !STATUSES.has(record.status)) {
        throw Object.assign(new Error('screening.case_invalid'), { code: 'screening_case_invalid' });
      }
      const factors = record.factors.map((item) => ({ code: item.code }));
      await sql`
        INSERT INTO pay.screening_cases (subject_kind, subject_key, status, factors)
        VALUES (${record.subjectKind}, ${record.subjectKey}, ${record.status}, ${sql.json(factors)})
        ON CONFLICT (subject_kind, subject_key) DO UPDATE
        SET status = EXCLUDED.status, factors = EXCLUDED.factors, updated_at = now()
      `;
    },
    async read(subjectKind, subjectKey) {
      const rows = await sql<Array<{ subject_kind: string; subject_key: string; status: string; factors: unknown }>>`
        SELECT subject_kind, subject_key, status, factors
        FROM pay.screening_cases
        WHERE subject_kind = ${subjectKind} AND subject_key = ${subjectKey}
      `;
      const row = rows[0];
      if (!row) return null;
      return asRecord(row.subject_kind, row.subject_key, row.status, row.factors);
    },
  };
}
