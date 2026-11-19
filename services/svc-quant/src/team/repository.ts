import type { QuantTeamRole } from '@intafaced/contracts';

/** One teammate on one strategy (AL-team-01). The owner is never a collaborator of their own strategy. */
export interface StoredCollaborator {
  readonly strategyId: string;
  readonly ownerId: string;
  readonly memberId: string;
  readonly role: QuantTeamRole;
  readonly liveControl: boolean;
  readonly addedAt: string;
  readonly updatedAt: string;
}

/** The strategy's one edit lock. It lapses at `expiresAt`; a lapsed row is the same as none. */
export interface StoredLock {
  readonly strategyId: string;
  readonly holderId: string;
  readonly takenAt: string;
  readonly expiresAt: string;
}

/** The owner's time-boxed grant: support may read the source until `expiresAt`. Insert-only. */
export interface StoredGrant {
  readonly id: string;
  readonly strategyId: string;
  readonly ownerId: string;
  readonly key: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

/** One support read of a strategy, granted or not. Insert-only. */
export interface StoredRead {
  readonly strategyId: string;
  readonly grantId: string | null;
  readonly reader: string;
  readonly granted: boolean;
  readonly readAt: string;
}

export type LockAttempt = { readonly taken: true; readonly lock: StoredLock } | { readonly taken: false; readonly lock: StoredLock };

/** Strategy teams, edit locks and support grants (J-algo-dev-08). Holds no balance. */
export interface TeamRepository {
  /** A strategy's collaborators, oldest first. */
  collaborators(strategyId: string): Promise<readonly StoredCollaborator[]>;
  membership(input: { readonly strategyId: string; readonly memberId: string }): Promise<StoredCollaborator | null>;
  /** Every strategy shared with one person, oldest first. */
  sharedWith(memberId: string): Promise<readonly StoredCollaborator[]>;
  /**
   * Adds a collaborator or changes one's permission. A new one counts against the owner's plan (`collaborators` per
   * strategy, AL-limits-01), checked in the same transaction as the insert; a change of permission adds nothing.
   */
  upsert(input: {
    readonly strategyId: string;
    readonly ownerId: string;
    readonly memberId: string;
    readonly role: QuantTeamRole;
    readonly liveControl: boolean;
    readonly at: Date;
  }): Promise<StoredCollaborator>;
  /** Removes a collaborator and any lock they hold. Removing one who is not there changes nothing. */
  remove(input: { readonly strategyId: string; readonly memberId: string }): Promise<void>;
  /** The most collaborators any one of the owner's strategies has. */
  mostCollaborators(ownerId: string): Promise<bigint>;
  lock(strategyId: string): Promise<StoredLock | null>;
  /** Takes or renews the lock for `holderId`; refused (taken: false) while another person's lock has not lapsed. */
  takeLock(input: {
    readonly strategyId: string;
    readonly holderId: string;
    readonly at: Date;
    readonly ttlMs: number;
  }): Promise<LockAttempt>;
  /** Lets the lock go if `holderId` holds it. */
  releaseLock(input: { readonly strategyId: string; readonly holderId: string }): Promise<void>;
  /** The strategy's grants, newest first. */
  grants(strategyId: string): Promise<readonly StoredGrant[]>;
  /** Stores one grant under its key; the same key returns the grant first stored under it. */
  createGrant(input: {
    readonly strategyId: string;
    readonly ownerId: string;
    readonly key: string;
    readonly at: Date;
    readonly seconds: number;
  }): Promise<StoredGrant>;
  /** Writes one audit row for a support read at `at`, under the grant active then (if any), and returns that grant. */
  recordRead(input: { readonly strategyId: string; readonly reader: string; readonly at: Date }): Promise<StoredGrant | null>;
  /** The strategy's support reads, oldest first. */
  reads(strategyId: string): Promise<readonly StoredRead[]>;
}

export const lockLive = (lock: StoredLock | null, at: Date): lock is StoredLock =>
  lock !== null && Date.parse(lock.expiresAt) > at.getTime();
export const grantActive = (grant: StoredGrant, at: Date): boolean =>
  Date.parse(grant.createdAt) <= at.getTime() && Date.parse(grant.expiresAt) > at.getTime();
