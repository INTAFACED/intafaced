import { createHmac, randomUUID } from 'node:crypto';
import type { Sql } from 'postgres';
import {
  CUSTOMER_DETAIL_KEYS,
  CUSTOMER_PROTECTED_DETAIL_KEYS,
  customerDetailDecisionInputSchema,
  customerDetailReviewSchema,
  customerDetailsEditInputSchema,
  customerDetailsHistoryInputSchema,
  customerDetailsLookupInputSchema,
  customerDetailsResultSchema,
  customerDetailsSchema,
  customerDetailsStateSchema,
  holderNameCheckInputSchema,
  type Context,
  type CustomerDetailDecisionInput,
  type CustomerDetailKey,
  type CustomerDetailReview,
  type CustomerDetails,
  type CustomerDetailsEditInput,
  type CustomerDetailsResult,
  type CustomerDetailsState,
  type HolderNameCheck,
  type HolderNameCheckInput,
} from '@intafaced/contracts';
import { decryptDocument, encryptDocument } from '../kyc/document-crypto.js';
import { FounderControlError, type FounderControls, type UserRow } from './founder-controls.js';

/**
 * Staff edits of one customer's personal details (J-ops-console-04 #9, OPS-accounts-desk-02). A live founder applies
 * contact, address, occupation, income and business details at once, with a reason. Name, date of birth and tax number
 * are protected: an edit of them opens a compliance review and the record keeps the old values; the other founder passes
 * or rejects it, and only a pass applies the proposed values. One review is open per customer at a time.
 *
 * The details are PII, so identity keeps them encrypted under the KYC document key (`IDENTITY_KYC_DOC_KEY`); with the key
 * unset every door refuses `identity.details_unconfigured` and nothing is stored. The history keeps the fields, the people
 * and the reason, never a value, and request fingerprints are keyed hashes so a stored hash does not reveal a value.
 */

type DetailsRefusal = Extract<CustomerDetailsResult, { outcome: 'refused' }>['code'];
type Sealed = { ciphertext: Buffer; nonce: Buffer; key_id: string };
type ReviewRow = Sealed & {
  review_id: string;
  user_id: string;
  status: 'open' | 'passed' | 'rejected';
  fields: string[];
  document_ids: string[];
  reason: string;
  requested_by: string;
  requested_at: Date;
  decided_by: string | null;
  decided_at: Date | null;
  decision_note: string | null;
};

const PROTECTED: readonly CustomerDetailKey[] = CUSTOMER_PROTECTED_DETAIL_KEYS;
const proposedSchema = customerDetailsSchema.pick({ legalName: true, dateOfBirth: true, taxNumber: true }).partial().strict();

export const EMPTY_CUSTOMER_DETAILS: CustomerDetails = customerDetailsSchema.parse(
  Object.fromEntries(CUSTOMER_DETAIL_KEYS.map((key) => [key, null])),
);

/** Latin letters NFKD leaves whole, spelled as their usual ASCII stand-ins. */
const LATIN_FOLD: Readonly<Record<string, string>> = { ø: 'o', ł: 'l', đ: 'd', ð: 'd', þ: 'th', æ: 'ae', œ: 'oe', ß: 'ss', ı: 'i' };

/**
 * A name as the own-name rule compares it: compatibility-decomposed, accents dropped from Latin letters only (in other
 * scripts a mark can be a vowel, so it stays), lower case, the Latin letters NFKD keeps whole folded (ø o, ß ss, æ ae),
 * every dash, apostrophe, full stop and comma read as a space, and runs of space collapsed. The words and their order
 * still count, so "Anna-Lena Müller" matches "anna lena muller" and not "Müller Anna-Lena". Exact after this, never
 * fuzzy: a looser tolerance is an owner decision the rule does not have yet.
 */
export function holderNameKey(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/(\p{Script=Latin})\p{M}+/gu, '$1')
    .toLowerCase()
    .replace(/[øłđðþæœßı]/g, (letter) => LATIN_FOLD[letter] ?? letter)
    .replace(/[\p{Pd}'‘’ʼ`´.,]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .normalize('NFC');
}

export class CustomerDetailsDesk {
  constructor(
    private readonly sql: Sql,
    private readonly controls: Pick<FounderControls, 'founderStep'>,
    private readonly key: Buffer | null,
  ) {}

  private seal(value: unknown): { ciphertext: Buffer; nonce: Buffer } {
    return encryptDocument(this.key!, Buffer.from(JSON.stringify(value), 'utf8'));
  }

  /**
   * Opens a stored row. A row sealed under another key id, one the key no longer opens (a rotated or wrong
   * `IDENTITY_KYC_DOC_KEY`), or one that no longer parses refuses `identity.details_unreadable`: the record is not
   * guessed at and nothing is written over it.
   */
  private unseal<T>(row: Sealed, schema: { parse(value: unknown): T }): T {
    try {
      if (row.key_id !== 'v1') throw new Error('unknown key id');
      return schema.parse(JSON.parse(decryptDocument(this.key!, row.ciphertext, row.nonce).toString('utf8')));
    } catch {
      throw new FounderControlError('identity.details_unreadable', 'identity.details_unreadable');
    }
  }

  private fingerprint(actorId: string | null, input: unknown): string {
    return createHmac('sha256', this.key!).update(JSON.stringify({ actorId, input })).digest('hex');
  }

  private requireKey(): void {
    if (!this.key)
      // The message is the code, so the console names it: the KYC document key (IDENTITY_KYC_DOC_KEY) is unset.
      throw new FounderControlError('identity.details_unconfigured', 'identity.details_unconfigured');
  }

  private async read(tx: Sql, userId: string): Promise<{ version: string; details: CustomerDetails }> {
    const [row] = await tx<
      Array<Sealed & { version: string }>
    >`SELECT version::text AS version, ciphertext, nonce, key_id FROM customer_details WHERE user_id = ${userId} FOR UPDATE`;
    if (!row) return { version: '0', details: EMPTY_CUSTOMER_DETAILS };
    return { version: row.version, details: this.unseal(row, customerDetailsSchema) };
  }

  private async write(tx: Sql, userId: string, version: string, details: CustomerDetails, actorId: string): Promise<void> {
    const { ciphertext, nonce } = this.seal(customerDetailsSchema.parse(details));
    await tx`INSERT INTO customer_details (user_id, version, ciphertext, nonce, updated_by)
      VALUES (${userId}, ${version}::bigint, ${ciphertext}, ${nonce}, ${actorId})
      ON CONFLICT (user_id) DO UPDATE SET version = EXCLUDED.version, ciphertext = EXCLUDED.ciphertext, nonce = EXCLUDED.nonce,
        updated_at = now(), updated_by = EXCLUDED.updated_by`;
  }

  private review(row: ReviewRow): CustomerDetailReview {
    return customerDetailReviewSchema.parse({
      reviewId: row.review_id,
      userId: row.user_id,
      status: row.status,
      fields: row.fields,
      proposed: this.unseal(row, proposedSchema),
      documentIds: row.document_ids,
      reason: row.reason,
      requestedBy: row.requested_by,
      requestedAt: row.requested_at.toISOString(),
      decidedBy: row.decided_by,
      decidedAt: row.decided_at?.toISOString() ?? null,
      decisionNote: row.decision_note,
    });
  }

  /** Runs one write door: refusals, the request-id replay and the event row are the same for an edit and a decision. */
  private async step(
    context: Context,
    targetId: string,
    request: { requestId: string; input: unknown; fields: readonly CustomerDetailKey[]; reason: string },
    body: (
      tx: Sql,
      kit: {
        actorId: string;
        target: UserRow;
        isFounderRecord: boolean;
        common: Record<string, unknown>;
        refused: (code: DetailsRefusal, reviewId?: string | null) => CustomerDetailsResult;
        finish: (result: CustomerDetailsResult) => Promise<CustomerDetailsResult>;
      },
    ) => Promise<CustomerDetailsResult>,
  ): Promise<CustomerDetailsResult> {
    return this.controls.founderStep(context, targetId, async (tx, founder) => {
      const [clock] = await tx<Array<{ at: Date }>>`SELECT clock_timestamp() AS at`;
      const auditId = randomUUID();
      const common = {
        auditId,
        requestId: request.requestId,
        userId: targetId,
        fields: [...request.fields],
        reason: request.reason,
        occurredAt: clock!.at.toISOString(),
      };
      const refused = (code: DetailsRefusal, reviewId: string | null = null) =>
        customerDetailsResultSchema.parse({
          ...common,
          outcome: 'refused',
          changed: false,
          actorUserId: founder.actorId,
          reviewId,
          code,
        });
      // A caller who is not a live founder, or a desk without its key, is answered and leaves no row: the history is the
      // founders' record of real attempts, and nobody else may write into it.
      if (founder.refusal) return refused(founder.refusal);
      if (!this.key) return refused('identity.details_unconfigured');
      const hash = this.fingerprint(founder.actorId, request.input);
      const record = async (result: CustomerDetailsResult, stored: boolean) => {
        await tx`INSERT INTO customer_detail_events (audit_id, request_id, actor_id, user_id, fingerprint, result, stored)
          VALUES (${auditId}, ${request.requestId}, ${founder.actorId}, ${targetId}, ${hash}, ${tx.json(result as never)}, ${stored})`;
        return result;
      };
      const [previous] = await tx<
        Array<{ fingerprint: string; result: unknown }>
      >`SELECT fingerprint, result FROM customer_detail_events WHERE request_id = ${request.requestId} AND stored`;
      if (previous)
        return previous.fingerprint === hash
          ? customerDetailsResultSchema.parse(previous.result)
          : record(refused('request.conflict'), false);
      if (!founder.target) return record(refused('target.not_found'), true);
      return body(tx, {
        actorId: founder.actorId!,
        target: founder.target,
        isFounderRecord: founder.isFounderRecord,
        common,
        refused,
        finish: (result) => record(result, true),
      });
    });
  }

  /**
   * Change details. Open details apply at once; protected ones open a review and change nothing yet. An edit names the
   * version it read; values equal to the record's are no change.
   */
  async edit(context: Context, raw: CustomerDetailsEditInput): Promise<CustomerDetailsResult> {
    const input = customerDetailsEditInputSchema.parse(raw);
    input.requestId = input.requestId.toLowerCase();
    input.userId = input.userId.toLowerCase();
    const documentIds = [...new Set((input.documentIds ?? []).map((value) => value.toLowerCase()))];
    const fields = CUSTOMER_DETAIL_KEYS.filter((key) => key in input.changes);
    return this.step(
      context,
      input.userId,
      { requestId: input.requestId, input: { ...input, documentIds }, fields, reason: input.reason },
      async (tx, { actorId, target, isFounderRecord, common, refused, finish }) => {
        if (isFounderRecord) return finish(refused('identity.details_founder_forbidden'));
        if (target.archived_at !== null) return finish(refused('identity.account_archived'));
        const guarded = fields.filter((key) => PROTECTED.includes(key));
        if (guarded.length > 0 && guarded.length < fields.length) return finish(refused('identity.details_mixed_edit'));
        // Evidence belongs to a review; an open edit with documents is not one.
        if (guarded.length === 0 && documentIds.length > 0) return finish(refused('identity.details_mixed_edit'));
        const current = await this.read(tx, input.userId);
        if (current.version !== input.expectedVersion)
          return finish(
            customerDetailsResultSchema.parse({
              ...common,
              outcome: 'conflict',
              changed: false,
              actorUserId: actorId,
              reviewId: null,
              code: 'restriction.version_conflict',
              version: current.version,
            }),
          );
        const changed = fields.filter((key) => (input.changes[key] ?? null) !== current.details[key]);
        if (changed.length === 0) return finish(refused('identity.details_unchanged'));
        const values = Object.fromEntries(changed.map((key) => [key, input.changes[key] ?? null]));
        if (guarded.length === 0) {
          const version = (BigInt(current.version) + 1n).toString();
          await this.write(tx, input.userId, version, { ...current.details, ...values }, actorId);
          return finish(
            customerDetailsResultSchema.parse({
              ...common,
              fields: changed,
              outcome: 'applied',
              changed: true,
              actorUserId: actorId,
              reviewId: null,
              version,
            }),
          );
        }
        const [open] = await tx<
          Array<{ review_id: string }>
        >`SELECT review_id FROM customer_detail_reviews WHERE user_id = ${input.userId} AND status = 'open' FOR UPDATE`;
        if (open) return finish(refused('identity.details_review_open', open.review_id));
        if (documentIds.length > 0) {
          const [found] = await tx<
            Array<{ n: number }>
          >`SELECT count(*)::int AS n FROM kyc_documents WHERE user_id = ${input.userId} AND id = ANY(${tx.array(documentIds)}::uuid[])`;
          if (found!.n !== documentIds.length) return finish(refused('identity.details_documents_unknown'));
        }
        const reviewId = randomUUID();
        const { ciphertext, nonce } = this.seal(proposedSchema.parse(values));
        await tx`INSERT INTO customer_detail_reviews (review_id, user_id, status, fields, ciphertext, nonce, document_ids, reason, requested_by, requested_at)
          VALUES (${reviewId}, ${input.userId}, 'open', ${tx.array(changed)}::text[], ${ciphertext}, ${nonce}, ${tx.array(documentIds)}::uuid[],
            ${input.reason}, ${actorId}, ${common.occurredAt as string})`;
        return finish(
          customerDetailsResultSchema.parse({
            ...common,
            fields: changed,
            outcome: 'review_opened',
            changed: false,
            actorUserId: actorId,
            reviewId,
            version: current.version,
          }),
        );
      },
    );
  }

  /**
   * The other founder passes or rejects an open review of the named customer. A pass applies the proposed values; a reject
   * changes nothing. A review of anyone else reads as not found, after the same founder check as every other attempt.
   */
  async decide(context: Context, raw: CustomerDetailDecisionInput): Promise<CustomerDetailsResult> {
    const input = customerDetailDecisionInputSchema.parse(raw);
    input.requestId = input.requestId.toLowerCase();
    input.userId = input.userId.toLowerCase();
    input.reviewId = input.reviewId.toLowerCase();
    return this.step(
      context,
      input.userId,
      { requestId: input.requestId, input, fields: [], reason: input.note },
      async (tx, { actorId, target, common, refused, finish }) => {
        const [row] = await tx<ReviewRow[]>`SELECT * FROM customer_detail_reviews
          WHERE review_id = ${input.reviewId} AND user_id = ${input.userId} FOR UPDATE`;
        if (!row) return finish(refused('identity.details_review_not_found', input.reviewId));
        const fields = CUSTOMER_DETAIL_KEYS.filter((key) => row.fields.includes(key));
        const decline = (code: DetailsRefusal) => finish(customerDetailsResultSchema.parse({ ...refused(code, input.reviewId), fields }));
        if (row.status !== 'open') return decline('identity.details_review_closed');
        if (target.archived_at !== null) return decline('identity.account_archived');
        if (row.requested_by === actorId) return decline('identity.details_review_self_forbidden');
        const current = await this.read(tx, row.user_id);
        const decided = input.decision === 'pass' ? 'passed' : 'rejected';
        await tx`UPDATE customer_detail_reviews SET status = ${decided}, decided_by = ${actorId}, decided_at = ${common.occurredAt as string},
          decision_note = ${input.note} WHERE review_id = ${input.reviewId}`;
        if (input.decision === 'reject')
          return finish(
            customerDetailsResultSchema.parse({
              ...common,
              fields,
              outcome: 'review_rejected',
              changed: false,
              actorUserId: actorId,
              reviewId: input.reviewId,
              version: current.version,
            }),
          );
        const proposed = this.unseal(row, proposedSchema);
        const version = (BigInt(current.version) + 1n).toString();
        await this.write(tx, row.user_id, version, { ...current.details, ...proposed }, actorId);
        return finish(
          customerDetailsResultSchema.parse({
            ...common,
            fields,
            outcome: 'applied',
            changed: true,
            actorUserId: actorId,
            reviewId: input.reviewId,
            version,
          }),
        );
      },
    );
  }

  /** The record as it stands, with its open review if any; null when identity has no such customer. */
  async state(context: Context, raw: { userId: string }): Promise<CustomerDetailsState | null> {
    const userId = customerDetailsLookupInputSchema.parse(raw).userId.toLowerCase();
    return this.controls.founderStep(context, userId, async (tx, founder) => {
      if (founder.refusal) throw new FounderControlError(founder.refusal, 'Live founder authority is required');
      this.requireKey();
      if (!founder.target) return null;
      const current = await this.read(tx, userId);
      const [open] = await tx<ReviewRow[]>`SELECT * FROM customer_detail_reviews WHERE user_id = ${userId} AND status = 'open'`;
      return customerDetailsStateSchema.parse({
        userId,
        version: current.version,
        details: current.details,
        openReview: open ? this.review(open) : null,
        archived: founder.target.archived_at !== null,
      });
    });
  }

  /**
   * The own-name rule (P-ads-merchant-18): is `name` this account's verified legal name? Only the outcome leaves identity.
   * The legal name is verified because a change to it applies only when the other founder passes its compliance review.
   * Null when identity has no such account; a frozen, closed or archived one is `inactive`. No row, or a row with no legal
   * name, is `unverified`; an unset key is `unconfigured`; a row the key cannot open refuses `identity.details_unreadable`.
   * The answer's userId is lower case. Read-only: no founder, no row written.
   */
  async holderNameCheck(raw: HolderNameCheckInput): Promise<HolderNameCheck | null> {
    const input = holderNameCheckInputSchema.parse(raw);
    const userId = input.userId.toLowerCase();
    const [row] = await this.sql<Array<Partial<Sealed> & { live: boolean }>>`
      SELECT u.status = 'active' AND u.archived_at IS NULL AS live, d.ciphertext, d.nonce, d.key_id
        FROM users u LEFT JOIN customer_details d ON d.user_id = u.id
       WHERE u.id = ${userId}`;
    if (!row) return null;
    // A frozen, closed or archived account takes no new destination, whatever its name.
    if (!row.live) return { userId, outcome: 'inactive' };
    if (!this.key) return { userId, outcome: 'unconfigured' };
    const legalName = row.ciphertext ? this.unseal(row as Sealed, customerDetailsSchema).legalName : null;
    const verified = legalName === null ? '' : holderNameKey(legalName);
    if (verified === '') return { userId, outcome: 'unverified' };
    return { userId, outcome: holderNameKey(input.name) === verified ? 'match' : 'mismatch' };
  }

  /** The customer's reviews, newest first. */
  async reviews(context: Context, raw: { userId: string; limit: number }): Promise<CustomerDetailReview[]> {
    const input = customerDetailsHistoryInputSchema.parse(raw);
    const userId = input.userId.toLowerCase();
    return this.controls.founderStep(context, userId, async (tx, founder) => {
      if (founder.refusal) throw new FounderControlError(founder.refusal, 'Live founder authority is required');
      this.requireKey();
      const rows = await tx<ReviewRow[]>`SELECT * FROM customer_detail_reviews WHERE user_id = ${userId}
        ORDER BY requested_at DESC, review_id DESC LIMIT ${input.limit}`;
      return rows.map((row) => this.review(row));
    });
  }

  /** Every edit and decision attempt, newest first: fields, people and reason, never a value. */
  async history(context: Context, raw: { userId: string; limit: number }): Promise<CustomerDetailsResult[]> {
    const input = customerDetailsHistoryInputSchema.parse(raw);
    const userId = input.userId.toLowerCase();
    return this.controls.founderStep(context, userId, async (tx, founder) => {
      if (founder.refusal) throw new FounderControlError(founder.refusal, 'Live founder authority is required');
      const rows = await tx<Array<{ result: unknown }>>`SELECT result FROM customer_detail_events WHERE user_id = ${userId}
        ORDER BY created_at DESC, audit_id DESC LIMIT ${input.limit}`;
      return rows.map((row) => customerDetailsResultSchema.parse(row.result));
    });
  }
}
