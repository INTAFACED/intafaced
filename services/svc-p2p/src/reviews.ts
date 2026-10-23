/**
 * P-ads-merchant-21: one good/bad review per party on a released trade.
 *
 * The business key is (trade, author). A second leave returns the first row
 * and does not overwrite it. A hide writes the audit in the same transaction.
 * No money moves here.
 */
import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';

export type ReviewRating = 'good' | 'bad';

export type ReviewErrorCode =
  | 'p2p.review_not_eligible'
  | 'p2p.review_exists'
  | 'p2p.explanation_required'
  | 'p2p.reason_required'
  | 'p2p.cursor_invalid'
  | 'p2p.trade_not_found'
  | 'p2p.idempotency_in_progress';

export class ReviewError extends Error {
  constructor(
    message: string,
    readonly code: ReviewErrorCode,
  ) {
    super(message);
    this.name = 'ReviewError';
  }
}

export interface ReviewRecord {
  id: string;
  tradeId: string;
  authorId: string;
  subjectId: string;
  rating: ReviewRating;
  comment: string;
  explanation: string | null;
  reply: string | null;
  repliedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  hidden: boolean;
  hiddenReason: string | null;
}

export interface ReviewRatingCounts {
  good: number;
  bad: number;
}

interface ReviewRow {
  id: string;
  trade_id: string;
  author_id: string;
  subject_id: string;
  rating: ReviewRating;
  comment: string;
  explanation: string | null;
  reply: string | null;
  replied_at: Date | null;
  created_at: Date;
  updated_at: Date;
  hidden: boolean;
  hidden_reason: string | null;
  created_at_exact?: string;
}

const TEXT_MAX = 2000;

function trimmed(value: string | null | undefined): string {
  return (value ?? '').trim();
}

function bounded(value: string, field: string): string {
  if (value.length > TEXT_MAX) {
    throw new ReviewError(`p2p.review_not_eligible: ${field} is longer than ${TEXT_MAX} characters`, 'p2p.review_not_eligible');
  }
  return value;
}

function toReview(row: ReviewRow): ReviewRecord {
  return {
    id: row.id,
    tradeId: row.trade_id,
    authorId: row.author_id,
    subjectId: row.subject_id,
    rating: row.rating,
    comment: row.comment,
    explanation: row.explanation,
    reply: row.reply,
    repliedAt: row.replied_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    hidden: row.hidden,
    hiddenReason: row.hidden_reason,
  };
}

function missingTrade(tradeId: string): ReviewError {
  return new ReviewError(`Trade ${tradeId} not found`, 'p2p.trade_not_found');
}

export function encodeReviewCursor(row: { createdAtExact: string; id: string }): string {
  return Buffer.from(`${row.createdAtExact}\n${row.id}`, 'utf8').toString('base64url');
}

export function decodeReviewCursor(cursor: string): { createdAtExact: string; id: string } {
  let raw: string;
  try {
    raw = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new ReviewError('p2p.cursor_invalid', 'p2p.cursor_invalid');
  }
  const [createdAtExact, id] = raw.split('\n');
  if (!createdAtExact || !id || !/^\d{20}$/.test(createdAtExact)) {
    throw new ReviewError('p2p.cursor_invalid', 'p2p.cursor_invalid');
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
    throw new ReviewError('p2p.cursor_invalid', 'p2p.cursor_invalid');
  }
  return { createdAtExact, id };
}

export async function leaveReview(
  sql: Sql,
  input: { tradeId: string; authorId: string; rating: ReviewRating; comment?: string; explanation?: string },
): Promise<ReviewRecord> {
  const comment = bounded(trimmed(input.comment), 'comment');
  const explanation = bounded(trimmed(input.explanation), 'explanation');
  if (input.rating === 'bad' && explanation === '') {
    throw new ReviewError('p2p.explanation_required', 'p2p.explanation_required');
  }
  const row = await transaction(sql, async (tx) => {
    const trades = await tx<Array<{ id: string; buyer_id: string; seller_id: string; status: string }>>`
      SELECT id, buyer_id, seller_id, status FROM p2p.p2p_trades WHERE id = ${input.tradeId} FOR SHARE
    `;
    const trade = trades[0];
    if (!trade) throw missingTrade(input.tradeId);
    if (trade.buyer_id !== input.authorId && trade.seller_id !== input.authorId) throw missingTrade(input.tradeId);
    if (trade.status !== 'released') {
      throw new ReviewError('p2p.review_not_eligible: only a released trade can be reviewed', 'p2p.review_not_eligible');
    }
    const subjectId = trade.buyer_id === input.authorId ? trade.seller_id : trade.buyer_id;
    const inserted = await tx<ReviewRow[]>`
      INSERT INTO p2p.order_reviews (trade_id, author_id, subject_id, rating, comment, explanation)
      VALUES (
        ${trade.id},
        ${input.authorId},
        ${subjectId},
        ${input.rating},
        ${comment},
        ${explanation === '' ? null : explanation}
      )
      ON CONFLICT (trade_id, author_id) DO NOTHING
      RETURNING *
    `;
    if (inserted[0]) return inserted[0];
    const existing = await tx<ReviewRow[]>`
      SELECT * FROM p2p.order_reviews WHERE trade_id = ${trade.id} AND author_id = ${input.authorId}
    `;
    if (!existing[0]) throw new ReviewError('p2p.idempotency_in_progress', 'p2p.idempotency_in_progress');
    return existing[0];
  });
  return toReview(row);
}

export async function editReview(
  sql: Sql,
  input: {
    tradeId: string;
    authorId: string;
    windowSeconds: number;
    rating?: ReviewRating;
    comment?: string;
    explanation?: string;
  },
): Promise<ReviewRecord> {
  const row = await transaction(sql, async (tx) => {
    const rows = await tx<Array<ReviewRow & { within_window: boolean; edit_until: Date }>>`
      SELECT *,
             (created_at + make_interval(secs => ${input.windowSeconds}::int) >= now()) AS within_window,
             (created_at + make_interval(secs => ${input.windowSeconds}::int)) AS edit_until
        FROM p2p.order_reviews
       WHERE trade_id = ${input.tradeId} AND author_id = ${input.authorId}
       FOR UPDATE
    `;
    const current = rows[0];
    if (!current) {
      throw new ReviewError('p2p.review_not_eligible: no review to edit', 'p2p.review_not_eligible');
    }
    if (!current.within_window) {
      const until = current.edit_until instanceof Date ? current.edit_until.toISOString() : String(current.edit_until);
      throw new ReviewError(`p2p.review_not_eligible: edit window ended at ${until}`, 'p2p.review_not_eligible');
    }
    const rating = input.rating ?? current.rating;
    const comment = input.comment === undefined ? current.comment : bounded(trimmed(input.comment), 'comment');
    const explanation = input.explanation === undefined ? (current.explanation ?? '') : bounded(trimmed(input.explanation), 'explanation');
    if (rating === 'bad' && explanation === '') {
      throw new ReviewError('p2p.explanation_required', 'p2p.explanation_required');
    }
    const updated = await tx<ReviewRow[]>`
      UPDATE p2p.order_reviews
         SET rating = ${rating},
             comment = ${comment},
             explanation = ${explanation === '' ? null : explanation},
             updated_at = now()
       WHERE id = ${current.id}
      RETURNING *
    `;
    return updated[0]!;
  });
  return toReview(row);
}

export async function replyReview(sql: Sql, input: { tradeId: string; subjectId: string; text: string }): Promise<ReviewRecord> {
  const text = bounded(trimmed(input.text), 'reply');
  if (text === '') throw new ReviewError('p2p.reason_required', 'p2p.reason_required');
  const row = await transaction(sql, async (tx) => {
    const rows = await tx<ReviewRow[]>`
      SELECT * FROM p2p.order_reviews
       WHERE trade_id = ${input.tradeId} AND subject_id = ${input.subjectId}
       FOR UPDATE
    `;
    const current = rows[0];
    if (!current || current.hidden) {
      throw new ReviewError('p2p.review_not_eligible: no review to reply to', 'p2p.review_not_eligible');
    }
    if (current.reply !== null) {
      if (current.reply === text) return current;
      throw new ReviewError('p2p.review_exists', 'p2p.review_exists');
    }
    const updated = await tx<ReviewRow[]>`
      UPDATE p2p.order_reviews
         SET reply = ${text}, replied_at = now(), updated_at = now()
       WHERE id = ${current.id} AND reply IS NULL
      RETURNING *
    `;
    if (updated[0]) return updated[0];
    const again = await tx<ReviewRow[]>`SELECT * FROM p2p.order_reviews WHERE id = ${current.id}`;
    const winner = again[0];
    if (winner && winner.reply === text) return winner;
    throw new ReviewError('p2p.review_exists', 'p2p.review_exists');
  });
  return toReview(row);
}

export async function moderateReview(sql: Sql, input: { reviewId: string; actorId: string; reason: string }): Promise<ReviewRecord> {
  const reason = bounded(trimmed(input.reason), 'reason');
  if (reason === '') throw new ReviewError('p2p.reason_required', 'p2p.reason_required');
  const row = await transaction(sql, async (tx) => {
    const rows = await tx<ReviewRow[]>`
      SELECT * FROM p2p.order_reviews WHERE id = ${input.reviewId} FOR UPDATE
    `;
    const current = rows[0];
    if (!current) throw new ReviewError('p2p.review_not_eligible: no such review', 'p2p.review_not_eligible');
    if (current.hidden) return current;
    const updated = await tx<ReviewRow[]>`
      UPDATE p2p.order_reviews
         SET hidden = true,
             hidden_reason = ${reason},
             hidden_at = now(),
             hidden_by = ${input.actorId},
             updated_at = now()
       WHERE id = ${current.id} AND hidden = false
      RETURNING *
    `;
    const hidden = updated[0];
    if (!hidden) {
      const again = await tx<ReviewRow[]>`SELECT * FROM p2p.order_reviews WHERE id = ${current.id}`;
      return again[0]!;
    }
    await tx`
      INSERT INTO p2p.order_review_audit (review_id, actor_id, reason, before_hidden, after_hidden)
      VALUES (${hidden.id}, ${input.actorId}, ${reason}, false, true)
    `;
    return hidden;
  });
  return toReview(row);
}

export async function listReviews(
  sql: Sql,
  input: { subjectId: string; viewerId: string; limit: number; cursor?: string | null },
): Promise<{ reviews: ReviewRecord[]; nextCursor: string | null }> {
  const cursor = input.cursor ? decodeReviewCursor(input.cursor) : null;
  const rows = await sql<ReviewRow[]>`
    SELECT *, to_char(created_at AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSUS') AS created_at_exact
      FROM p2p.order_reviews
     WHERE subject_id = ${input.subjectId}
       AND (hidden = false OR author_id = ${input.viewerId})
       AND (
         ${cursor?.createdAtExact ?? null}::text IS NULL
         OR to_char(created_at AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSUS') < ${cursor?.createdAtExact ?? null}
         OR (
           to_char(created_at AT TIME ZONE 'UTC', 'YYYYMMDDHH24MISSUS') = ${cursor?.createdAtExact ?? null}
           AND id::text < ${cursor?.id ?? null}
         )
       )
     ORDER BY created_at DESC, id DESC
     LIMIT ${input.limit + 1}
  `;
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  const nextCursor =
    rows.length > input.limit && last?.created_at_exact ? encodeReviewCursor({ createdAtExact: last.created_at_exact, id: last.id }) : null;
  return { reviews: page.map(toReview), nextCursor };
}

/** Visible reviews about this person. Null when there are none — not 0 and 0. */
export async function reviewRatingOf(sql: Sql, subjectId: string): Promise<ReviewRatingCounts | null> {
  const rows = await sql<Array<{ good: number; bad: number }>>`
    SELECT count(*) FILTER (WHERE rating = 'good')::int AS good,
           count(*) FILTER (WHERE rating = 'bad')::int AS bad
      FROM p2p.order_reviews
     WHERE subject_id = ${subjectId} AND hidden = false
  `;
  const good = Number(rows[0]?.good ?? 0);
  const bad = Number(rows[0]?.bad ?? 0);
  if (good + bad === 0) return null;
  return { good, bad };
}
