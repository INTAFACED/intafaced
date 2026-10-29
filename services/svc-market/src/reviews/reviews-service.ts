import { div, formatAmount, parseAmount, sum } from '@intafaced/ledger-client';
import type { Sql } from 'postgres';
import { MarketError } from '../vendor-service.js';

/**
 * Mean of review scores: sum of the integer scores divided by the count,
 * rounded half-up at the ledger scale (18 decimal places) via `div(..., 'half-up')`.
 * No reviews → null. Never the string "0".
 */
export const REVIEW_MEAN_ROUNDING = 'half-up-scale-18' as const;

export const MARKET_REVIEWS_LIST_LIMIT_UNSET = 'market.reviews_list_limit_unset' as const;
export const MARKET_REVIEWS_CURSOR_INVALID = 'market.reviews_cursor_invalid' as const;
export const MARKET_REVIEW_NOT_BUYER = 'market.review_not_buyer' as const;
export const MARKET_REVIEW_NOT_SETTLED = 'market.review_not_settled' as const;
export const MARKET_REVIEW_EXISTS = 'market.review_exists' as const;
export const MARKET_REVIEW_SCORE_INVALID = 'market.review_score_invalid' as const;
export const MARKET_REVIEW_TEXT_INVALID = 'market.review_text_invalid' as const;
export const MARKET_CLIENT_REQUEST_ID_REQUIRED = 'market.client_request_id_required' as const;
export const MARKET_IDEMPOTENCY_CONFLICT = 'market.idempotency_conflict' as const;

const CONTROL = /[\u0000-\u001F\u007F]/u;

export interface ReviewRecord {
  id: string;
  purchaseId: string;
  listingId: string;
  vendorId: string;
  buyerId: string;
  score: number;
  text: string | null;
  createdAt: string;
}

/** What `reviews.list` may show. The buyer's id and the purchase id stay off this shape. */
export interface ReviewPublic {
  id: string;
  listingId: string;
  vendorId: string;
  score: number;
  text: string | null;
  createdAt: string;
}

export interface ReviewListPage {
  reviews: ReviewPublic[];
  nextCursor: string | null;
}

export interface ReviewSummary {
  vendorId: string;
  /** Integer decimal. "0" when the vendor has no reviews. */
  count: string;
  /** Exact decimal, or null when count is 0. Never "0". */
  mean: string | null;
  meanRounding: typeof REVIEW_MEAN_ROUNDING;
}

/** One listing's review summary. No buyer id and no purchase id. */
export interface ListingReviewSummary {
  /** Integer decimal. "0" when this listing has no reviews — a count, not a missing amount. */
  count: string;
  /** Exact decimal, or null when count is 0. Never "0". */
  mean: string | null;
  meanRounding: typeof REVIEW_MEAN_ROUNDING;
}

interface ReviewRow {
  id: string;
  purchase_id: string;
  listing_id: string;
  vendor_id: string;
  buyer_id: string;
  score: number;
  body: string | null;
  created_at: Date;
}

function toReview(row: ReviewRow): ReviewRecord {
  return {
    id: row.id,
    purchaseId: row.purchase_id,
    listingId: row.listing_id,
    vendorId: row.vendor_id,
    buyerId: row.buyer_id,
    score: row.score,
    text: row.body,
    createdAt: row.created_at.toISOString(),
  };
}

interface ReviewPublicRow {
  id: string;
  listing_id: string;
  vendor_id: string;
  score: number;
  body: string | null;
  created_at: Date;
}

function toPublicReview(row: ReviewPublicRow): ReviewPublic {
  return {
    id: row.id,
    listingId: row.listing_id,
    vendorId: row.vendor_id,
    score: row.score,
    text: row.body,
    createdAt: row.created_at.toISOString(),
  };
}

export function assertReviewsListLimit(limit: number | undefined): number {
  if (limit === undefined || typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new MarketError(MARKET_REVIEWS_LIST_LIMIT_UNSET, MARKET_REVIEWS_LIST_LIMIT_UNSET);
  }
  const n = Math.floor(limit);
  if (n < 1) throw new MarketError(MARKET_REVIEWS_LIST_LIMIT_UNSET, MARKET_REVIEWS_LIST_LIMIT_UNSET);
  return Math.min(50, n);
}

function requireClientRequestId(value: string | undefined): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed || trimmed.length > 128) {
    throw new MarketError(MARKET_CLIENT_REQUEST_ID_REQUIRED, MARKET_CLIENT_REQUEST_ID_REQUIRED);
  }
  return trimmed;
}

function cleanText(text: string | undefined): string | null {
  if (text === undefined) return null;
  if (CONTROL.test(text)) {
    throw new MarketError(MARKET_REVIEW_TEXT_INVALID, MARKET_REVIEW_TEXT_INVALID);
  }
  const trimmed = text.trim();
  if (!trimmed) return null;
  if (CONTROL.test(trimmed) || trimmed.length > 1000) {
    throw new MarketError(MARKET_REVIEW_TEXT_INVALID, MARKET_REVIEW_TEXT_INVALID);
  }
  return trimmed;
}

function requireScore(score: number): number {
  if (!Number.isInteger(score) || score < 1 || score > 5) {
    throw new MarketError(MARKET_REVIEW_SCORE_INVALID, MARKET_REVIEW_SCORE_INVALID);
  }
  return score;
}

/** Half-up at scale 18. Empty input is null, never zero. */
export function reviewMean(scores: readonly number[]): string | null {
  if (scores.length === 0) return null;
  const total = sum(scores.map((score) => parseAmount(String(score))));
  const mean = div(total, parseAmount(String(scores.length)), 'half-up');
  const rendered = formatAmount(mean);
  if (rendered === '0') {
    throw new MarketError('market.review_mean_zero', 'market.review_mean_zero');
  }
  return rendered;
}

interface ListCursor {
  createdAt: string;
  id: string;
}

function encodeListCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ v: 1, createdAt, id }), 'utf8').toString('base64url');
}

function decodeListCursor(cursor: string | undefined): ListCursor | null {
  if (cursor === undefined || cursor.trim() === '') return null;
  try {
    const raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      v?: unknown;
      createdAt?: unknown;
      id?: unknown;
    };
    if (raw.v !== 1 || typeof raw.createdAt !== 'string' || typeof raw.id !== 'string') {
      throw new MarketError(MARKET_REVIEWS_CURSOR_INVALID, MARKET_REVIEWS_CURSOR_INVALID);
    }
    return { createdAt: raw.createdAt, id: raw.id };
  } catch (err) {
    if (err instanceof MarketError) throw err;
    throw new MarketError(MARKET_REVIEWS_CURSOR_INVALID, MARKET_REVIEWS_CURSOR_INVALID);
  }
}

function sameReview(row: ReviewRow, purchaseId: string, score: number, text: string | null): boolean {
  return row.purchase_id === purchaseId && row.score === score && row.body === text;
}

export class ReviewsService {
  constructor(private readonly sql: Sql) {}

  async submit(input: {
    buyerId: string;
    purchaseId: string;
    score: number;
    text?: string | undefined;
    clientRequestId: string;
  }): Promise<ReviewRecord> {
    const clientRequestId = requireClientRequestId(input.clientRequestId);
    const score = requireScore(input.score);
    const text = cleanText(input.text);

    const [purchase] = await this.sql<Array<{ id: string; listing_id: string; vendor_id: string; buyer_id: string; status: string }>>`
      SELECT id, listing_id, vendor_id, buyer_id, status
        FROM market.purchases
       WHERE id = ${input.purchaseId}
    `;
    if (!purchase) throw new MarketError('No purchase with that id', 'market.purchase_not_found');
    if (purchase.buyer_id !== input.buyerId) {
      throw new MarketError(MARKET_REVIEW_NOT_BUYER, MARKET_REVIEW_NOT_BUYER);
    }
    if (purchase.status !== 'settled') {
      throw new MarketError(MARKET_REVIEW_NOT_SETTLED, MARKET_REVIEW_NOT_SETTLED);
    }
    // A held purchase is a verified buy only once released: still held, or refunded, it is not settled to the seller.
    const [hold] = await this.sql<Array<{ state: string }>>`
      SELECT state FROM market.purchase_holds WHERE purchase_id = ${purchase.id}
    `;
    if (hold && hold.state !== 'released') {
      throw new MarketError(MARKET_REVIEW_NOT_SETTLED, MARKET_REVIEW_NOT_SETTLED);
    }

    const [byClient] = await this.sql<ReviewRow[]>`
      SELECT * FROM market.reviews
       WHERE buyer_id = ${input.buyerId} AND client_request_id = ${clientRequestId}
    `;
    if (byClient) {
      if (!sameReview(byClient, purchase.id, score, text)) {
        throw new MarketError(MARKET_IDEMPOTENCY_CONFLICT, MARKET_IDEMPOTENCY_CONFLICT);
      }
      return toReview(byClient);
    }

    const [byPurchase] = await this.sql<ReviewRow[]>`
      SELECT * FROM market.reviews WHERE purchase_id = ${purchase.id}
    `;
    if (byPurchase) throw new MarketError(MARKET_REVIEW_EXISTS, MARKET_REVIEW_EXISTS);

    try {
      const [inserted] = await this.sql<ReviewRow[]>`
        INSERT INTO market.reviews (
          purchase_id, listing_id, vendor_id, buyer_id, score, body, client_request_id
        ) VALUES (
          ${purchase.id},
          ${purchase.listing_id},
          ${purchase.vendor_id},
          ${purchase.buyer_id},
          ${score},
          ${text},
          ${clientRequestId}
        )
        RETURNING *
      `;
      if (!inserted) throw new MarketError('Review insert returned no row', 'market.review_not_written');
      return toReview(inserted);
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? String((err as { code: unknown }).code) : '';
      if (code !== '23505') throw err;
      const [again] = await this.sql<ReviewRow[]>`
        SELECT * FROM market.reviews
         WHERE buyer_id = ${input.buyerId} AND client_request_id = ${clientRequestId}
      `;
      if (again && sameReview(again, purchase.id, score, text)) return toReview(again);
      const [held] = await this.sql<ReviewRow[]>`SELECT * FROM market.reviews WHERE purchase_id = ${purchase.id}`;
      if (held) throw new MarketError(MARKET_REVIEW_EXISTS, MARKET_REVIEW_EXISTS);
      throw new MarketError(MARKET_IDEMPOTENCY_CONFLICT, MARKET_IDEMPOTENCY_CONFLICT);
    }
  }

  async list(input: { listingId: string; limit?: number | undefined; cursor?: string | undefined }): Promise<ReviewListPage> {
    const limit = assertReviewsListLimit(input.limit);
    const cursor = decodeListCursor(input.cursor);
    const createdAt = cursor?.createdAt ?? null;
    const cursorId = cursor?.id ?? null;
    const rows = await this.sql<ReviewPublicRow[]>`
      SELECT id, listing_id, vendor_id, score, body, created_at
        FROM market.reviews
       WHERE listing_id = ${input.listingId}
         AND (
           ${createdAt}::timestamptz IS NULL
           OR (created_at, id) < (${createdAt}::timestamptz, ${cursorId}::uuid)
         )
       ORDER BY created_at DESC, id DESC
       LIMIT ${limit + 1}
    `;
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
      reviews: page.map(toPublicReview),
      nextCursor: last && rows.length > limit ? encodeListCursor(last.created_at.toISOString(), last.id) : null,
    };
  }

  async summary(vendorId: string): Promise<ReviewSummary> {
    const rows = await this.sql<Array<{ score: number }>>`
      SELECT score FROM market.reviews WHERE vendor_id = ${vendorId}
    `;
    const scores = rows.map((row) => row.score);
    return {
      vendorId,
      count: String(scores.length),
      mean: reviewMean(scores),
      meanRounding: REVIEW_MEAN_ROUNDING,
    };
  }

  /** Scores for this listing only. The query does not select a buyer or a purchase. */
  async summaryForListing(listingId: string): Promise<ListingReviewSummary> {
    const rows = await this.sql<Array<{ score: number }>>`
      SELECT score FROM market.reviews WHERE listing_id = ${listingId}
    `;
    const scores = rows.map((row) => row.score);
    return {
      count: String(scores.length),
      mean: reviewMean(scores),
      meanRounding: REVIEW_MEAN_ROUNDING,
    };
  }
}
