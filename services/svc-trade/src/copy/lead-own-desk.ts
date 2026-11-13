/**
 * The lead's own desk (CB-copy-13 levels part, CB-copy-15 copier management, CB-copy-18 stop leading;
 * J-copy-bots-otc-05 #1 #6 #7).
 *
 * A listed lead reads their copiers and removes one, or several at once. A removal is refused while the copier holds
 * an open copied position (`trade.copy_open_positions_block_removal`), and beyond the owner's daily removal limit
 * (TRADE_COPY_LEAD_REMOVAL_DAILY_LIMIT; blank refuses `trade.copy_removal_limit_unset`, the limit reached refuses
 * `trade.copy_removal_limit_reached`), counted by the server's UTC day. Each removal is one row under its business key
 * `copy.lead.remove:<followId>`; a bulk removal gives every id its own key, so a retry skips the ids already removed.
 * Removing ends the follow (detached, its reserve released, as a follower's own leave does). Nothing posts.
 *
 * The level is read from the copied funds the lead's active copiers hold against the owner's thresholds
 * (TRADE_COPY_LEAD_LEVELS; blank: the level is "Not set"). The platform sets no profit-share ratio: any request to set
 * one is refused `trade.copy_pnl_fee_forbidden`.
 *
 * Stopping leading moves the listing to review: refused while the lead holds an open spot position
 * (`trade.copy_lead_positions_open`), then `review_pending` until a founder approves (the listing becomes delisted
 * through the leader directory) or rejects (`failed`, the listing stays listed).
 */
import { randomUUID } from 'node:crypto';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import type { Principal } from '@intafaced/auth';
import type { Sql } from 'postgres';
import { requireOperator, requireOperatorWrite } from '../admin/common.js';
import { applyCopyDetach, followRelationshipState } from './copy-lifecycle.js';
import type { CopiedPosition } from './copied-positions.js';
import { CopyError } from './errors.js';
import { refusePnlLinkedCopyFee } from './fee-share.js';
import type { CopyFollowStore } from './follow-store.js';
import type { CopyFollow } from './follows.js';
import type { LeaderDirectory } from './leader-directory.js';
import type { CopyLeaderListingState, CopyLeaderMarketMode } from './leader-listing.js';
import type { LeaderTrade } from './leader-profile.js';

/** The business key of one lead's removal of one copier. */
export const leadRemovalKey = (followId: string): string => `copy.lead.remove:${followId}`;
/** The business key of one stop-leading request. */
export const leadStopKey = (leaderRef: string, clientRequestId: string): string => `copy.lead.stop:${leaderRef}:${clientRequestId}`;

export const LEAD_BULK_REMOVE_MAX = 200;
export const LEAD_REMOVAL_LIMIT_MAX = 10_000;

// ── Owner values ─────────────────────────────────────────────────────────────

/** The owner's daily removal limit from its env value: blank is unset (null); anything but a whole 1..10000 stops boot. */
export function parseLeadRemovalDailyLimit(raw: string | undefined): number | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  const n = /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(n) || n < 1 || n > LEAD_REMOVAL_LIMIT_MAX) {
    throw new Error(`TRADE_COPY_LEAD_REMOVAL_DAILY_LIMIT must be a whole number 1 to ${LEAD_REMOVAL_LIMIT_MAX}, or blank`);
  }
  return n;
}

export interface LeadLevelStep {
  readonly name: string;
  /** Copied funds, in the levels' asset, from which this level holds. */
  readonly minCopiedFunds: Amount;
}
export interface LeadLevels {
  readonly asset: string;
  /** Lowest threshold first. */
  readonly steps: readonly LeadLevelStep[];
}

/**
 * The owner's lead levels from TRADE_COPY_LEAD_LEVELS, JSON `{"asset":"USDT","levels":[{"name":"…","minCopiedFunds":"0"}]}`.
 * Blank is unset (null). Anything malformed (no levels, a blank name, a threshold not a decimal string, thresholds
 * not strictly rising) stops the boot: a wrong level is worse than none.
 */
export function parseLeadLevels(raw: string | undefined): LeadLevels | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  const fail = (why: string): never => {
    throw new Error(`TRADE_COPY_LEAD_LEVELS ${why}`);
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return fail('must be JSON');
  }
  const obj = parsed as { asset?: unknown; levels?: unknown };
  if (typeof obj?.asset !== 'string' || !/^[A-Z0-9]{2,12}$/.test(obj.asset)) fail('needs an asset such as "USDT"');
  if (!Array.isArray(obj.levels) || obj.levels.length === 0 || obj.levels.length > 20) fail('needs 1 to 20 levels');
  const steps: LeadLevelStep[] = [];
  for (const level of obj.levels as Array<{ name?: unknown; minCopiedFunds?: unknown }>) {
    const name = typeof level?.name === 'string' ? level.name.trim() : '';
    if (!name || name.length > 40) fail('has a level with a blank or long name');
    if (typeof level.minCopiedFunds !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(level.minCopiedFunds)) {
      fail(`level ${name} needs minCopiedFunds as a decimal string`);
    }
    const min = parseAmount(level.minCopiedFunds as string);
    const prior = steps[steps.length - 1];
    if (prior && min <= prior.minCopiedFunds) fail('thresholds must rise strictly');
    steps.push({ name, minCopiedFunds: min });
  }
  return { asset: obj.asset as string, steps };
}

// ── Wire shapes ──────────────────────────────────────────────────────────────

export interface LeadFollowerRow {
  readonly followId: string;
  readonly state: string;
  readonly since: string;
  /** What the copier set aside for this follow, as a decimal string, and its asset. Null when the follow holds none. */
  readonly investment: string | null;
  readonly asset: string | null;
  /** Copied positions not yet closed. */
  readonly openPositions: number;
  readonly removedAt: string | null;
}

export type LeadRemovalOutcome =
  | { readonly followId: string; readonly key: string; readonly outcome: 'removed' | 'already_removed'; readonly at: string }
  | { readonly followId: string; readonly key: string; readonly outcome: 'refused'; readonly code: string; readonly message: string };

export interface LeadLevelView {
  readonly asset: string | null;
  readonly copiedFunds: string;
  /** Null when the owner set no levels: the room says "Not set". */
  readonly level: { readonly name: string; readonly threshold: string } | null;
  readonly next: { readonly name: string; readonly threshold: string } | null;
  readonly levelsSet: boolean;
  /** The platform sets no profit-share ratio. Always null. */
  readonly maxRatio: null;
}

export type LeadStopState = 'review_pending' | 'approved' | 'failed';
export interface LeadStopView {
  readonly stopId: string;
  readonly key: string;
  readonly leaderRef: string;
  readonly marketMode: string;
  readonly state: LeadStopState;
  readonly requestedAt: string;
  readonly decidedAt: string | null;
  readonly reason: string | null;
}
export interface LeadListingSelf {
  readonly leaderRef: string;
  readonly displayName: string;
  readonly marketMode: CopyLeaderMarketMode;
  readonly state: CopyLeaderListingState;
  readonly stop: LeadStopView | null;
}

// ── Storage ──────────────────────────────────────────────────────────────────

export interface StoredLeadStop {
  readonly id: string;
  readonly requestKey: string;
  readonly leaderId: string;
  readonly leaderRef: string;
  readonly marketMode: string;
  readonly state: LeadStopState;
  readonly decidedBy: string | null;
  readonly decisionReason: string | null;
  readonly requestedAt: Date;
  readonly decidedAt: Date | null;
}

export interface LeadOwnStore {
  listFollowIdsByLeader(leaderId: string): Promise<string[]>;
  getRemoval(key: string): Promise<{ readonly removedAt: Date } | null>;
  /** Writes the removal unless its key exists, under the leader's limit for the day that starts at `dayStart`. */
  insertRemovalUnderLimit(
    row: { key: string; leaderId: string; followId: string; followerId: string; reason: string | null; at: Date },
    limit: number,
    dayStart: Date,
  ): Promise<'inserted' | 'exists' | 'limit'>;
  latestStop(leaderId: string): Promise<StoredLeadStop | null>;
  /** Inserts a review_pending stop; an existing open stop of the leader, or a row under the same key, is returned instead. */
  insertStop(row: StoredLeadStop): Promise<StoredLeadStop>;
  getStop(id: string): Promise<StoredLeadStop | null>;
  /** Moves a review_pending stop to its decision; returns the row as it stands after. */
  decideStop(id: string, state: 'approved' | 'failed', by: string, reason: string, at: Date): Promise<StoredLeadStop | null>;
  openStops(limit: number): Promise<StoredLeadStop[]>;
}

export class MemoryLeadOwnStore implements LeadOwnStore {
  readonly removals = new Map<string, { leaderId: string; at: Date }>();
  readonly stops = new Map<string, StoredLeadStop>();
  constructor(private readonly followsByLeader: (leaderId: string) => Promise<string[]>) {}
  listFollowIdsByLeader(leaderId: string) {
    return this.followsByLeader(leaderId);
  }
  async getRemoval(key: string) {
    const row = this.removals.get(key);
    return row ? { removedAt: row.at } : null;
  }
  async insertRemovalUnderLimit(
    row: { key: string; leaderId: string; followId: string; followerId: string; reason: string | null; at: Date },
    limit: number,
    dayStart: Date,
  ): Promise<'inserted' | 'exists' | 'limit'> {
    if (this.removals.has(row.key)) return 'exists';
    const today = [...this.removals.values()].filter((r) => r.leaderId === row.leaderId && r.at >= dayStart).length;
    if (today >= limit) return 'limit';
    this.removals.set(row.key, { leaderId: row.leaderId, at: row.at });
    return 'inserted';
  }
  async latestStop(leaderId: string) {
    return [...this.stops.values()].filter((s) => s.leaderId === leaderId).sort((a, b) => +b.requestedAt - +a.requestedAt)[0] ?? null;
  }
  async insertStop(row: StoredLeadStop) {
    const same = [...this.stops.values()].find((s) => s.requestKey === row.requestKey);
    if (same) return same;
    const open = [...this.stops.values()].find((s) => s.leaderId === row.leaderId && s.state === 'review_pending');
    if (open) return open;
    this.stops.set(row.id, row);
    return row;
  }
  async getStop(id: string) {
    return this.stops.get(id) ?? null;
  }
  async decideStop(id: string, state: 'approved' | 'failed', by: string, reason: string, at: Date) {
    const row = this.stops.get(id);
    if (!row) return null;
    if (row.state !== 'review_pending') return row;
    const next = { ...row, state, decidedBy: by, decisionReason: reason, decidedAt: at };
    this.stops.set(id, next);
    return next;
  }
  async openStops(limit: number) {
    return [...this.stops.values()].filter((s) => s.state === 'review_pending').slice(0, limit);
  }
}

type StopRow = {
  id: string;
  request_key: string;
  leader_id: string;
  leader_ref: string;
  market_mode: string;
  state: LeadStopState;
  decided_by: string | null;
  decision_reason: string | null;
  requested_at: Date;
  decided_at: Date | null;
};
const stopFromRow = (r: StopRow): StoredLeadStop => ({
  id: r.id,
  requestKey: r.request_key,
  leaderId: r.leader_id,
  leaderRef: r.leader_ref,
  marketMode: r.market_mode,
  state: r.state,
  decidedBy: r.decided_by,
  decisionReason: r.decision_reason,
  requestedAt: new Date(r.requested_at),
  decidedAt: r.decided_at ? new Date(r.decided_at) : null,
});

export class SqlLeadOwnStore implements LeadOwnStore {
  constructor(private readonly sql: Sql) {}

  async listFollowIdsByLeader(leaderId: string): Promise<string[]> {
    const rows = await this.sql<Array<{ follow_id: string }>>`
      SELECT follow_id FROM copy_follows WHERE leader_id = ${leaderId} ORDER BY created_at DESC, follow_id LIMIT 1000`;
    return rows.map((r) => r.follow_id);
  }

  async getRemoval(key: string) {
    const [row] = await this.sql<Array<{ removed_at: Date }>>`
      SELECT removed_at FROM trade.copy_lead_removals WHERE removal_key = ${key}`;
    return row ? { removedAt: new Date(row.removed_at) } : null;
  }

  async insertRemovalUnderLimit(
    row: { key: string; leaderId: string; followId: string; followerId: string; reason: string | null; at: Date },
    limit: number,
    dayStart: Date,
  ): Promise<'inserted' | 'exists' | 'limit'> {
    return this.sql.begin(async (tx) => {
      // One lead's removals one at a time, so two at once cannot both take the day's last place.
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`copy.lead.remove:${row.leaderId}`}, 0))`;
      const [exists] = await tx`SELECT 1 FROM trade.copy_lead_removals WHERE removal_key = ${row.key}`;
      if (exists) return 'exists' as const;
      const [count] = await tx<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM trade.copy_lead_removals
         WHERE leader_id = ${row.leaderId} AND removed_at >= ${dayStart.toISOString()}`;
      if ((count?.n ?? 0) >= limit) return 'limit' as const;
      await tx`
        INSERT INTO trade.copy_lead_removals (removal_key, leader_id, follow_id, follower_id, reason, removed_at)
        VALUES (${row.key}, ${row.leaderId}, ${row.followId}, ${row.followerId}, ${row.reason}, ${row.at.toISOString()})`;
      return 'inserted' as const;
    }) as Promise<'inserted' | 'exists' | 'limit'>;
  }

  async latestStop(leaderId: string) {
    const [row] = await this.sql<StopRow[]>`
      SELECT * FROM trade.copy_lead_stops WHERE leader_id = ${leaderId} ORDER BY requested_at DESC, id DESC LIMIT 1`;
    return row ? stopFromRow(row) : null;
  }

  async insertStop(row: StoredLeadStop) {
    return this.sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`copy.lead.stop:${row.leaderId}`}, 0))`;
      const [same] = await tx<StopRow[]>`
        SELECT * FROM trade.copy_lead_stops WHERE request_key = ${row.requestKey}
           OR (leader_id = ${row.leaderId} AND state = 'review_pending')
         ORDER BY (request_key = ${row.requestKey}) DESC LIMIT 1`;
      if (same) return stopFromRow(same);
      const [inserted] = await tx<StopRow[]>`
        INSERT INTO trade.copy_lead_stops (id, request_key, leader_id, leader_ref, market_mode, state, requested_at)
        VALUES (${row.id}, ${row.requestKey}, ${row.leaderId}, ${row.leaderRef}, ${row.marketMode}, 'review_pending',
                ${row.requestedAt.toISOString()})
        RETURNING *`;
      return stopFromRow(inserted!);
    }) as Promise<StoredLeadStop>;
  }

  async getStop(id: string) {
    const [row] = await this.sql<StopRow[]>`SELECT * FROM trade.copy_lead_stops WHERE id = ${id}`;
    return row ? stopFromRow(row) : null;
  }

  async decideStop(id: string, state: 'approved' | 'failed', by: string, reason: string, at: Date) {
    await this.sql`
      UPDATE trade.copy_lead_stops
         SET state = ${state}, decided_by = ${by}, decision_reason = ${reason}, decided_at = ${at.toISOString()}
       WHERE id = ${id} AND state = 'review_pending'`;
    return this.getStop(id);
  }

  async openStops(limit: number) {
    const rows = await this.sql<StopRow[]>`
      SELECT * FROM trade.copy_lead_stops WHERE state = 'review_pending' ORDER BY requested_at, id LIMIT ${limit}`;
    return rows.map(stopFromRow);
  }
}

// ── The desk ─────────────────────────────────────────────────────────────────

export interface LeadOwnDeskDeps {
  readonly store: LeadOwnStore;
  readonly follows: CopyFollowStore;
  readonly directory: Pick<LeaderDirectory, 'listingIdentity' | 'setLeaderState'>;
  /** The follower's copied positions of one follow (CB-copy-09/10). */
  readonly copiedPositions: ((input: { followId: string; followerId: string }) => Promise<readonly CopiedPosition[]>) | null;
  /** The lead's own spot trades, paired into positions (the lead page's read). */
  readonly leaderTrades: ((leaderUserId: string) => Promise<readonly LeaderTrade[]>) | null;
  readonly now: () => Date;
  /** TRADE_COPY_LEAD_REMOVAL_DAILY_LIMIT. Null: unset, every removal refuses. */
  readonly removalDailyLimit: number | null;
  /** TRADE_COPY_LEAD_LEVELS. Null: unset, the level reads "Not set". */
  readonly levels: LeadLevels | null;
}

const utcDayStart = (at: Date): Date => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));

const stopView = (s: StoredLeadStop): LeadStopView => ({
  stopId: s.id,
  key: s.requestKey,
  leaderRef: s.leaderRef,
  marketMode: s.marketMode,
  state: s.state,
  requestedAt: s.requestedAt.toISOString(),
  decidedAt: s.decidedAt ? s.decidedAt.toISOString() : null,
  reason: s.decisionReason,
});

function cleanReason(reason: string | undefined | null): string | null {
  const value = (reason ?? '').trim();
  return value ? value.slice(0, 500) : null;
}

export class LeadOwnDesk {
  constructor(private readonly deps: LeadOwnDeskDeps) {}

  /** The caller's own listing; a caller who leads nothing is refused by name. */
  private async ownListing(principal: Principal) {
    const listing = await this.deps.directory.listingIdentity(principal.userId);
    if (!listing) throw new CopyError('You do not lead a listing', 'trade.copy_lead_not_leading');
    return listing;
  }

  async listing(principal: Principal): Promise<LeadListingSelf> {
    const listing = await this.ownListing(principal);
    const stop = await this.deps.store.latestStop(principal.userId);
    return {
      leaderRef: listing.leaderRef,
      displayName: listing.displayName,
      marketMode: listing.marketMode,
      state: listing.state,
      stop: stop ? stopView(stop) : null,
    };
  }

  private async openPositionsOf(follow: CopyFollow): Promise<number> {
    if (!this.deps.copiedPositions) {
      throw new CopyError('Copied positions need the spot tables', 'trade.copy_unavailable');
    }
    const positions = await this.deps.copiedPositions({ followId: follow.followId, followerId: follow.followerId });
    const open = positions.filter((p) => p.status !== 'closed').length;
    return open + (await this.deps.follows.countOpenMirrors(follow.followId));
  }

  /** The caller's copiers, newest first, with what each set aside and how many copied positions are still open. */
  async followers(principal: Principal): Promise<{ followers: LeadFollowerRow[]; removalDailyLimit: number | null }> {
    await this.ownListing(principal);
    const ids = await this.deps.store.listFollowIdsByLeader(principal.userId);
    const rows: LeadFollowerRow[] = [];
    for (const id of ids) {
      const follow = await this.deps.follows.getFollow(id);
      if (!follow || follow.leaderId !== principal.userId) continue;
      const removal = await this.deps.store.getRemoval(leadRemovalKey(follow.followId));
      const state = followRelationshipState(follow);
      rows.push({
        followId: follow.followId,
        state,
        since: follow.createdAt.toISOString(),
        investment: follow.reserve ? formatAmount(follow.reserve.amount) : null,
        asset: follow.reserve?.asset ?? null,
        openPositions: state === 'DETACHED' && removal ? 0 : await this.openPositionsOf(follow),
        removedAt: removal ? removal.removedAt.toISOString() : null,
      });
    }
    return { followers: rows, removalDailyLimit: this.deps.removalDailyLimit };
  }

  /** Remove one copier. A refusal throws its typed code; the same removal again answers `already_removed`. */
  async removeFollower(principal: Principal, input: { followId: string; reason?: string | null }): Promise<LeadRemovalOutcome> {
    const limit = this.requireLimit();
    await this.ownListing(principal);
    return this.removeOne(principal.userId, input.followId, cleanReason(input.reason), limit);
  }

  /**
   * Remove several copiers, one at a time in the order given, each under its own key. A refused id does not stop the
   * rest; an id removed before (by an earlier run of the same list) is skipped as `already_removed`.
   */
  async removeFollowers(
    principal: Principal,
    input: { followIds: readonly string[]; reason?: string | null },
  ): Promise<{ results: LeadRemovalOutcome[] }> {
    const limit = this.requireLimit();
    await this.ownListing(principal);
    const ids = [...new Set(input.followIds.map((id) => id.trim()).filter(Boolean))];
    if (ids.length === 0 || ids.length > LEAD_BULK_REMOVE_MAX) {
      throw new CopyError(`A bulk removal takes 1 to ${LEAD_BULK_REMOVE_MAX} copiers`, 'trade.copy_batch_too_large');
    }
    const reason = cleanReason(input.reason);
    const results: LeadRemovalOutcome[] = [];
    for (const followId of ids) {
      try {
        results.push(await this.removeOne(principal.userId, followId, reason, limit));
      } catch (err) {
        if (!(err instanceof CopyError)) throw err;
        results.push({ followId, key: leadRemovalKey(followId), outcome: 'refused', code: err.code, message: err.message });
      }
    }
    return { results };
  }

  private requireLimit(): number {
    if (this.deps.removalDailyLimit === null) {
      throw new CopyError('The daily limit on removing copiers is not set by the platform', 'trade.copy_removal_limit_unset');
    }
    return this.deps.removalDailyLimit;
  }

  private async removeOne(leaderId: string, followId: string, reason: string | null, limit: number): Promise<LeadRemovalOutcome> {
    const key = leadRemovalKey(followId);
    const follow = await this.deps.follows.getFollow(followId);
    // Another lead's copier, or no follow at all, reads the same: the lead learns nothing about follows not theirs.
    if (!follow || follow.leaderId !== leaderId) throw new CopyError('Follow not found', 'trade.copy_not_following');
    const prior = await this.deps.store.getRemoval(key);
    if (prior) {
      // A removal whose follow write never landed (a crash between the two) is finished here, by the same key.
      await this.detach(followId);
      return { followId, key, outcome: 'already_removed', at: prior.removedAt.toISOString() };
    }
    if (followRelationshipState(follow) === 'DETACHED') {
      throw new CopyError('This copier has already stopped copying you', 'trade.copy_detached');
    }
    if ((await this.openPositionsOf(follow)) > 0) {
      throw new CopyError(
        'This copier has open copied positions. They can be removed once those positions are closed.',
        'trade.copy_open_positions_block_removal',
      );
    }
    const at = this.deps.now();
    const written = await this.deps.store.insertRemovalUnderLimit(
      { key, leaderId, followId, followerId: follow.followerId, reason, at },
      limit,
      utcDayStart(at),
    );
    if (written === 'limit') {
      throw new CopyError(`You have removed ${limit} copiers today, the most a day allows`, 'trade.copy_removal_limit_reached');
    }
    await this.detach(followId);
    if (written === 'exists') {
      const again = await this.deps.store.getRemoval(key);
      return { followId, key, outcome: 'already_removed', at: (again?.removedAt ?? at).toISOString() };
    }
    return { followId, key, outcome: 'removed', at: at.toISOString() };
  }

  /** Ends the follow (detached, reserve released) unless it already is. */
  private async detach(followId: string): Promise<void> {
    await this.deps.follows.runFollowExclusive(followId, async (store) => {
      const follow = await store.getFollow(followId);
      if (!follow || followRelationshipState(follow) === 'DETACHED') return;
      await store.saveFollow(applyCopyDetach(follow));
    });
  }

  /** The lead's level, from the copied funds of their active copiers and the owner's thresholds. */
  async level(principal: Principal): Promise<LeadLevelView> {
    await this.ownListing(principal);
    const levels = this.deps.levels;
    let funds = 0n;
    if (levels) {
      for (const id of await this.deps.store.listFollowIdsByLeader(principal.userId)) {
        const follow = await this.deps.follows.getFollow(id);
        if (!follow || follow.leaderId !== principal.userId) continue;
        const state = followRelationshipState(follow);
        if (state !== 'ACTIVE' && state !== 'PAUSED') continue;
        if (!follow.reserve || follow.reserve.releasedAt || follow.reserve.asset !== levels.asset) continue;
        funds += follow.reserve.amount;
      }
    }
    const reached = levels ? [...levels.steps].reverse().find((s) => funds >= s.minCopiedFunds) : undefined;
    const next = levels?.steps.find((s) => s.minCopiedFunds > funds);
    return {
      asset: levels?.asset ?? null,
      copiedFunds: formatAmount(funds),
      level: reached ? { name: reached.name, threshold: formatAmount(reached.minCopiedFunds) } : null,
      next: next ? { name: next.name, threshold: formatAmount(next.minCopiedFunds) } : null,
      levelsSet: levels !== null,
      maxRatio: null,
    };
  }

  /** The platform sets no profit-share ratio, for any lead, level, invitee or private list. Always refused. */
  async setProfitShareRatio(principal: Principal): Promise<never> {
    await this.ownListing(principal);
    return refusePnlLinkedCopyFee();
  }

  /** Ask to stop leading. Refused while the lead holds an open spot position; otherwise review pending. */
  async stopLeading(principal: Principal, input: { clientRequestId: string }): Promise<LeadStopView> {
    const listing = await this.ownListing(principal);
    const requestId = input.clientRequestId.trim();
    if (requestId.length < 8 || requestId.length > 120) {
      throw new CopyError('The request needs its own key', 'trade.copy_request_key_invalid');
    }
    const latest = await this.deps.store.latestStop(principal.userId);
    if (latest?.state === 'review_pending') return stopView(latest);
    if (listing.state !== 'listed') throw new CopyError('Your listing is not listed', 'trade.copy_lead_not_listed');
    if (listing.marketMode !== 'spot' || !this.deps.leaderTrades) {
      // Only spot positions can be read here; any other market fails closed rather than guess that it is flat.
      throw new CopyError('Your positions in this market cannot be checked yet', 'trade.copy_lead_positions_unreadable');
    }
    const open = (await this.deps.leaderTrades(principal.userId)).filter((t) => t.state === 'open');
    if (open.length > 0) {
      throw new CopyError('Close your open positions first, then ask to stop leading', 'trade.copy_lead_positions_open');
    }
    const row = await this.deps.store.insertStop({
      id: randomUUID(),
      requestKey: leadStopKey(listing.leaderRef, requestId),
      leaderId: principal.userId,
      leaderRef: listing.leaderRef,
      marketMode: listing.marketMode,
      state: 'review_pending',
      decidedBy: null,
      decisionReason: null,
      requestedAt: this.deps.now(),
      decidedAt: null,
    });
    return stopView(row);
  }

  // ── Founders ──

  async stopQueue(principal: Principal): Promise<{ stops: LeadStopView[] }> {
    requireOperator(principal);
    return { stops: (await this.deps.store.openStops(200)).map(stopView) };
  }

  /**
   * A founder decides a stop. Approving delists the listing through the leader directory under the key
   * `copy.lead.stop:<stopId>:approve`, then records the decision; a crash between the two is finished by deciding again.
   */
  async decideStop(principal: Principal, input: { stopId: string; decision: 'approve' | 'reject'; reason: string }): Promise<LeadStopView> {
    requireOperatorWrite(principal);
    const reason = cleanReason(input.reason);
    if (!reason || reason.length < 3) throw new CopyError('A decision needs its reason', 'trade.copy_leader_state_reason_unset');
    const stop = await this.deps.store.getStop(input.stopId);
    if (!stop) throw new CopyError('Stop request not found', 'trade.copy_lead_stop_not_found');
    if (stop.state !== 'review_pending') {
      const wanted = input.decision === 'approve' ? 'approved' : 'failed';
      if (stop.state === wanted) return stopView(stop);
      throw new CopyError('This stop request is already decided', 'trade.copy_lead_stop_decided');
    }
    if (input.decision === 'approve') {
      await this.deps.directory.setLeaderState(principal, {
        leaderRef: stop.leaderRef,
        state: 'delisted',
        reason,
        clientRequestId: `copy.lead.stop:${stop.id}:approve`,
      });
    }
    const decided = await this.deps.store.decideStop(
      stop.id,
      input.decision === 'approve' ? 'approved' : 'failed',
      principal.userId,
      reason,
      this.deps.now(),
    );
    return stopView(decided ?? stop);
  }
}
