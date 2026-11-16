import { randomUUID } from 'node:crypto';
import type { QuantLibraryTag, QuantListingVisibility } from '@intafaced/contracts';
import type { Sql } from 'postgres';
import { QuantError } from '../errors.js';
import type { QuantModerationAction } from '@intafaced/contracts';
import type {
  AccessAction,
  LibraryRepository,
  StoredAccess,
  StoredClone,
  StoredDispute,
  StoredListing,
  StoredModeration,
  StoredReview,
} from './repository.js';

function relation(schema: string, table: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(schema) || !/^[a-z_]+$/.test(table)) throw new Error(`refusing sql identifier ${schema}.${table}`);
  return `"${schema}"."${table}"`;
}

function iso(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new QuantError('quant.params_invalid', 'timestamp is not readable');
  return date.toISOString();
}

interface ListingSql {
  id: string;
  seq: string | number;
  owner_id: string;
  write_key: string;
  strategy_id: string;
  strategy_version: number;
  run_id: string;
  title: string;
  description: string;
  tags: string[];
  visibility: QuantListingVisibility;
  licence: string;
  checklist_version: string;
  listed_at: Date | string;
}
interface AccessSql {
  listing_id: string;
  user_id: string;
  action: AccessAction;
  seq: number;
  actor: string;
  at: Date | string;
}
interface CloneSql {
  strategy_id: string;
  account_id: string;
  listing_id: string;
  source_version: number;
  cloned_at: Date | string;
}
interface ReviewSql {
  listing_id: string;
  reviewer_id: string;
  text: string;
  created_at: Date | string;
}

const listingOf = (row: ListingSql): StoredListing => ({
  id: row.id,
  seq: Number(row.seq),
  key: row.write_key,
  ownerId: row.owner_id,
  strategyId: row.strategy_id,
  strategyVersion: row.strategy_version,
  runId: row.run_id,
  title: row.title,
  description: row.description,
  tags: row.tags as QuantLibraryTag[],
  visibility: row.visibility,
  licence: row.licence,
  checklistVersion: row.checklist_version,
  listedAt: iso(row.listed_at),
});
const accessOf = (row: AccessSql): StoredAccess => ({
  listingId: row.listing_id,
  userId: row.user_id,
  action: row.action,
  seq: row.seq,
  actor: row.actor,
  at: iso(row.at),
});
const cloneOf = (row: CloneSql): StoredClone => ({
  strategyId: row.strategy_id,
  accountId: row.account_id,
  listingId: row.listing_id,
  sourceVersion: row.source_version,
  clonedAt: iso(row.cloned_at),
});
const reviewOf = (row: ReviewSql): StoredReview => ({
  listingId: row.listing_id,
  reviewerId: row.reviewer_id,
  text: row.text,
  createdAt: iso(row.created_at),
});

interface ModerationSql {
  listing_id: string;
  seq: number;
  action: QuantModerationAction;
  actor: string;
  reason: string;
  at: Date | string;
}
interface DisputeSql {
  id: string;
  listing_id: string;
  seq: number;
  opened_by: string;
  reason: string;
  ticket_ref: string;
  opened_at: Date | string;
  resolved_by: string | null;
  resolved_reason: string | null;
  resolved_at: Date | string | null;
}
const moderationOf = (row: ModerationSql): StoredModeration => ({
  listingId: row.listing_id,
  seq: row.seq,
  action: row.action,
  actor: row.actor,
  reason: row.reason,
  at: iso(row.at),
});
const disputeOf = (row: DisputeSql): StoredDispute => ({
  id: row.id,
  listingId: row.listing_id,
  seq: row.seq,
  openedBy: row.opened_by,
  reason: row.reason,
  ticketRef: row.ticket_ref,
  openedAt: iso(row.opened_at),
  resolution:
    row.resolved_by !== null && row.resolved_at !== null
      ? { actor: row.resolved_by, reason: row.resolved_reason ?? '', at: iso(row.resolved_at) }
      : null,
});

/** The strategy library in the service's own schema (J-algo-dev-09). */
export function createPostgresLibraryRepository(sql: Sql, schema = 'quant'): LibraryRepository {
  const listings = relation(schema, 'library_listings');
  const access = relation(schema, 'library_access');
  const clones = relation(schema, 'library_clones');
  const reviews = relation(schema, 'library_reviews');
  const moderation = relation(schema, 'library_moderation');
  const disputes = relation(schema, 'library_disputes');
  const resolutions = relation(schema, 'library_dispute_resolutions');
  const MODERATION = 'listing_id, seq, action, actor, reason, at';
  const DISPUTE = `d.id, d.listing_id, d.seq, d.opened_by, d.reason, d.ticket_ref, d.opened_at,
    r.actor AS resolved_by, r.reason AS resolved_reason, r.at AS resolved_at`;
  const DISPUTES = `${disputes} d LEFT JOIN ${resolutions} r ON r.dispute_id = d.id`;
  const query = <T>(text: string, params: readonly unknown[]): Promise<T[]> => sql.unsafe(text, params as never[]);
  const LISTING =
    'id, seq, owner_id, write_key, strategy_id, strategy_version, run_id, title, description, tags, visibility, licence, checklist_version, listed_at';
  const ACCESS = 'listing_id, user_id, action, seq, actor, at';
  const CLONE = 'strategy_id, account_id, listing_id, source_version, cloned_at';
  const REVIEW = 'listing_id, reviewer_id, text, created_at';
  return {
    async publish(input) {
      await query(
        `INSERT INTO ${listings} (id, owner_id, write_key, strategy_id, strategy_version, run_id, title, description, tags, visibility, licence, checklist_version, listed_at)
         VALUES ($1, $2::uuid, $3, $4, $5, $6, $7, $8, $9::text[], $10, $11, $12, $13)
         ON CONFLICT (owner_id, write_key) DO NOTHING`,
        [
          randomUUID(),
          input.ownerId,
          input.key,
          input.strategyId,
          input.strategyVersion,
          input.runId,
          input.title,
          input.description,
          [...input.tags],
          input.visibility,
          input.licence,
          input.checklistVersion,
          input.at.toISOString(),
        ],
      );
      const rows = await query<ListingSql>(`SELECT ${LISTING} FROM ${listings} WHERE owner_id = $1::uuid AND write_key = $2`, [
        input.ownerId,
        input.key,
      ]);
      return listingOf(rows[0]!);
    },
    async listing(id) {
      const rows = await query<ListingSql>(`SELECT ${LISTING} FROM ${listings} WHERE id = $1`, [id]);
      return rows[0] ? listingOf(rows[0]) : null;
    },
    async listingsOf(ownerId) {
      const rows = await query<ListingSql>(`SELECT ${LISTING} FROM ${listings} WHERE owner_id = $1::uuid ORDER BY seq`, [ownerId]);
      return rows.map(listingOf);
    },
    async browse({ tag, afterSeq, limit }) {
      const rows = await query<ListingSql>(
        `SELECT ${LISTING} FROM ${listings}
          WHERE visibility IN ('open', 'protected') AND seq > $1 AND ($2::text IS NULL OR $2::text = ANY(tags))
          ORDER BY seq LIMIT $3`,
        [afterSeq, tag, limit],
      );
      return rows.map(listingOf);
    },
    async access(listingId) {
      const rows = await query<AccessSql>(`SELECT ${ACCESS} FROM ${access} WHERE listing_id = $1 ORDER BY row_id`, [listingId]);
      return rows.map(accessOf);
    },
    async addAccess(input) {
      await query(
        `INSERT INTO ${access} (listing_id, user_id, action, seq, actor, at) VALUES ($1, $2::uuid, $3, $4, $5::uuid, $6)
         ON CONFLICT (listing_id, user_id, action, seq) DO NOTHING`,
        [input.listingId, input.userId, input.action, input.seq, input.actor, input.at.toISOString()],
      );
      const rows = await query<AccessSql>(
        `SELECT ${ACCESS} FROM ${access} WHERE listing_id = $1 AND user_id = $2::uuid AND action = $3 AND seq = $4`,
        [input.listingId, input.userId, input.action, input.seq],
      );
      return accessOf(rows[0]!);
    },
    async recordClone(input) {
      await query(
        `INSERT INTO ${clones} (strategy_id, account_id, listing_id, source_version, cloned_at) VALUES ($1, $2::uuid, $3, $4, $5)
         ON CONFLICT (strategy_id) DO NOTHING`,
        [input.strategyId, input.accountId, input.listingId, input.sourceVersion, input.at.toISOString()],
      );
      const rows = await query<CloneSql>(`SELECT ${CLONE} FROM ${clones} WHERE strategy_id = $1`, [input.strategyId]);
      return cloneOf(rows[0]!);
    },
    async lineage(strategyId) {
      const rows = await query<CloneSql>(`SELECT ${CLONE} FROM ${clones} WHERE strategy_id = $1`, [strategyId]);
      return rows[0] ? cloneOf(rows[0]) : null;
    },
    async cloneOf({ listingId, accountId }) {
      const rows = await query<CloneSql>(
        `SELECT ${CLONE} FROM ${clones} WHERE listing_id = $1 AND account_id = $2::uuid ORDER BY cloned_at LIMIT 1`,
        [listingId, accountId],
      );
      return rows[0] ? cloneOf(rows[0]) : null;
    },
    async addReview(input) {
      await query(
        `INSERT INTO ${reviews} (listing_id, reviewer_id, text, created_at) VALUES ($1, $2::uuid, $3, $4)
         ON CONFLICT (listing_id, reviewer_id) DO NOTHING`,
        [input.listingId, input.reviewerId, input.text, input.at.toISOString()],
      );
      const rows = await query<ReviewSql>(`SELECT ${REVIEW} FROM ${reviews} WHERE listing_id = $1 AND reviewer_id = $2::uuid`, [
        input.listingId,
        input.reviewerId,
      ]);
      return reviewOf(rows[0]!);
    },
    async reviews(listingId) {
      const rows = await query<ReviewSql>(`SELECT ${REVIEW} FROM ${reviews} WHERE listing_id = $1 ORDER BY created_at, reviewer_id`, [
        listingId,
      ]);
      return rows.map(reviewOf);
    },
    async queue({ afterSeq, limit }) {
      const rows = await query<ListingSql>(`SELECT ${LISTING} FROM ${listings} WHERE seq > $1 ORDER BY seq LIMIT $2`, [afterSeq, limit]);
      return rows.map(listingOf);
    },
    async moderation(listingId) {
      const rows = await query<ModerationSql>(`SELECT ${MODERATION} FROM ${moderation} WHERE listing_id = $1 ORDER BY row_id`, [listingId]);
      return rows.map(moderationOf);
    },
    async moderationOf(listingIds) {
      if (!listingIds.length) return [];
      const rows = await query<ModerationSql>(
        `SELECT ${MODERATION} FROM ${moderation} WHERE listing_id = ANY($1::text[]) ORDER BY row_id`,
        [[...listingIds]],
      );
      return rows.map(moderationOf);
    },
    async moderate(input) {
      await query(
        `INSERT INTO ${moderation} (listing_id, seq, action, actor, reason, at) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (listing_id, seq) DO NOTHING`,
        [input.listingId, input.seq, input.action, input.actor, input.reason, input.at.toISOString()],
      );
      const rows = await query<ModerationSql>(`SELECT ${MODERATION} FROM ${moderation} WHERE listing_id = $1 AND seq = $2`, [
        input.listingId,
        input.seq,
      ]);
      return moderationOf(rows[0]!);
    },
    async openDispute(input) {
      await query(
        `INSERT INTO ${disputes} (id, listing_id, seq, opened_by, reason, ticket_ref, opened_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (listing_id, seq) DO NOTHING`,
        [randomUUID(), input.listingId, input.seq, input.openedBy, input.reason, input.ticketRef, input.at.toISOString()],
      );
      const rows = await query<DisputeSql>(`SELECT ${DISPUTE} FROM ${DISPUTES} WHERE d.listing_id = $1 AND d.seq = $2`, [
        input.listingId,
        input.seq,
      ]);
      return disputeOf(rows[0]!);
    },
    async dispute(id) {
      const rows = await query<DisputeSql>(`SELECT ${DISPUTE} FROM ${DISPUTES} WHERE d.id = $1`, [id]);
      return rows[0] ? disputeOf(rows[0]) : null;
    },
    async disputes(listingIds) {
      if (!listingIds.length) return [];
      const rows = await query<DisputeSql>(`SELECT ${DISPUTE} FROM ${DISPUTES} WHERE d.listing_id = ANY($1::text[]) ORDER BY d.row_id`, [
        [...listingIds],
      ]);
      return rows.map(disputeOf);
    },
    async resolveDispute({ id, actor, reason, at }) {
      await query(
        `INSERT INTO ${resolutions} (dispute_id, actor, reason, at) VALUES ($1, $2, $3, $4) ON CONFLICT (dispute_id) DO NOTHING`,
        [id, actor, reason, at.toISOString()],
      );
      const rows = await query<DisputeSql>(`SELECT ${DISPUTE} FROM ${DISPUTES} WHERE d.id = $1`, [id]);
      return disputeOf(rows[0]!);
    },
  };
}
