import { randomUUID } from 'node:crypto';
import type {
  LibraryRepository,
  StoredAccess,
  StoredClone,
  StoredDispute,
  StoredListing,
  StoredModeration,
  StoredReview,
} from './repository.js';

/** The in-memory library unit tests use. Production runs on Postgres (library.pg.test.ts). */
export function createMemoryLibraryRepository(): LibraryRepository {
  const listings: StoredListing[] = [];
  const access: StoredAccess[] = [];
  const clones: StoredClone[] = [];
  const reviews: StoredReview[] = [];
  const moderation: StoredModeration[] = [];
  const disputes: StoredDispute[] = [];
  return {
    async publish(input) {
      const prior = listings.find((row) => row.ownerId === input.ownerId && row.key === input.key);
      if (prior) return prior;
      const { at, ...rest } = input;
      const row: StoredListing = { ...rest, tags: [...rest.tags], id: randomUUID(), seq: listings.length + 1, listedAt: at.toISOString() };
      listings.push(row);
      return row;
    },
    async listing(id) {
      return listings.find((row) => row.id === id) ?? null;
    },
    async listingsOf(ownerId) {
      return listings.filter((row) => row.ownerId === ownerId);
    },
    async browse({ tag, afterSeq, limit }) {
      return listings
        .filter((row) => row.visibility !== 'invite' && row.seq > afterSeq && (tag === null || row.tags.includes(tag)))
        .slice(0, limit);
    },
    async access(listingId) {
      return access.filter((row) => row.listingId === listingId);
    },
    async addAccess(input) {
      const prior = access.find(
        (row) => row.listingId === input.listingId && row.userId === input.userId && row.action === input.action && row.seq === input.seq,
      );
      if (prior) return prior;
      const { at, ...rest } = input;
      const row = { ...rest, at: at.toISOString() };
      access.push(row);
      return row;
    },
    async recordClone(input) {
      const prior = clones.find((row) => row.strategyId === input.strategyId);
      if (prior) return prior;
      const { at, ...rest } = input;
      const row = { ...rest, clonedAt: at.toISOString() };
      clones.push(row);
      return row;
    },
    async lineage(strategyId) {
      return clones.find((row) => row.strategyId === strategyId) ?? null;
    },
    async cloneOf({ listingId, accountId }) {
      return clones.find((row) => row.listingId === listingId && row.accountId === accountId) ?? null;
    },
    async addReview(input) {
      const prior = reviews.find((row) => row.listingId === input.listingId && row.reviewerId === input.reviewerId);
      if (prior) return prior;
      const { at, ...rest } = input;
      const row = { ...rest, createdAt: at.toISOString() };
      reviews.push(row);
      return row;
    },
    async reviews(listingId) {
      return reviews.filter((row) => row.listingId === listingId);
    },
    async queue({ afterSeq, limit }) {
      return listings.filter((row) => row.seq > afterSeq).slice(0, limit);
    },
    async moderation(listingId) {
      return moderation.filter((row) => row.listingId === listingId);
    },
    async moderationOf(listingIds) {
      return moderation.filter((row) => listingIds.includes(row.listingId));
    },
    async moderate(input) {
      const prior = moderation.find((row) => row.listingId === input.listingId && row.seq === input.seq);
      if (prior) return prior;
      const { at, ...rest } = input;
      const row = { ...rest, at: at.toISOString() };
      moderation.push(row);
      return row;
    },
    async openDispute(input) {
      const prior = disputes.find((row) => row.listingId === input.listingId && row.seq === input.seq);
      if (prior) return prior;
      const { at, ...rest } = input;
      const row: StoredDispute = { ...rest, id: randomUUID(), openedAt: at.toISOString(), resolution: null };
      disputes.push(row);
      return row;
    },
    async dispute(id) {
      return disputes.find((row) => row.id === id) ?? null;
    },
    async disputes(listingIds) {
      return disputes.filter((row) => listingIds.includes(row.listingId));
    },
    async resolveDispute({ id, actor, reason, at }) {
      const index = disputes.findIndex((row) => row.id === id);
      const prior = disputes[index]!;
      if (prior.resolution) return prior;
      const row = { ...prior, resolution: { actor, reason, at: at.toISOString() } };
      disputes[index] = row;
      return row;
    },
  };
}
