import type { QuantLibraryTag, QuantListingVisibility, QuantModerationAction, QuantModerationState } from '@intafaced/contracts';

/** One published version of a strategy (AL-library-01). Never rewritten: a newer version is a new listing. */
export interface StoredListing {
  readonly id: string;
  /** Registration order: the library lists by it, oldest first. */
  readonly seq: number;
  readonly key: string;
  readonly ownerId: string;
  readonly strategyId: string;
  readonly strategyVersion: number;
  /** The stored backtest of this version the publish check relied on. */
  readonly runId: string;
  readonly title: string;
  readonly description: string;
  readonly tags: readonly QuantLibraryTag[];
  readonly visibility: QuantListingVisibility;
  readonly licence: string;
  readonly checklistVersion: string;
  readonly listedAt: string;
}

export type AccessAction = 'request' | 'grant' | 'revoke';

/** One access write on an invite-only listing. Insert-only; the newest row per person is their access. */
export interface StoredAccess {
  readonly listingId: string;
  readonly userId: string;
  readonly action: AccessAction;
  readonly seq: number;
  readonly actor: string;
  readonly at: string;
}

/** Where a clone came from (AL-library-02). */
export interface StoredClone {
  readonly strategyId: string;
  readonly accountId: string;
  readonly listingId: string;
  readonly sourceVersion: number;
  readonly clonedAt: string;
}

export interface StoredReview {
  readonly listingId: string;
  readonly reviewerId: string;
  readonly text: string;
  readonly createdAt: string;
}

/** One operator moderation action on a listing (AL-library-03): the audit row itself, insert-only. */
export interface StoredModeration {
  readonly listingId: string;
  /** The audit rows on this listing before this one: with the listing, the action's business key. */
  readonly seq: number;
  readonly action: QuantModerationAction;
  readonly actor: string;
  readonly reason: string;
  readonly at: string;
}

/** One dispute on a listing, with its resolution once an operator resolved it. Both rows are insert-only. */
export interface StoredDispute {
  readonly id: string;
  readonly listingId: string;
  readonly seq: number;
  readonly openedBy: string;
  readonly reason: string;
  readonly ticketRef: string;
  readonly openedAt: string;
  readonly resolution: { readonly actor: string; readonly reason: string; readonly at: string } | null;
}

/** The state the newest moderation row leaves a listing in; with none it is listed. */
export function moderationState(rows: readonly StoredModeration[]): QuantModerationState {
  const newest = rows.at(-1);
  if (!newest) return 'listed';
  return newest.action === 'hide' ? 'hidden' : newest.action === 'remove' ? 'removed' : 'listed';
}

/** The strategy library: listings, invite-only access, clone lineage and reviews. Holds no balance. */
export interface LibraryRepository {
  /** Stores a listing under its business key; the same key returns the listing first stored under it. */
  publish(input: Omit<StoredListing, 'id' | 'seq' | 'listedAt'> & { readonly at: Date }): Promise<StoredListing>;
  listing(id: string): Promise<StoredListing | null>;
  /** One owner's listings, oldest first. */
  listingsOf(ownerId: string): Promise<readonly StoredListing[]>;
  /** Open and protected listings after `afterSeq`, oldest first, of one tag when given. */
  browse(input: {
    readonly tag: QuantLibraryTag | null;
    readonly afterSeq: number;
    readonly limit: number;
  }): Promise<readonly StoredListing[]>;
  /** A listing's access rows, oldest first. */
  access(listingId: string): Promise<readonly StoredAccess[]>;
  /** Writes one access row under (listing, person, action, seq); the same four return the row first written. */
  addAccess(input: Omit<StoredAccess, 'at'> & { readonly at: Date }): Promise<StoredAccess>;
  /** Records a clone once per new strategy. */
  recordClone(input: Omit<StoredClone, 'clonedAt'> & { readonly at: Date }): Promise<StoredClone>;
  lineage(strategyId: string): Promise<StoredClone | null>;
  /** The caller's clone of a listing, if any. */
  cloneOf(input: { readonly listingId: string; readonly accountId: string }): Promise<StoredClone | null>;
  /** One review per person per listing; a second returns the first. */
  addReview(input: Omit<StoredReview, 'createdAt'> & { readonly at: Date }): Promise<StoredReview>;
  /** A listing's reviews, oldest first. */
  reviews(listingId: string): Promise<readonly StoredReview[]>;
  /** Every listing after `afterSeq`, any visibility or state, oldest first: the moderation queue. */
  queue(input: { readonly afterSeq: number; readonly limit: number }): Promise<readonly StoredListing[]>;
  /** A listing's moderation rows, oldest first. */
  moderation(listingId: string): Promise<readonly StoredModeration[]>;
  /** Moderation rows of many listings at once, oldest first. */
  moderationOf(listingIds: readonly string[]): Promise<readonly StoredModeration[]>;
  /** Writes one moderation row under (listing, seq); the same pair returns the row first written. */
  moderate(input: Omit<StoredModeration, 'at'> & { readonly at: Date }): Promise<StoredModeration>;
  /** Opens one dispute under (listing, seq); the same pair returns the dispute first opened. */
  openDispute(input: Omit<StoredDispute, 'id' | 'openedAt' | 'resolution'> & { readonly at: Date }): Promise<StoredDispute>;
  dispute(id: string): Promise<StoredDispute | null>;
  /** A listing's disputes, oldest first. */
  disputes(listingIds: readonly string[]): Promise<readonly StoredDispute[]>;
  /** Resolves a dispute once; a second resolution returns the first. */
  resolveDispute(input: {
    readonly id: string;
    readonly actor: string;
    readonly reason: string;
    readonly at: Date;
  }): Promise<StoredDispute>;
}

/** The newest access row of each person, oldest person first, with how many rows each has. */
export function accessState(rows: readonly StoredAccess[]): { row: StoredAccess; count: number }[] {
  const per = new Map<string, { row: StoredAccess; count: number }>();
  for (const row of rows) {
    const prior = per.get(row.userId);
    per.set(row.userId, { row, count: (prior?.count ?? 0) + 1 });
  }
  return [...per.values()];
}
