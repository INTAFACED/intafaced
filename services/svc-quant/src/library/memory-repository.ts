import { randomUUID } from 'node:crypto';
import type { LibraryRepository, StoredAccess, StoredClone, StoredListing, StoredReview } from './repository.js';

/** The in-memory library unit tests use. Production runs on Postgres (library.pg.test.ts). */
export function createMemoryLibraryRepository(): LibraryRepository {
  const listings: StoredListing[] = [];
  const access: StoredAccess[] = [];
  const clones: StoredClone[] = [];
  const reviews: StoredReview[] = [];
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
  };
}
