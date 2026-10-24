/**
 * Operator-published leader directory and the follower-visible events.
 *
 * Listings are written only through the operator door. Followers see listed
 * rows, their own follow's leader status, and events since the follow began.
 * Nothing in a customer payload is the leader's user id, another follower,
 * a position, a fill, a fee, or the operator's reason.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Principal } from '@intafaced/auth';
import type { Sql } from 'postgres';
import { requireOperatorWrite } from '../admin/common.js';
import { CopyError } from './errors.js';
import { isPgUniqueViolation, SqlCopyFollowStore, type CopyFollowStore } from './follow-store.js';
import type { CopyFollow } from './follows.js';
import type { CopyFeeShareLaw } from './fee-share-law.js';
import {
  decodeEventCursor,
  encodeEventCursor,
  eventKindForStateChange,
  presentLeaderEvent,
  presentLeaderEventsPage,
  stateEventDetail,
  type CopyLeaderEventKind,
  type LeaderEventDetail,
  type LeaderEventsPage,
  type StoredLeaderEvent,
} from './leader-events.js';
import {
  customerStatus,
  decodeListingCursor,
  encodeListingCursor,
  listingContentKey,
  normaliseLeaderSearch,
  normaliseListingWrite,
  presentLeaderPage,
  presentLeaderRow,
  publishedCopyPageLimit,
  refuseLeaderDirectoryRanking,
  refuseNewMirrorForStatus,
  requireClientRequestId,
  type CopyLeaderCustomerStatus,
  type CopyLeaderListingState,
  type CopyLeaderMarketMode,
  type CopyLeaderRecordKind,
  type LeaderDirectoryPage,
  type LeaderDirectoryRow,
  type StoredLeaderListing,
  type UpsertLeaderListingInput,
} from './leader-listing.js';

export type OperatorListingResult = {
  readonly leaderRef: string;
  readonly state: CopyLeaderListingState;
  readonly recordKind: CopyLeaderRecordKind;
  readonly clientRequestId: string;
  readonly replayed: false;
};

export type SetLeaderStateInput = {
  readonly leaderRef?: string;
  readonly state?: string;
  readonly reason?: string;
  readonly clientRequestId?: string;
};

export type ListLeadersQuery = {
  readonly limit?: number;
  readonly cursor?: string | null;
  /** One market's leaders only. Omitted lists every mode. */
  readonly marketMode?: string;
  /** Name search, case-insensitive, matched on the server. */
  readonly q?: string;
  readonly sort?: string;
  readonly order?: string;
  readonly orderBy?: string;
  readonly return?: string;
  readonly profit?: string;
  readonly copiers?: string;
  readonly rank?: string;
  /** A ranked category or the trending row. Always refused: rankings are not offered (CB-copy-23). */
  readonly category?: string;
  readonly trending?: boolean;
};

/** Server-side directory filter: one market mode and a name fragment, both optional. */
export type ListedFilter = { readonly marketMode: CopyLeaderMarketMode | null; readonly nameLike: string | null };

type AuditInsert = {
  readonly auditId: string;
  readonly operatorId: string;
  readonly leaderRef: string;
  readonly leaderUserId: string;
  readonly occurredAt: Date;
  readonly action: string;
  readonly clientRequestId: string;
  readonly reason: string | null;
  readonly detail: { readonly state: string; readonly displayName: string; readonly recordKind: string };
};

type StoredRequest = {
  readonly kind: string;
  readonly fingerprint: string;
  readonly result: OperatorListingResult;
};

interface LeaderBackend {
  readonly boundSql: Sql | null;
  transaction<T>(fn: (tx: LeaderBackend) => Promise<T>): Promise<T>;
  getByRef(leaderRef: string, lock: boolean): Promise<StoredLeaderListing | null>;
  getByUser(leaderUserId: string, lock: boolean): Promise<StoredLeaderListing | null>;
  insertListing(row: StoredLeaderListing): Promise<void>;
  updateListing(row: StoredLeaderListing): Promise<void>;
  listListed(afterListedAt: Date, afterRef: string, limit: number, filter?: ListedFilter): Promise<StoredLeaderListing[]>;
  countActive(leaderUserId: string): Promise<number>;
  insertEvent(event: StoredLeaderEvent): Promise<void>;
  insertCapacityFullOnce(listing: StoredLeaderListing, occurredAt: Date): Promise<void>;
  listEvents(
    leaderRef: string,
    since: Date,
    beforeAt: Date,
    beforeId: string,
    limit: number,
    hasCursor: boolean,
  ): Promise<StoredLeaderEvent[]>;
  insertAudit(row: AuditInsert): Promise<void>;
  loadRequest(clientRequestId: string): Promise<StoredRequest | null>;
  insertRequest(clientRequestId: string, kind: string, fingerprint: string, result: OperatorListingResult, at: Date): Promise<void>;
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function asDate(value: Date | string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function asAssets(value: unknown): string[] {
  const parsed = typeof value === 'string' ? (JSON.parse(value) as unknown) : value;
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item): item is string => typeof item === 'string');
}

type ListingSqlRow = {
  leader_ref: string;
  leader_user_id: string;
  state: CopyLeaderListingState;
  display_name: string;
  market_mode: CopyLeaderMarketMode | null;
  record_kind: CopyLeaderRecordKind;
  tenure_start: Date | string | null;
  assets: unknown;
  capacity: number | null;
  strategy_version: string | null;
  published_return: string | null;
  maximum_drawdown: string | null;
  window_start: Date | string | null;
  window_end: Date | string | null;
  net_of_costs: boolean | null;
  evidence_ref: string | null;
  listed_at: Date | string | null;
  state_changed_at: Date | string;
  created_at: Date | string;
  updated_at: Date | string;
};

function listingFromRow(row: ListingSqlRow): StoredLeaderListing {
  return {
    leaderRef: row.leader_ref,
    leaderUserId: row.leader_user_id,
    state: row.state,
    displayName: row.display_name,
    marketMode: row.market_mode ?? 'spot',
    recordKind: row.record_kind,
    tenureStart: asDate(row.tenure_start),
    assets: asAssets(row.assets),
    capacity: row.capacity === null || row.capacity === undefined ? null : Number(row.capacity),
    strategyVersion: row.strategy_version,
    publishedReturn: row.published_return,
    maximumDrawdown: row.maximum_drawdown,
    windowStart: asDate(row.window_start),
    windowEnd: asDate(row.window_end),
    netOfCosts: row.net_of_costs,
    evidenceRef: row.evidence_ref,
    listedAt: asDate(row.listed_at),
    stateChangedAt: asDate(row.state_changed_at) ?? new Date(0),
    createdAt: asDate(row.created_at) ?? new Date(0),
    updatedAt: asDate(row.updated_at) ?? new Date(0),
  };
}

const LISTING_COLUMNS = `
  leader_ref, leader_user_id, state, display_name, market_mode, record_kind,
  tenure_start, assets, capacity, strategy_version,
  published_return, maximum_drawdown, window_start, window_end,
  net_of_costs, evidence_ref, listed_at, state_changed_at, created_at, updated_at
`;

function resultOf(row: StoredLeaderListing, clientRequestId: string): OperatorListingResult {
  return {
    leaderRef: row.leaderRef,
    state: row.state,
    recordKind: row.recordKind,
    clientRequestId,
    replayed: false,
  };
}

export class LeaderDirectory {
  constructor(
    private readonly backend: LeaderBackend,
    private readonly now: () => Date,
    private readonly feeShareLaw: CopyFeeShareLaw,
  ) {}

  async resolveLeaderId(leaderId: string | undefined, leaderRef: string | undefined): Promise<string> {
    const id = leaderId?.trim() ?? '';
    const ref = leaderRef?.trim() ?? '';
    if ((id && ref) || (!id && !ref)) {
      throw new CopyError('Pass exactly one of leaderId or leaderRef', 'trade.copy_leader_identity_unset');
    }
    if (id) return id;
    const row = await this.backend.getByRef(ref, false);
    if (!row || row.state !== 'listed') {
      throw new CopyError('Leader not found', 'trade.copy_leader_not_found');
    }
    return row.leaderUserId;
  }

  /** One query. The listing ref and state for a leader user id, or null when no row exists. */
  async listingIdentity(leaderUserId: string): Promise<{ readonly leaderRef: string; readonly state: CopyLeaderListingState } | null> {
    const row = await this.backend.getByUser(leaderUserId, false);
    if (!row) return null;
    return { leaderRef: row.leaderRef, state: row.state };
  }

  async leaderStatus(leaderUserId: string): Promise<CopyLeaderCustomerStatus> {
    return customerStatus((await this.listingIdentity(leaderUserId))?.state);
  }

  async refuseNewMirror(leaderUserId: string): Promise<void> {
    refuseNewMirrorForStatus(await this.leaderStatus(leaderUserId));
  }

  /**
   * Capacity is the published integer only. Unpublished capacity does not
   * refuse. The listing row is locked so two new follows cannot both pass.
   */
  async admitNewFollow(leaderUserId: string, followStore: CopyFollowStore, follow: CopyFollow): Promise<void> {
    const outcome = await this.backend.transaction(async (tx) => {
      const listing = await tx.getByUser(leaderUserId, true);
      if (listing?.capacity != null) {
        const active = await tx.countActive(leaderUserId);
        if (active >= listing.capacity) {
          await tx.insertCapacityFullOnce(listing, this.now());
          return 'full' as const;
        }
      }
      if (tx.boundSql && followStore instanceof SqlCopyFollowStore) {
        await new SqlCopyFollowStore(tx.boundSql).saveFollow(follow, 0n);
      } else {
        await followStore.saveFollow(follow, 0n);
      }
      return 'ok' as const;
    });
    if (outcome === 'full') {
      throw new CopyError(
        'This leader is full. No new follower was added. Existing follows are unchanged.',
        'trade.copy_leader_capacity_full',
      );
    }
  }

  async listLeaders(input: ListLeadersQuery): Promise<LeaderDirectoryPage> {
    refuseLeaderDirectoryRanking(input);
    const limit = publishedCopyPageLimit(input.limit, 'trade.copy_leaders_limit_unset', 'listLeaders');
    const cursor = decodeListingCursor(input.cursor);
    const filter = normaliseLeaderSearch(input);
    const rows = await this.backend.listListed(cursor.listedAt, cursor.leaderRef, limit + 1, filter);
    const page = rows.slice(0, limit);
    const leaders = [];
    for (const row of page) {
      leaders.push(presentLeaderRow(row, await this.backend.countActive(row.leaderUserId), this.feeShareLaw));
    }
    const last = page[page.length - 1];
    const nextCursor = rows.length > limit && last?.listedAt ? encodeListingCursor(last.listedAt, last.leaderRef) : null;
    return presentLeaderPage(leaders, nextCursor);
  }

  /**
   * One listed leader's public row by its ref, with the user id kept server-side for the trade read. Anything
   * not listed (unknown, unlisted, suspended, delisted) is not found, so a page never shows a leader the
   * directory does not.
   */
  async listedLeader(leaderRef: string): Promise<{ readonly row: LeaderDirectoryRow; readonly leaderUserId: string }> {
    const ref = leaderRef.trim();
    const listing = ref ? await this.backend.getByRef(ref, false) : null;
    if (!listing || listing.state !== 'listed') throw new CopyError('Leader not found', 'trade.copy_leader_not_found');
    return {
      row: presentLeaderRow(listing, await this.backend.countActive(listing.leaderUserId), this.feeShareLaw),
      leaderUserId: listing.leaderUserId,
    };
  }

  async followEvents(input: { leaderUserId: string; since: Date; limit?: number; cursor?: string | null }): Promise<LeaderEventsPage> {
    const limit = publishedCopyPageLimit(input.limit, 'trade.copy_follow_events_limit_unset', 'followEvents');
    const listing = await this.backend.getByUser(input.leaderUserId, false);
    if (!listing) return presentLeaderEventsPage([], null);
    const cursor = decodeEventCursor(input.cursor);
    const rows = await this.backend.listEvents(
      listing.leaderRef,
      input.since,
      cursor.occurredAt,
      cursor.eventId,
      limit + 1,
      cursor.hasCursor,
    );
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const nextCursor = rows.length > limit && last ? encodeEventCursor(last.occurredAt, last.eventId) : null;
    return presentLeaderEventsPage(page.map(presentLeaderEvent), nextCursor);
  }

  async upsertListing(principal: Principal, input: UpsertLeaderListingInput): Promise<OperatorListingResult> {
    requireOperatorWrite(principal);
    const clientRequestId = requireClientRequestId(input.clientRequestId);
    const write = normaliseListingWrite(input);
    const kind = 'upsert_listing';
    const fp = fingerprint({ kind, write });
    return this.once(clientRequestId, kind, fp, async (tx) => {
      const existing = await tx.getByUser(write.leaderUserId, true);
      const now = this.now();
      const stateChanged = existing !== null && existing.state !== write.state;
      const listedAt = write.state === 'listed' ? (existing?.listedAt ?? now) : (existing?.listedAt ?? null);
      const row: StoredLeaderListing = {
        leaderRef: existing?.leaderRef ?? randomBytes(16).toString('hex'),
        leaderUserId: write.leaderUserId,
        state: write.state,
        displayName: write.displayName,
        marketMode: write.marketMode ?? existing?.marketMode ?? 'spot',
        recordKind: write.recordKind,
        tenureStart: write.tenureStart,
        assets: write.assets,
        capacity: write.capacity,
        strategyVersion: write.strategyVersion,
        publishedReturn: write.publishedReturn,
        maximumDrawdown: write.maximumDrawdown,
        windowStart: write.windowStart,
        windowEnd: write.windowEnd,
        netOfCosts: write.netOfCosts,
        evidenceRef: write.evidenceRef,
        listedAt,
        stateChangedAt: !existing || stateChanged ? now : existing.stateChangedAt,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      };
      if (existing) await tx.updateListing(row);
      else await tx.insertListing(row);
      const events = existing ? eventsForEdit(existing, row, now) : [];
      for (const event of events) await tx.insertEvent(event);
      if (!existing || events.length > 0 || stateChanged) {
        await tx.insertAudit(auditOf(principal.userId, row, now, 'upsert', clientRequestId, null));
      }
      return resultOf(row, clientRequestId);
    });
  }

  async setLeaderState(principal: Principal, input: SetLeaderStateInput): Promise<OperatorListingResult> {
    requireOperatorWrite(principal);
    const clientRequestId = requireClientRequestId(input.clientRequestId);
    const leaderRef = input.leaderRef?.trim() ?? '';
    if (!leaderRef) throw new CopyError('leaderRef is blank', 'trade.copy_leader_record_blank');
    const state = input.state?.trim() ?? '';
    if (state !== 'listed' && state !== 'suspended' && state !== 'delisted') {
      throw new CopyError('state must be listed, suspended or delisted', 'trade.copy_leader_state_invalid');
    }
    const reason = input.reason?.trim() ?? '';
    if (!reason) throw new CopyError('reason is unset', 'trade.copy_leader_state_reason_unset');
    const kind = 'set_leader_state';
    const fp = fingerprint({ kind, leaderRef, state, reason });
    return this.once(clientRequestId, kind, fp, async (tx) => {
      const existing = await tx.getByRef(leaderRef, true);
      if (!existing) throw new CopyError('Leader not found', 'trade.copy_leader_not_found');
      const next = state as CopyLeaderListingState;
      if (existing.state === next) return resultOf(existing, clientRequestId);
      const now = this.now();
      const row: StoredLeaderListing = {
        ...existing,
        state: next,
        listedAt: next === 'listed' ? (existing.listedAt ?? now) : existing.listedAt,
        stateChangedAt: now,
        updatedAt: now,
      };
      await tx.updateListing(row);
      const eventKind = eventKindForStateChange(existing.state, next);
      const detail = eventKind ? stateEventDetail(eventKind) : null;
      if (eventKind && detail) {
        await tx.insertEvent({
          eventId: randomUUID(),
          leaderRef: row.leaderRef,
          kind: eventKind,
          occurredAt: now,
          detail,
        });
      }
      await tx.insertAudit(auditOf(principal.userId, row, now, 'set_state', clientRequestId, reason));
      return resultOf(row, clientRequestId);
    });
  }

  private async once(
    clientRequestId: string,
    kind: string,
    fp: string,
    write: (tx: LeaderBackend) => Promise<OperatorListingResult>,
  ): Promise<OperatorListingResult> {
    const prior = await this.backend.loadRequest(clientRequestId);
    if (prior) return replay(prior, kind, fp);
    try {
      return await this.backend.transaction(async (tx) => {
        const again = await tx.loadRequest(clientRequestId);
        if (again) return replay(again, kind, fp);
        const result = await write(tx);
        await tx.insertRequest(clientRequestId, kind, fp, result, this.now());
        return result;
      });
    } catch (err) {
      if (!isPgUniqueViolation(err)) throw err;
      const winner = await this.backend.loadRequest(clientRequestId);
      if (winner) return replay(winner, kind, fp);
      throw err;
    }
  }
}

function replay(prior: StoredRequest, kind: string, fp: string): OperatorListingResult {
  if (prior.kind !== kind || prior.fingerprint !== fp) {
    throw new CopyError('clientRequestId was already used for a different change', 'trade.copy_leader_request_mismatch');
  }
  return prior.result;
}

function eventsForEdit(existing: StoredLeaderListing, row: StoredLeaderListing, now: Date): StoredLeaderEvent[] {
  const events: StoredLeaderEvent[] = [];
  if (existing.strategyVersion !== row.strategyVersion) {
    events.push({
      eventId: randomUUID(),
      leaderRef: row.leaderRef,
      kind: 'strategy_version_changed',
      occurredAt: now,
      detail: { strategyVersion: row.strategyVersion },
    });
  }
  if (listingContentKey(existing) !== listingContentKey(row)) {
    events.push({
      eventId: randomUUID(),
      leaderRef: row.leaderRef,
      kind: 'listing_edited',
      occurredAt: now,
      detail: { displayName: row.displayName, recordKind: row.recordKind, strategyVersion: row.strategyVersion },
    });
  }
  const kind = eventKindForStateChange(existing.state, row.state);
  const detail = kind ? stateEventDetail(kind) : null;
  if (kind && detail) {
    events.push({ eventId: randomUUID(), leaderRef: row.leaderRef, kind, occurredAt: now, detail });
  }
  return events;
}

function auditOf(
  operatorId: string,
  row: StoredLeaderListing,
  occurredAt: Date,
  action: string,
  clientRequestId: string,
  reason: string | null,
): AuditInsert {
  return {
    auditId: randomUUID(),
    operatorId,
    leaderRef: row.leaderRef,
    leaderUserId: row.leaderUserId,
    occurredAt,
    action,
    clientRequestId,
    reason,
    detail: { state: row.state, displayName: row.displayName, recordKind: row.recordKind },
  };
}

export function memoryLeaderDirectory(options: {
  now: () => Date;
  feeShareLaw: CopyFeeShareLaw;
  countActive: (leaderUserId: string) => Promise<number>;
}): LeaderDirectory {
  return new LeaderDirectory(new MemoryLeaderBackend(options.countActive), options.now, options.feeShareLaw);
}

export function sqlLeaderDirectory(sql: Sql, options: { now: () => Date; feeShareLaw: CopyFeeShareLaw }): LeaderDirectory {
  return new LeaderDirectory(new SqlLeaderBackend(sql), options.now, options.feeShareLaw);
}

class MemoryLeaderBackend implements LeaderBackend {
  readonly boundSql = null;
  private readonly byRef = new Map<string, StoredLeaderListing>();
  private readonly byUser = new Map<string, StoredLeaderListing>();
  private readonly events: StoredLeaderEvent[] = [];
  private readonly requests = new Map<string, StoredRequest>();

  constructor(private readonly countActiveFollows: (leaderUserId: string) => Promise<number>) {}

  async transaction<T>(fn: (tx: LeaderBackend) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async getByRef(leaderRef: string): Promise<StoredLeaderListing | null> {
    return this.byRef.get(leaderRef) ?? null;
  }

  async getByUser(leaderUserId: string): Promise<StoredLeaderListing | null> {
    return this.byUser.get(leaderUserId) ?? null;
  }

  async insertListing(row: StoredLeaderListing): Promise<void> {
    this.byRef.set(row.leaderRef, row);
    this.byUser.set(row.leaderUserId, row);
  }

  async updateListing(row: StoredLeaderListing): Promise<void> {
    this.byRef.set(row.leaderRef, row);
    this.byUser.set(row.leaderUserId, row);
  }

  async listListed(afterListedAt: Date, afterRef: string, limit: number, filter?: ListedFilter): Promise<StoredLeaderListing[]> {
    const needle = filter?.nameLike?.toLowerCase() ?? null;
    return [...this.byRef.values()]
      .filter((row) => row.state === 'listed' && row.listedAt !== null)
      .filter((row) => !filter?.marketMode || row.marketMode === filter.marketMode)
      .filter((row) => needle === null || row.displayName.toLowerCase().includes(needle))
      .filter((row) => {
        const at = row.listedAt as Date;
        return at > afterListedAt || (at.getTime() === afterListedAt.getTime() && row.leaderRef > afterRef);
      })
      .sort((a, b) => {
        const byTime = (a.listedAt as Date).getTime() - (b.listedAt as Date).getTime();
        return byTime !== 0 ? byTime : a.leaderRef < b.leaderRef ? -1 : a.leaderRef > b.leaderRef ? 1 : 0;
      })
      .slice(0, limit);
  }

  async countActive(leaderUserId: string): Promise<number> {
    return this.countActiveFollows(leaderUserId);
  }

  async insertEvent(event: StoredLeaderEvent): Promise<void> {
    this.events.push(event);
  }

  async insertCapacityFullOnce(listing: StoredLeaderListing, occurredAt: Date): Promise<void> {
    if (this.events.some((event) => event.leaderRef === listing.leaderRef && event.kind === 'capacity_full')) return;
    await this.insertEvent({
      eventId: randomUUID(),
      leaderRef: listing.leaderRef,
      kind: 'capacity_full',
      occurredAt,
      detail: { capacity: listing.capacity ?? 0 },
    });
  }

  async listEvents(
    leaderRef: string,
    since: Date,
    beforeAt: Date,
    beforeId: string,
    limit: number,
    hasCursor: boolean,
  ): Promise<StoredLeaderEvent[]> {
    return this.events
      .filter((event) => event.leaderRef === leaderRef && event.occurredAt > since)
      .filter((event) => {
        if (!hasCursor) return true;
        return event.occurredAt < beforeAt || (event.occurredAt.getTime() === beforeAt.getTime() && event.eventId < beforeId);
      })
      .sort((a, b) => {
        const byTime = b.occurredAt.getTime() - a.occurredAt.getTime();
        return byTime !== 0 ? byTime : a.eventId < b.eventId ? 1 : a.eventId > b.eventId ? -1 : 0;
      })
      .slice(0, limit);
  }

  async insertAudit(): Promise<void> {
    return undefined;
  }

  async loadRequest(clientRequestId: string): Promise<StoredRequest | null> {
    return this.requests.get(clientRequestId) ?? null;
  }

  async insertRequest(clientRequestId: string, kind: string, fp: string, result: OperatorListingResult): Promise<void> {
    if (this.requests.has(clientRequestId)) {
      const err = new Error('duplicate client_request_id') as Error & { code?: string };
      err.code = '23505';
      throw err;
    }
    this.requests.set(clientRequestId, { kind, fingerprint: fp, result });
  }
}

class SqlLeaderBackend implements LeaderBackend {
  readonly boundSql: Sql;

  constructor(private readonly sql: Sql) {
    this.boundSql = sql;
  }

  async transaction<T>(fn: (tx: LeaderBackend) => Promise<T>): Promise<T> {
    const begin = (this.sql as unknown as { begin?: (run: (tx: Sql) => Promise<T>) => Promise<T> }).begin;
    if (typeof begin !== 'function') return fn(this);
    return begin(async (tx) => fn(new SqlLeaderBackend(tx as unknown as Sql)));
  }

  async getByRef(leaderRef: string, lock: boolean): Promise<StoredLeaderListing | null> {
    return this.selectOne('leader_ref', leaderRef, lock);
  }

  async getByUser(leaderUserId: string, lock: boolean): Promise<StoredLeaderListing | null> {
    return this.selectOne('leader_user_id', leaderUserId, lock);
  }

  private async selectOne(column: 'leader_ref' | 'leader_user_id', value: string, lock: boolean): Promise<StoredLeaderListing | null> {
    const rows = await this.sql.unsafe<ListingSqlRow[]>(
      `SELECT ${LISTING_COLUMNS} FROM trade.copy_leader_listings WHERE ${column} = $1 LIMIT 1 ${lock ? 'FOR UPDATE' : ''}`,
      [value],
    );
    return rows[0] ? listingFromRow(rows[0]) : null;
  }

  async insertListing(row: StoredLeaderListing): Promise<void> {
    await this.sql`
      INSERT INTO trade.copy_leader_listings (
        leader_ref, leader_user_id, state, display_name, market_mode, record_kind,
        tenure_start, assets, capacity, strategy_version,
        published_return, maximum_drawdown, window_start, window_end,
        net_of_costs, evidence_ref, listed_at, state_changed_at, created_at, updated_at
      ) VALUES (
        ${row.leaderRef},
        ${row.leaderUserId},
        ${row.state},
        ${row.displayName},
        ${row.marketMode},
        ${row.recordKind},
        ${row.tenureStart},
        ${this.sql.json([...row.assets])},
        ${row.capacity},
        ${row.strategyVersion},
        ${row.publishedReturn},
        ${row.maximumDrawdown},
        ${row.windowStart},
        ${row.windowEnd},
        ${row.netOfCosts},
        ${row.evidenceRef},
        ${row.listedAt},
        ${row.stateChangedAt},
        ${row.createdAt},
        ${row.updatedAt}
      )
    `;
  }

  async updateListing(row: StoredLeaderListing): Promise<void> {
    await this.sql`
      UPDATE trade.copy_leader_listings SET
        state = ${row.state},
        display_name = ${row.displayName},
        market_mode = ${row.marketMode},
        record_kind = ${row.recordKind},
        tenure_start = ${row.tenureStart},
        assets = ${this.sql.json([...row.assets])},
        capacity = ${row.capacity},
        strategy_version = ${row.strategyVersion},
        published_return = ${row.publishedReturn},
        maximum_drawdown = ${row.maximumDrawdown},
        window_start = ${row.windowStart},
        window_end = ${row.windowEnd},
        net_of_costs = ${row.netOfCosts},
        evidence_ref = ${row.evidenceRef},
        listed_at = ${row.listedAt},
        state_changed_at = ${row.stateChangedAt},
        updated_at = ${row.updatedAt}
      WHERE leader_ref = ${row.leaderRef}
    `;
  }

  async listListed(afterListedAt: Date, afterRef: string, limit: number, filter?: ListedFilter): Promise<StoredLeaderListing[]> {
    const mode = filter?.marketMode ?? null;
    // ILIKE wildcards in the person's text are matched literally.
    const like = filter?.nameLike ? `%${filter.nameLike.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const rows = await this.sql<ListingSqlRow[]>`
      SELECT leader_ref, leader_user_id, state, display_name, market_mode, record_kind,
             tenure_start, assets, capacity, strategy_version,
             published_return, maximum_drawdown, window_start, window_end,
             net_of_costs, evidence_ref, listed_at, state_changed_at, created_at, updated_at
        FROM trade.copy_leader_listings
       WHERE state = 'listed'
         AND listed_at IS NOT NULL
         AND (${mode}::text IS NULL OR market_mode = ${mode})
         AND (${like}::text IS NULL OR display_name ILIKE ${like})
         AND (listed_at > ${afterListedAt} OR (listed_at = ${afterListedAt} AND leader_ref > ${afterRef}))
       ORDER BY listed_at ASC, leader_ref ASC
       LIMIT ${limit}
    `;
    return rows.map(listingFromRow);
  }

  async countActive(leaderUserId: string): Promise<number> {
    const [row] = await this.sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n
        FROM trade.copy_follows
       WHERE leader_id = ${leaderUserId}
         AND relationship_state = 'ACTIVE'
    `;
    return row?.n ?? 0;
  }

  async insertEvent(event: StoredLeaderEvent): Promise<void> {
    await this.sql`
      INSERT INTO trade.copy_leader_events (event_id, leader_ref, kind, occurred_at, published_detail)
      VALUES (
        ${event.eventId}::uuid,
        ${event.leaderRef},
        ${event.kind},
        ${event.occurredAt},
        ${this.sql.json(event.detail as unknown as Record<string, never>)}
      )
    `;
  }

  async insertCapacityFullOnce(listing: StoredLeaderListing, occurredAt: Date): Promise<void> {
    const capacity = listing.capacity ?? 0;
    const detail: LeaderEventDetail = { capacity };
    await this.sql`
      INSERT INTO trade.copy_leader_events (event_id, leader_ref, kind, occurred_at, published_detail)
      SELECT ${randomUUID()}::uuid, ${listing.leaderRef}, 'capacity_full', ${occurredAt}, ${this.sql.json(detail as unknown as Record<string, never>)}
       WHERE NOT EXISTS (
         SELECT 1 FROM trade.copy_leader_events
          WHERE leader_ref = ${listing.leaderRef} AND kind = 'capacity_full'
       )
    `;
  }

  async listEvents(
    leaderRef: string,
    since: Date,
    beforeAt: Date,
    beforeId: string,
    limit: number,
    hasCursor: boolean,
  ): Promise<StoredLeaderEvent[]> {
    void hasCursor;
    const rows = await this.sql<
      Array<{
        event_id: string;
        leader_ref: string;
        kind: CopyLeaderEventKind;
        occurred_at: Date | string;
        published_detail: LeaderEventDetail;
      }>
    >`
      SELECT event_id, leader_ref, kind, occurred_at, published_detail
        FROM trade.copy_leader_events
       WHERE leader_ref = ${leaderRef}
         AND occurred_at > ${since}
         AND occurred_at <= ${beforeAt}
         AND NOT (occurred_at = ${beforeAt} AND event_id >= ${beforeId}::uuid)
       ORDER BY occurred_at DESC, event_id DESC
       LIMIT ${limit}
    `;
    return rows.map((row) => ({
      eventId: row.event_id,
      leaderRef: row.leader_ref,
      kind: row.kind,
      occurredAt: asDate(row.occurred_at) ?? new Date(0),
      detail: row.published_detail,
    }));
  }

  async insertAudit(row: AuditInsert): Promise<void> {
    await this.sql`
      INSERT INTO trade.copy_leader_listing_audit (
        audit_id, operator_id, leader_ref, leader_user_id, occurred_at, action, client_request_id, reason, detail
      ) VALUES (
        ${row.auditId}::uuid,
        ${row.operatorId},
        ${row.leaderRef},
        ${row.leaderUserId},
        ${row.occurredAt},
        ${row.action},
        ${row.clientRequestId},
        ${row.reason},
        ${this.sql.json(row.detail as unknown as Record<string, never>)}
      )
    `;
  }

  async loadRequest(clientRequestId: string): Promise<StoredRequest | null> {
    const [row] = await this.sql<Array<{ kind: string; fingerprint: string; result: OperatorListingResult }>>`
      SELECT kind, fingerprint, result
        FROM trade.copy_leader_ops_requests
       WHERE client_request_id = ${clientRequestId}
       LIMIT 1
    `;
    return row ? { kind: row.kind, fingerprint: row.fingerprint, result: row.result } : null;
  }

  async insertRequest(clientRequestId: string, kind: string, fp: string, result: OperatorListingResult, at: Date): Promise<void> {
    await this.sql`
      INSERT INTO trade.copy_leader_ops_requests (client_request_id, kind, fingerprint, result, created_at)
      VALUES (${clientRequestId}, ${kind}, ${fp}, ${this.sql.json(result as unknown as Record<string, never>)}, ${at})
    `;
  }
}
