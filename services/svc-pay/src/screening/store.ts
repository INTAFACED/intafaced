import { createHash } from 'node:crypto';
import type { Sql } from 'postgres';
import { SCREENING_CASE_STATUSES, type ScreeningCaseStatus, type ScreeningFactor } from './decision.js';

export type ScreeningSubjectKind = 'payout' | 'withdrawal';

/** What a person needs to read a case. An id and an amount, never a name, address or list content. */
export interface ScreeningCaseContext {
  readonly partyRef: string;
  readonly amount: string;
  readonly assetId: string;
  /** Which supplier answered; `none` when no supplier is connected. */
  readonly provider: string;
}

export interface ScreeningCaseRecord {
  readonly subjectKind: ScreeningSubjectKind;
  readonly subjectKey: string;
  readonly status: ScreeningCaseStatus;
  readonly factors: readonly ScreeningFactor[];
  /** Written when present. A read through `ScreeningCaseStore.read` does not return it; the desk (desk.ts) does. */
  readonly context?: ScreeningCaseContext;
}

export interface ScreeningCaseStore {
  save(record: ScreeningCaseRecord): Promise<void>;
  read(subjectKind: ScreeningSubjectKind, subjectKey: string): Promise<ScreeningCaseRecord | null>;
  /**
   * Spend one compliance release, on the caller's own transaction: an unspent, unexpired release for the same party
   * and asset that covers `amount`, of a case other than `exceptKey`. Returns the key of the case it came from, or null.
   * Optional: a store without it never honours a release.
   */
  spendRelease?(q: Sql, want: { partyRef: string; assetId: string; amount: string; exceptKey: string }): Promise<string | null>;
}

/** The factor on the clear case of a send that spent a compliance release. */
export const RELEASE_FACTOR = 'compliance_release';

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
      const c = record.context;
      // A case a person has decided is final: a repeat of the same send leaves it as decided.
      await sql`
        INSERT INTO pay.screening_cases (subject_kind, subject_key, status, factors, party_ref, amount, asset_id, provider)
        VALUES (${record.subjectKind}, ${record.subjectKey}, ${record.status}, ${sql.json(factors)},
                ${c?.partyRef ?? null}, ${c?.amount ?? null}, ${c?.assetId ?? null}, ${c?.provider ?? null})
        ON CONFLICT (subject_kind, subject_key) DO UPDATE
        SET status = EXCLUDED.status, factors = EXCLUDED.factors, updated_at = now(),
            party_ref = COALESCE(EXCLUDED.party_ref, pay.screening_cases.party_ref),
            amount = COALESCE(EXCLUDED.amount, pay.screening_cases.amount),
            asset_id = COALESCE(EXCLUDED.asset_id, pay.screening_cases.asset_id),
            provider = COALESCE(EXCLUDED.provider, pay.screening_cases.provider)
        WHERE pay.screening_cases.decision IS NULL
      `;
    },
    async spendRelease(q, want) {
      const rows = await q<Array<{ subject_key: string; status: string }>>`
        UPDATE pay.screening_cases SET release_consumed_at = now()
         WHERE (subject_kind, subject_key) = (
                 SELECT subject_kind, subject_key FROM pay.screening_cases
                  WHERE subject_kind = 'withdrawal' AND decision = 'released' AND release_consumed_at IS NULL
                    AND release_expires_at > now()
                    AND party_ref = ${want.partyRef} AND asset_id = ${want.assetId}
                    AND amount::numeric >= ${want.amount}::numeric
                    AND subject_key <> ${want.exceptKey}
                  ORDER BY decided_at, subject_key
                  LIMIT 1 FOR UPDATE SKIP LOCKED)
        RETURNING subject_key, status`;
      const spent = rows[0]?.subject_key ?? null;
      if (spent !== null) {
        await q`
          INSERT INTO pay.screening_case_events (subject_kind, subject_key, action, actor_id, from_status, to_status, decision, reason)
          VALUES ('withdrawal', ${spent}, 'release_spent', 'guard', ${rows[0]?.status ?? 'review'}, ${rows[0]?.status ?? 'review'}, 'released', ${`spent by a new withdrawal ${want.exceptKey}`})`;
        // The spending send's own clear case, written in the caller's transaction so it commits or rolls back with the
        // claim and the spend. A retry of the same send (a crash after the claim, before the rail answered) finds it and
        // is honoured; it never spends a second release and never re-asks a screener that may say review.
        await q`
          INSERT INTO pay.screening_cases (subject_kind, subject_key, status, factors, party_ref, amount, asset_id, provider)
          VALUES ('withdrawal', ${want.exceptKey}, 'clear', ${q.json([{ code: RELEASE_FACTOR }])}, ${want.partyRef}, ${want.amount}, ${want.assetId}, 'release')
          ON CONFLICT (subject_kind, subject_key) DO NOTHING`;
      }
      return spent;
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
