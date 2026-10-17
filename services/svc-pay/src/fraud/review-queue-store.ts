import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { Sql, TransactionSql } from 'postgres';
import type { FraudDecision } from './evaluate.js';
import { assertFraudReviewListLimit, FraudReviewError, type FraudReviewStatus } from './review-queue.js';

/**
 * Durable fraud review queue.
 *
 * One row per source and payment ref. A second flag or a second screening
 * review of the same source and ref returns the row that is already there.
 * A merchant fraud review does not occupy the system hold. Decisions are
 * inserted once per effect; a repeated allow or decline does not write another row.
 *
 * The case row holds the current status. `pay.fraud_review_decisions` is
 * append-only.
 */

export interface ReviewReason {
  readonly ruleId: string;
  readonly detail: string;
}

export type ReviewSource = 'screening.review' | 'control.captured_over_cap' | 'fraud.review';

export interface DurableReviewCase {
  readonly id: string;
  readonly merchantId: string;
  readonly paymentId: string | null;
  readonly paymentRef: string | null;
  readonly amount: string;
  readonly assetId: string;
  readonly status: FraudReviewStatus;
  readonly reason: string;
  readonly reasons: readonly ReviewReason[];
  readonly source: ReviewSource;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly claimedBy: string | null;
  readonly claimedAt: string | null;
  readonly resolvedBy: string | null;
  readonly resolvedAt: string | null;
  readonly resolutionNote: string | null;
}

export interface HeldPaymentInput {
  readonly paymentRef: string;
  readonly merchantId: string;
  readonly amount: string;
  readonly assetId: string;
  readonly reason: string;
  readonly reasons: readonly ReviewReason[];
  readonly createdBy: string;
  readonly source: ReviewSource;
  readonly now?: Date;
}

type Query = Sql | TransactionSql;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface CaseRow {
  id: string;
  merchant_id: string;
  payment_ref: string | null;
  amount: string;
  asset_id: string;
  status: string;
  reason: string;
  reasons: unknown;
  source: string;
  created_by: string;
  created_at: Date | string;
  claimed_by: string | null;
  claimed_at: Date | string | null;
  decided_by: string | null;
  decided_at: Date | string | null;
  resolution_note: string | null;
}

function iso(value: Date | string | null): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function reasonsOf(value: unknown): ReviewReason[] {
  if (!Array.isArray(value)) return [];
  const out: ReviewReason[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const ruleId = (item as { ruleId?: unknown }).ruleId;
    const detail = (item as { detail?: unknown }).detail;
    if (typeof ruleId !== 'string' || typeof detail !== 'string' || ruleId.trim() === '' || detail.trim() === '') continue;
    out.push({ ruleId, detail });
  }
  return out;
}

function money(value: string): string {
  const parsed = parseAmount(value);
  if (parsed <= 0n) {
    throw new FraudReviewError('A fraud review case requires a positive amount', 'pay.fraud_review_not_review');
  }
  return formatAmount(parsed);
}

function requiredText(value: string, label: string): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed) {
    throw new FraudReviewError(`${label} is required on a fraud review case`, 'pay.fraud_review_not_review');
  }
  return trimmed;
}

function toCase(row: CaseRow): DurableReviewCase {
  const paymentRef = row.payment_ref;
  const source = row.source;
  if (source !== 'screening.review' && source !== 'control.captured_over_cap' && source !== 'fraud.review') {
    throw new FraudReviewError(`Fraud review ${row.id} has an unknown source`, 'pay.fraud_review_not_found');
  }
  const status = row.status;
  if (status !== 'open' && status !== 'claimed' && status !== 'allowed' && status !== 'declined') {
    throw new FraudReviewError(`Fraud review ${row.id} has an unknown status`, 'pay.fraud_review_not_found');
  }
  return {
    id: row.id,
    merchantId: row.merchant_id,
    paymentRef,
    paymentId: paymentRef && UUID.test(paymentRef) ? paymentRef : null,
    amount: money(row.amount),
    assetId: row.asset_id,
    status,
    reason: row.reason,
    reasons: reasonsOf(row.reasons),
    source,
    createdBy: row.created_by,
    createdAt: iso(row.created_at) ?? '',
    claimedBy: row.claimed_by,
    claimedAt: iso(row.claimed_at),
    resolvedBy: row.decided_by,
    resolvedAt: iso(row.decided_at),
    resolutionNote: row.resolution_note,
  };
}

function pgCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

async function readById(query: Query, id: string): Promise<DurableReviewCase | null> {
  const rows = await query<CaseRow[]>`
    SELECT id, merchant_id, payment_ref, amount::text AS amount, asset_id, status, reason, reasons, source,
           created_by, created_at, claimed_by, claimed_at, decided_by, decided_at, resolution_note
      FROM pay.fraud_review_cases
     WHERE id = ${id}`;
  return rows[0] ? toCase(rows[0]) : null;
}

async function readBySourceAndRef(query: Query, source: ReviewSource, paymentRef: string): Promise<DurableReviewCase | null> {
  const rows = await query<CaseRow[]>`
    SELECT id, merchant_id, payment_ref, amount::text AS amount, asset_id, status, reason, reasons, source,
           created_by, created_at, claimed_by, claimed_at, decided_by, decided_at, resolution_note
      FROM pay.fraud_review_cases
     WHERE source = ${source} AND payment_ref = ${paymentRef}`;
  return rows[0] ? toCase(rows[0]) : null;
}

async function readAllByRef(query: Query, paymentRef: string): Promise<DurableReviewCase[]> {
  const rows = await query<CaseRow[]>`
    SELECT id, merchant_id, payment_ref, amount::text AS amount, asset_id, status, reason, reasons, source,
           created_by, created_at, claimed_by, claimed_at, decided_by, decided_at, resolution_note
      FROM pay.fraud_review_cases
     WHERE payment_ref = ${paymentRef}
     ORDER BY source, id`;
  return rows.map(toCase);
}

/** A merchant enqueue may return only its own fraud.review row. Anything else is not found. */
function adoptFraudReview(rows: readonly DurableReviewCase[], merchantId: string, reportedId: string): DurableReviewCase | null {
  if (rows.length === 0) return null;
  const own = rows.find((row) => row.source === 'fraud.review' && row.merchantId === merchantId);
  if (own) return own;
  throw new FraudReviewError(`No fraud review case ${reportedId}`, 'pay.fraud_review_not_found');
}

function requireOwnFraudReview(found: DurableReviewCase, merchantId: string, reportedId: string): DurableReviewCase {
  if (found.merchantId !== merchantId || found.source !== 'fraud.review') {
    throw new FraudReviewError(`No fraud review case ${reportedId}`, 'pay.fraud_review_not_found');
  }
  return found;
}

async function lockById(query: Query, id: string): Promise<DurableReviewCase | null> {
  const rows = await query<CaseRow[]>`
    SELECT id, merchant_id, payment_ref, amount::text AS amount, asset_id, status, reason, reasons, source,
           created_by, created_at, claimed_by, claimed_at, decided_by, decided_at, resolution_note
      FROM pay.fraud_review_cases
     WHERE id = ${id}
     FOR UPDATE`;
  return rows[0] ? toCase(rows[0]) : null;
}

/**
 * Open one case for a held or flagged payment of this source. A second call
 * with the same source and payment ref returns that case and writes no second
 * enqueue decision. A fraud.review row on the same ref is not this case.
 */
export async function enqueueHeldPayment(query: Query, input: HeldPaymentInput): Promise<DurableReviewCase> {
  const paymentRef = requiredText(input.paymentRef, 'payment ref');
  const merchantId = requiredText(input.merchantId, 'merchant');
  const assetId = requiredText(input.assetId, 'asset');
  const reason = requiredText(input.reason, 'reason');
  const createdBy = requiredText(input.createdBy, 'created by');
  const reasons = input.reasons.filter((item) => item.ruleId.trim() !== '' && item.detail.trim() !== '');
  if (reasons.length === 0) {
    throw new FraudReviewError('A held or flagged payment needs an explainable reason', 'pay.fraud_review_not_review');
  }
  const amount = money(input.amount);
  const createdAt = input.now ?? new Date();
  const existing = await readBySourceAndRef(query, input.source, paymentRef);
  if (existing) return existing;
  const id = await heldCaseId(query, input.source, paymentRef);
  try {
    const inserted = await query<CaseRow[]>`
      INSERT INTO pay.fraud_review_cases (
        id, merchant_id, payment_ref, amount, asset_id, status, reason, reasons, source, created_by, created_at
      ) VALUES (
        ${id}, ${merchantId}, ${paymentRef}, ${amount}, ${assetId}, 'open', ${reason},
        ${query.json(reasons as never)}, ${input.source}, ${createdBy}, ${createdAt}
      )
      ON CONFLICT (id) DO NOTHING
      RETURNING id, merchant_id, payment_ref, amount::text AS amount, asset_id, status, reason, reasons, source,
                created_by, created_at, claimed_by, claimed_at, decided_by, decided_at, resolution_note`;
    if (!inserted[0]) {
      const again = await readBySourceAndRef(query, input.source, paymentRef);
      if (again) return again;
      throw new FraudReviewError(`No fraud review case ${id}`, 'pay.fraud_review_not_found');
    }
    const row = toCase(inserted[0]);
    if (row.source !== input.source || row.paymentRef !== paymentRef) {
      throw new FraudReviewError(`No fraud review case ${id}`, 'pay.fraud_review_not_found');
    }
    await query`
      INSERT INTO pay.fraud_review_decisions (case_id, effect, actor_id, note, decided_at)
      VALUES (${row.id}, 'enqueue', ${createdBy}, ${reason}, ${createdAt})`;
    return row;
  } catch (error) {
    if (error instanceof FraudReviewError) throw error;
    if (pgCode(error) === '23505') {
      const again = await readBySourceAndRef(query, input.source, paymentRef);
      if (again) return again;
    }
    throw error;
  }
}

/** Prefer `held:<ref>`. If a merchant already took that id, use a source-qualified id. Never adopt their row. */
async function heldCaseId(query: Query, source: ReviewSource, paymentRef: string): Promise<string> {
  const candidates = [`held:${paymentRef}`, `held:${source}:${paymentRef}`];
  for (const id of candidates) {
    const owner = await readById(query, id);
    if (!owner || (owner.source === source && owner.paymentRef === paymentRef)) return id;
  }
  throw new FraudReviewError(`No fraud review case held:${paymentRef}`, 'pay.fraud_review_not_found');
}

export async function assertScreeningReviewHasCase(query: Query, subjectKind: string, subjectKey: string): Promise<void> {
  const held = await query<Array<{ status: string }>>`
    SELECT status FROM pay.screening_cases
     WHERE subject_kind = ${subjectKind} AND subject_key = ${subjectKey}`;
  if (held[0]?.status !== 'review') return;
  const paymentRef = `screening:${subjectKind}:${subjectKey}`;
  const found = await readBySourceAndRef(query, 'screening.review', paymentRef);
  if (!found) {
    throw new FraudReviewError(`held payment ${paymentRef} has no fraud review case`, 'pay.fraud_review_missing_case');
  }
}

export async function assertFlaggedPaymentHasCase(query: Query, paymentId: string): Promise<void> {
  const flags = await query<Array<{ id: string }>>`
    SELECT id FROM pay.control_audit
     WHERE kind = 'payment.captured_over_cap'
       AND outcome = 'flagged'
       AND after->>'paymentId' = ${paymentId}`;
  if (!flags[0]) return;
  const found = await readBySourceAndRef(query, 'control.captured_over_cap', paymentId);
  if (!found) {
    throw new FraudReviewError(`held payment ${paymentId} has no fraud review case`, 'pay.fraud_review_missing_case');
  }
}

export class PostgresFraudReviewQueue {
  constructor(private readonly sql: Sql) {}

  async enqueue(input: {
    id: string;
    merchantId: string;
    amount: string;
    assetId: string;
    decision: FraudDecision;
    paymentId?: string | null;
    createdBy?: string | null;
    now?: Date;
  }): Promise<DurableReviewCase> {
    if (input.id.trim().toLowerCase().startsWith('held:')) {
      throw new FraudReviewError('Case ids starting with held: are reserved for system holds', 'pay.fraud_review_not_review');
    }
    if (input.decision.outcome !== 'review' || input.decision.reasons.length === 0) {
      throw new FraudReviewError('Only evaluate outcomes of review may enter the fraud review queue', 'pay.fraud_review_not_review');
    }
    const merchantId = requiredText(input.merchantId, 'merchant');
    const paymentRef = input.paymentId?.trim() || null;
    if (paymentRef) {
      const adopted = adoptFraudReview(await readAllByRef(this.sql, paymentRef), merchantId, input.id);
      if (adopted) return adopted;
    }
    const byId = await readById(this.sql, input.id);
    if (byId) return requireOwnFraudReview(byId, merchantId, input.id);
    const reason = input.decision.reasons.map((item) => item.detail).join('; ');
    const createdBy = input.createdBy?.trim() || 'fraud.enqueue';
    try {
      return await this.sql.begin(async (tx) => {
        if (paymentRef) {
          const adopted = adoptFraudReview(await readAllByRef(tx, paymentRef), merchantId, input.id);
          if (adopted) return adopted;
        }
        const racedId = await readById(tx, input.id);
        if (racedId) return requireOwnFraudReview(racedId, merchantId, input.id);
        const createdAt = input.now ?? new Date();
        const inserted = await tx<CaseRow[]>`
          INSERT INTO pay.fraud_review_cases (
            id, merchant_id, payment_ref, amount, asset_id, status, reason, reasons, source, created_by, created_at
          ) VALUES (
            ${input.id}, ${merchantId}, ${paymentRef}, ${money(input.amount)},
            ${requiredText(input.assetId, 'asset')}, 'open', ${requiredText(reason, 'reason')},
            ${tx.json(input.decision.reasons as never)}, 'fraud.review', ${createdBy}, ${createdAt}
          )
          ON CONFLICT (id) DO NOTHING
          RETURNING id, merchant_id, payment_ref, amount::text AS amount, asset_id, status, reason, reasons, source,
                    created_by, created_at, claimed_by, claimed_at, decided_by, decided_at, resolution_note`;
        if (!inserted[0]) {
          if (paymentRef) {
            const adopted = adoptFraudReview(await readAllByRef(tx, paymentRef), merchantId, input.id);
            if (adopted) return adopted;
          }
          const again = await readById(tx, input.id);
          if (!again) throw new FraudReviewError(`No fraud review case ${input.id}`, 'pay.fraud_review_not_found');
          return requireOwnFraudReview(again, merchantId, input.id);
        }
        await tx`
          INSERT INTO pay.fraud_review_decisions (case_id, effect, actor_id, note, decided_at)
          VALUES (${input.id}, 'enqueue', ${createdBy}, ${reason}, ${createdAt})`;
        return toCase(inserted[0]);
      });
    } catch (error) {
      if (error instanceof FraudReviewError) throw error;
      if (pgCode(error) === '23505') {
        if (paymentRef) {
          const adopted = adoptFraudReview(await readAllByRef(this.sql, paymentRef), merchantId, input.id);
          if (adopted) return adopted;
        }
        const again = await readById(this.sql, input.id);
        if (again) return requireOwnFraudReview(again, merchantId, input.id);
      }
      throw error;
    }
  }

  get(id: string): Promise<DurableReviewCase | null> {
    return readById(this.sql, id);
  }

  async getByPaymentRef(paymentRef: string): Promise<DurableReviewCase | null> {
    const rows = await readAllByRef(this.sql, paymentRef);
    return rows.find((row) => row.source === 'fraud.review') ?? (rows.length === 1 ? rows[0]! : null);
  }

  async listOpen(merchantId: string | undefined, limit: number | undefined): Promise<readonly DurableReviewCase[]> {
    const n = assertFraudReviewListLimit(limit);
    const rows = await this.sql<CaseRow[]>`
      SELECT id, merchant_id, payment_ref, amount::text AS amount, asset_id, status, reason, reasons, source,
             created_by, created_at, claimed_by, claimed_at, decided_by, decided_at, resolution_note
        FROM pay.fraud_review_cases
       WHERE status IN ('open', 'claimed')
         ${merchantId ? this.sql`AND merchant_id = ${merchantId}` : this.sql``}
       ORDER BY created_at, id
       LIMIT ${n}`;
    return rows.map(toCase);
  }

  async claim(input: { id: string; actorId: string; now?: Date }): Promise<DurableReviewCase> {
    const actor = requiredActor(input.actorId);
    return this.sql.begin(async (tx) => {
      const current = await lockById(tx, input.id);
      if (!current) throw new FraudReviewError(`No fraud review case ${input.id}`, 'pay.fraud_review_not_found');
      if (current.status === 'claimed' && current.claimedBy === actor) return current;
      if (current.status === 'claimed') {
        throw new FraudReviewError(`Fraud review ${input.id} is claimed by ${current.claimedBy}`, 'pay.fraud_review_claimed');
      }
      if (current.status !== 'open') {
        throw new FraudReviewError(`Fraud review ${input.id} is already ${current.status}`, 'pay.fraud_review_closed');
      }
      const at = input.now ?? new Date();
      const updated = await tx<CaseRow[]>`
        UPDATE pay.fraud_review_cases
           SET status = 'claimed', claimed_by = ${actor}, claimed_at = ${at}
         WHERE id = ${input.id} AND status = 'open'
        RETURNING id, merchant_id, payment_ref, amount::text AS amount, asset_id, status, reason, reasons, source,
                  created_by, created_at, claimed_by, claimed_at, decided_by, decided_at, resolution_note`;
      if (!updated[0]) {
        const again = await lockById(tx, input.id);
        if (again?.status === 'claimed' && again.claimedBy === actor) return again;
        throw new FraudReviewError(`Fraud review ${input.id} is already ${again?.status ?? 'missing'}`, 'pay.fraud_review_closed');
      }
      await tx`
        INSERT INTO pay.fraud_review_decisions (case_id, effect, actor_id, decided_at)
        VALUES (${input.id}, 'claim', ${actor}, ${at})`;
      return toCase(updated[0]);
    });
  }

  async resolve(input: {
    id: string;
    outcome: 'allow' | 'decline';
    actorId: string;
    note?: string | null;
    now?: Date;
  }): Promise<DurableReviewCase> {
    const actor = requiredActor(input.actorId);
    const wanted = input.outcome === 'allow' ? 'allowed' : 'declined';
    return this.sql.begin(async (tx) => {
      const current = await lockById(tx, input.id);
      if (!current) throw new FraudReviewError(`No fraud review case ${input.id}`, 'pay.fraud_review_not_found');
      if (current.status === wanted) return current;
      if (current.status !== 'open' && current.status !== 'claimed') {
        throw new FraudReviewError(`Fraud review ${input.id} is already ${current.status}`, 'pay.fraud_review_closed');
      }
      const at = input.now ?? new Date();
      const note = input.note?.trim() ? input.note.trim() : null;
      const updated = await tx<CaseRow[]>`
        UPDATE pay.fraud_review_cases
           SET status = ${wanted}, decided_by = ${actor}, decided_at = ${at}, resolution_note = ${note}
         WHERE id = ${input.id} AND status IN ('open', 'claimed')
        RETURNING id, merchant_id, payment_ref, amount::text AS amount, asset_id, status, reason, reasons, source,
                  created_by, created_at, claimed_by, claimed_at, decided_by, decided_at, resolution_note`;
      if (!updated[0]) {
        const again = await lockById(tx, input.id);
        if (again?.status === wanted) return again;
        throw new FraudReviewError(`Fraud review ${input.id} is already ${again?.status ?? 'missing'}`, 'pay.fraud_review_closed');
      }
      await tx`
        INSERT INTO pay.fraud_review_decisions (case_id, effect, actor_id, note, decided_at)
        VALUES (${input.id}, ${input.outcome}, ${actor}, ${note}, ${at})`;
      return toCase(updated[0]);
    });
  }

  async countDecisions(caseId: string, effect?: string): Promise<number> {
    const rows = effect
      ? await this.sql<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM pay.fraud_review_decisions
           WHERE case_id = ${caseId} AND effect = ${effect}`
      : await this.sql<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM pay.fraud_review_decisions WHERE case_id = ${caseId}`;
    return Number(rows[0]?.n ?? 0);
  }
}

function requiredActor(actorId: string): string {
  const actor = actorId?.trim() ?? '';
  if (!actor) {
    throw new FraudReviewError('actorId is required to resolve a fraud review', 'pay.fraud_review_actor_required');
  }
  return actor;
}
