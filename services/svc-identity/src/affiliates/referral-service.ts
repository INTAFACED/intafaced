import type { Sql } from 'postgres';
import { transaction } from '@intafaced/db';
import {
  buildAffiliateMemberListBoard,
  buildAffiliateNodeStatus,
  buildAffiliateTreeBoard,
  listAffiliateTreeMembers,
  type AffiliateMemberListBoard,
  type AffiliateNodeStatus,
  type AffiliateTreeBoard,
  type AffiliateTreeMember,
} from './admin-tree-read.js';
import {
  DEFAULT_MAX_REFERRAL_DEPTH,
  ReferralError,
  ancestors,
  chainDepth,
  chainHasCycle,
  wouldCreateCycle,
  type ReferralEdge,
} from './referral-tree.js';
import { assertAttachWindowOpen } from './attach-window.js';

/**
 * Durable referral tree (Slice A) — attribution only, no commission/payout.
 * Stage admin read: treeBoard / nodeStatus / listMembers (structure + freeze overlay).
 *
 * Graph mutations take a transaction-scoped advisory lock so concurrent
 * mutual referrals cannot both pass the cycle check and both insert (TOCTOU).
 */

/** pg_advisory_xact_lock classid — fixed namespace for referral_edges mutations. */
export const REFERRAL_GRAPH_LOCK_CLASS = 87201401;
/** pg_advisory_xact_lock objid — single graph mutex (attribution volume is low). */
export const REFERRAL_GRAPH_LOCK_OBJ = 1;

/** Blank / non-integer / out of 1..500 affiliates.members window. Never invent 100. */
export const IDENTITY_AFFILIATE_MEMBERS_LIMIT_UNSET = 'identity.affiliate_members_limit_unset' as const;
export const AFFILIATE_MEMBERS_LIMIT_MAX = 500;

export class AffiliateMembersLimitUnsetError extends Error {
  constructor(
    message: string,
    readonly code: typeof IDENTITY_AFFILIATE_MEMBERS_LIMIT_UNSET,
  ) {
    super(message);
    this.name = 'AffiliateMembersLimitUnsetError';
  }
}

/** Owner-published member roster window. Missing / null / non-int / out of 1..max refuses. Never invent 100. */
export function publishedAffiliateMembersLimit(value: number | undefined | null): number {
  if (value === undefined || value === null || !Number.isInteger(value) || value < 1 || value > AFFILIATE_MEMBERS_LIMIT_MAX) {
    throw new AffiliateMembersLimitUnsetError(
      'Affiliate members limit is unset — refuse to invent 100',
      IDENTITY_AFFILIATE_MEMBERS_LIMIT_UNSET,
    );
  }
  return value;
}

export class ReferralService {
  constructor(
    private readonly sql: Sql,
    private readonly maxDepth: number = DEFAULT_MAX_REFERRAL_DEPTH,
  ) {}

  /** Parent map for accrual dry-run (userId → referrerId). */
  async loadParentMap(): Promise<Map<string, string>> {
    return this.loadParentMapFrom(this.sql);
  }

  private async loadParentMapFrom(sql: Sql): Promise<Map<string, string>> {
    const rows = await sql<Array<{ user_id: string; referrer_id: string }>>`
      SELECT user_id, referrer_id FROM referral_edges
    `;
    return new Map(rows.map((r) => [r.user_id, r.referrer_id]));
  }

  /** Attributed-at map for admin node cards. */
  async loadAttributedAtMap(): Promise<Map<string, Date>> {
    const rows = await this.sql<Array<{ user_id: string; attributed_at: Date }>>`
      SELECT user_id, attributed_at FROM referral_edges
    `;
    return new Map(rows.map((r) => [r.user_id, r.attributed_at]));
  }

  /**
   * Admin tree board — structure only (no rates / payouts).
   * Optional frozenIds overlay from FreezeService.
   */
  async treeBoard(frozenIds?: ReadonlySet<string>): Promise<AffiliateTreeBoard> {
    const parent = await this.loadParentMap();
    return buildAffiliateTreeBoard({
      parent,
      frozenIds,
      maxDepthCap: this.maxDepth,
    });
  }

  /**
   * Admin node status — parent, depth, ancestors, hop-0 downline, freeze flag.
   */
  async nodeStatus(userId: string, frozenIds?: ReadonlySet<string>): Promise<AffiliateNodeStatus> {
    const parent = await this.loadParentMap();
    const attributedAt = await this.loadAttributedAtMap();
    return buildAffiliateNodeStatus({
      userId,
      parent,
      attributedAt,
      frozenIds,
      maxDepth: this.maxDepth,
    });
  }

  /**
   * Stage-2 admin member roster — attributed edges (+ optional root filter).
   * Structure + freeze only; no rates / payouts.
   * Limit required — omit never invents 100. Owner/query may pass 100 explicitly.
   * Returned `members` is the page; board totals stay the untruncated roster.
   */
  async listMembers(
    frozenIds: ReadonlySet<string> | undefined,
    rootId: string | null | undefined,
    limit: number,
  ): Promise<{ readonly members: readonly AffiliateTreeMember[]; readonly board: AffiliateMemberListBoard }> {
    const published = publishedAffiliateMembersLimit(limit);
    const parent = await this.loadParentMap();
    const attributedAt = await this.loadAttributedAtMap();
    const all = listAffiliateTreeMembers({
      parent,
      attributedAt,
      frozenIds,
      rootId,
      maxDepth: this.maxDepth,
    });
    return {
      members: all.slice(0, published),
      board: buildAffiliateMemberListBoard(all, rootId ?? null),
    };
  }

  private async userExists(sql: Sql, userId: string): Promise<boolean> {
    const rows = await sql<Array<{ id: string }>>`
      SELECT id FROM users WHERE id = ${userId} LIMIT 1
    `;
    return rows.length > 0;
  }

  /**
   * Attribute once under a graph mutex.
   *
   * Without a transaction lock, two concurrent mutual referrals (A→B and B→A)
   * can both load an empty parent map, both pass wouldCreateCycle, and both
   * insert — bricking the tree. We:
   *   1. begin txn + advisory xact lock (serialise all graph writes)
   *   2. re-load parent map
   *   3. cycle / depth / already-set checks
   *   4. insert
   *   5. post-insert chainHasCycle recheck (rollback on failure)
   */
  async attribute(
    input: { userId: string; referrerId: string },
    /** Set for a link attach after sign-up (CM-referral-01): the owner window, blank refusing. Sign-up completion omits it. */
    late?: { readonly windowSeconds: number | undefined },
  ): Promise<ReferralEdge> {
    const userId = input.userId.trim();
    const referrerId = input.referrerId.trim();
    if (!userId || !referrerId) {
      throw new ReferralError('userId and referrerId are required', 'referral.invalid');
    }
    if (userId === referrerId) {
      throw new ReferralError('Self-referral is refused', 'referral.self');
    }

    try {
      return await transaction(
        this.sql,
        async (tx) => {
          // Transaction-scoped: released on commit/rollback. Serialises attribute writers.
          await tx`SELECT pg_advisory_xact_lock(${REFERRAL_GRAPH_LOCK_CLASS}, ${REFERRAL_GRAPH_LOCK_OBJ})`;

          if (!(await this.userExists(tx, userId)) || !(await this.userExists(tx, referrerId))) {
            throw new ReferralError('Referrer is not a known user', 'referral.unknown_referrer');
          }

          const parent = await this.loadParentMapFrom(tx);
          if (parent.has(userId)) {
            throw new ReferralError('Referral already set for this user', 'referral.already_set');
          }
          if (late) {
            // Both instants from the database, so the app host's clock cannot move the window edge.
            const [row] = await tx<Array<{ created_at: Date; now: Date }>>`SELECT created_at, now() AS now FROM users WHERE id = ${userId}`;
            if (!row) throw new ReferralError('Referrer is not a known user', 'referral.unknown_referrer');
            assertAttachWindowOpen(row.created_at, late.windowSeconds, row.now);
          }
          if (wouldCreateCycle(parent, userId, referrerId)) {
            throw new ReferralError('Referral would create a cycle', 'referral.cycle');
          }
          const referrerDepth = chainDepth(parent, referrerId);
          if (referrerDepth + 1 > this.maxDepth) {
            throw new ReferralError(
              `Referral depth exceeds max ${this.maxDepth} (referrer chain is already ${referrerDepth})`,
              'referral.depth',
            );
          }

          const rows = await tx<Array<{ user_id: string; referrer_id: string; attributed_at: Date }>>`
            INSERT INTO referral_edges (user_id, referrer_id, attributed_at)
            VALUES (${userId}, ${referrerId}, now())
            RETURNING user_id, referrer_id, attributed_at
          `;

          // Post-insert integrity: if a race ever bypassed the lock, refuse and roll back.
          const after = await this.loadParentMapFrom(tx);
          if (chainHasCycle(after, userId)) {
            throw new ReferralError('Referral would create a cycle', 'referral.cycle');
          }

          return {
            userId: rows[0]!.user_id,
            referrerId: rows[0]!.referrer_id,
            attributedAt: rows[0]!.attributed_at,
          };
        },
        {
          // Advisory lock already orders writers; READ COMMITTED avoids serializable aborts.
          isolation: 'read committed',
          maxAttempts: 10,
        },
      );
    } catch (err) {
      if (err instanceof ReferralError) throw err;
      const code = (err as { code?: string } | null)?.code;
      if (code === '23505') {
        throw new ReferralError('Referral already set for this user', 'referral.already_set');
      }
      throw err;
    }
  }

  async parentOf(userId: string): Promise<string | null> {
    const rows = await this.sql<Array<{ referrer_id: string }>>`
      SELECT referrer_id FROM referral_edges WHERE user_id = ${userId}
    `;
    return rows[0]?.referrer_id ?? null;
  }

  async edgeOf(userId: string): Promise<ReferralEdge | null> {
    const rows = await this.sql<Array<{ user_id: string; referrer_id: string; attributed_at: Date }>>`
      SELECT user_id, referrer_id, attributed_at FROM referral_edges WHERE user_id = ${userId}
    `;
    if (!rows[0]) return null;
    return {
      userId: rows[0].user_id,
      referrerId: rows[0].referrer_id,
      attributedAt: rows[0].attributed_at,
    };
  }

  /** When the account was made and the database's now, for the attach-window read; null for an unknown account. */
  async accountAge(userId: string): Promise<{ createdAt: Date; now: Date } | null> {
    const rows = await this.sql<Array<{ created_at: Date; now: Date }>>`SELECT created_at, now() AS now FROM users WHERE id = ${userId}`;
    return rows[0] ? { createdAt: rows[0].created_at, now: rows[0].now } : null;
  }

  async ancestorsOf(userId: string): Promise<string[]> {
    const parent = await this.loadParentMap();
    return ancestors(parent, userId, this.maxDepth);
  }
}
