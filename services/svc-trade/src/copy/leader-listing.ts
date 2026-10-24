/**
 * Leader directory row (TRD-0026, TRD-0675, TRD-0662).
 *
 * The row is what an operator published. Return, drawdown, capacity and the
 * leader fee share are never computed or defaulted. A field the service does
 * not hold is null with a named reason.
 */

import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { CopyError, type CopyErrorCode } from './errors.js';
import { refuseCopyLeaderRanking } from './mirror.js';
import type { CopyFeeShareLaw } from './fee-share-law.js';

export const COPY_LEADER_RECORD_KINDS = ['verified_live', 'paper', 'backtest', 'imported', 'self_reported'] as const;
export type CopyLeaderRecordKind = (typeof COPY_LEADER_RECORD_KINDS)[number];

export const COPY_LEADER_LISTING_STATES = ['unlisted', 'listed', 'suspended', 'delisted'] as const;
export type CopyLeaderListingState = (typeof COPY_LEADER_LISTING_STATES)[number];

/** The market a leader trades in. The copy room's tabs filter the directory by it on the server. */
export const COPY_LEADER_MARKET_MODES = ['spot', 'futures', 'bot', 'signal'] as const;
export type CopyLeaderMarketMode = (typeof COPY_LEADER_MARKET_MODES)[number];

export const COPY_LEADER_CUSTOMER_STATUSES = ['listed', 'suspended', 'delisted', 'unknown'] as const;
export type CopyLeaderCustomerStatus = (typeof COPY_LEADER_CUSTOMER_STATUSES)[number];

export const LEADER_PAGE_LIMIT_MAX = 500;

/** Top-level keys a directory page may contain. No leader user id. */
export const LEADER_DIRECTORY_PAGE_KEYS = ['leaders', 'nextCursor'] as const;

/** Top-level keys one directory row may contain. No user id, followers, positions, fills or fees. */
export const LEADER_DIRECTORY_ROW_KEYS = [
  'leaderRef',
  'displayName',
  'marketMode',
  'recordKind',
  'tenureStart',
  'assets',
  'strategyVersion',
  'publishedReturn',
  'maximumDrawdown',
  'windowStart',
  'windowEnd',
  'netOfCosts',
  'copiersCount',
  'capacity',
  'leaderShareBps',
] as const;

const RANKING_KEYS = ['sort', 'order', 'orderBy', 'return', 'profit', 'copiers', 'rank', 'category', 'trending'] as const;

/** Longest name search the directory accepts. */
export const LEADER_SEARCH_MAX = 80;

export type Held<T, Reason extends string> =
  { readonly value: T; readonly reason: null } | { readonly value: null; readonly reason: Reason };

export type LeaderDirectoryRow = {
  readonly leaderRef: string;
  readonly displayName: string;
  readonly marketMode: CopyLeaderMarketMode;
  readonly recordKind: CopyLeaderRecordKind;
  readonly tenureStart: string | null;
  readonly assets: readonly string[];
  readonly strategyVersion: string | null;
  readonly publishedReturn: Held<string, 'no_published_record'>;
  readonly maximumDrawdown: Held<string, 'no_published_record'>;
  readonly windowStart: Held<string, 'no_published_record'>;
  readonly windowEnd: Held<string, 'no_published_record'>;
  readonly netOfCosts: Held<boolean, 'no_published_record'>;
  readonly copiersCount: number;
  readonly capacity: Held<number, 'capacity_unpublished'>;
  readonly leaderShareBps: Held<string, 'leader_share_unpublished'>;
};

export type LeaderDirectoryPage = {
  readonly leaders: readonly LeaderDirectoryRow[];
  readonly nextCursor: string | null;
};

export type StoredLeaderListing = {
  readonly leaderRef: string;
  readonly leaderUserId: string;
  readonly state: CopyLeaderListingState;
  readonly displayName: string;
  readonly marketMode: CopyLeaderMarketMode;
  readonly recordKind: CopyLeaderRecordKind;
  readonly tenureStart: Date | null;
  readonly assets: readonly string[];
  readonly capacity: number | null;
  readonly strategyVersion: string | null;
  readonly publishedReturn: string | null;
  readonly maximumDrawdown: string | null;
  readonly windowStart: Date | null;
  readonly windowEnd: Date | null;
  readonly netOfCosts: boolean | null;
  readonly evidenceRef: string | null;
  readonly listedAt: Date | null;
  readonly stateChangedAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
};

export type UpsertLeaderListingInput = {
  readonly clientRequestId?: string;
  readonly leaderUserId?: string;
  readonly displayName?: string;
  /** Omitted keeps the listing's mode; a new listing without one is a spot leader, the only mode copy places. */
  readonly marketMode?: string;
  readonly recordKind?: string;
  readonly state?: string;
  readonly tenureStart?: string | null;
  readonly assets?: readonly string[] | null;
  readonly capacity?: number | null;
  readonly strategyVersion?: string | null;
  readonly publishedReturn?: string | null;
  readonly maximumDrawdown?: string | null;
  readonly windowStart?: string | null;
  readonly windowEnd?: string | null;
  readonly netOfCosts?: boolean | null;
  readonly evidenceRef?: string | null;
};

export type NormalisedListingWrite = {
  readonly leaderUserId: string;
  readonly displayName: string;
  /** Null keeps the stored mode (spot for a new listing). */
  readonly marketMode: CopyLeaderMarketMode | null;
  readonly recordKind: CopyLeaderRecordKind;
  readonly state: CopyLeaderListingState;
  readonly tenureStart: Date | null;
  readonly assets: readonly string[];
  readonly capacity: number | null;
  readonly strategyVersion: string | null;
  readonly publishedReturn: string | null;
  readonly maximumDrawdown: string | null;
  readonly windowStart: Date | null;
  readonly windowEnd: Date | null;
  readonly netOfCosts: boolean | null;
  readonly evidenceRef: string | null;
};

export function publishedCopyPageLimit(value: number | undefined | null, code: CopyErrorCode, label: string): number {
  if (value === undefined || value === null || !Number.isInteger(value) || value < 1 || value > LEADER_PAGE_LIMIT_MAX) {
    throw new CopyError(`${label} limit is unset — refuse to invent a page size`, code);
  }
  return value;
}

/** Any sort or order parameter is a ranking, including return, profit and copiers. */
export function refuseLeaderDirectoryRanking(input: object | null | undefined): void {
  if (!input) return;
  const record = input as Record<string, unknown>;
  for (const key of RANKING_KEYS) {
    if (record[key] !== undefined && record[key] !== null) refuseCopyLeaderRanking();
  }
}

/**
 * The directory filter a person may send: one market mode and a name fragment. Blank text means no search.
 * Anything that is not a known mode, or text longer than LEADER_SEARCH_MAX, refuses rather than lists everyone.
 */
export function normaliseLeaderSearch(input: { readonly marketMode?: string | null; readonly q?: string | null }): {
  readonly marketMode: CopyLeaderMarketMode | null;
  readonly nameLike: string | null;
} {
  let marketMode: CopyLeaderMarketMode | null = null;
  if (input.marketMode !== undefined && input.marketMode !== null) {
    const mode = input.marketMode.trim();
    if (!(COPY_LEADER_MARKET_MODES as readonly string[]).includes(mode)) {
      throw new CopyError('marketMode is not a copy market mode', 'trade.copy_leader_mode_invalid');
    }
    marketMode = mode as CopyLeaderMarketMode;
  }
  const text = input.q?.trim() ?? '';
  if (text.length > LEADER_SEARCH_MAX) {
    throw new CopyError(`A leader search is at most ${LEADER_SEARCH_MAX} characters`, 'trade.copy_leader_search_invalid');
  }
  return { marketMode, nameLike: text ? text : null };
}

export function customerStatus(state: CopyLeaderListingState | null | undefined): CopyLeaderCustomerStatus {
  if (state === 'listed' || state === 'suspended' || state === 'delisted') return state;
  return 'unknown';
}

export function refuseNewMirrorForStatus(status: CopyLeaderCustomerStatus): void {
  if (status === 'suspended') {
    throw new CopyError(
      'This leader is suspended. New copies are stopped. Existing positions and the session permission stay as they are.',
      'trade.copy_leader_suspended',
    );
  }
  if (status === 'delisted') {
    throw new CopyError(
      'This leader is delisted. New copies are stopped. Existing positions and the session permission stay as they are.',
      'trade.copy_leader_delisted',
    );
  }
}

function blank(key: string): never {
  throw new CopyError(`${key} is blank — refuse rather than invent a value`, 'trade.copy_leader_record_blank');
}

function optionalText(value: string | null | undefined, key: string): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (!trimmed) blank(key);
  return trimmed;
}

function optionalDecimal(value: string | null | undefined, key: string): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (!trimmed) blank(key);
  try {
    return formatAmount(parseAmount(trimmed));
  } catch {
    throw new CopyError(`${key} must be an exact decimal string`, 'trade.copy_leader_record_blank');
  }
}

function optionalTime(value: string | null | undefined, key: string): Date | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (!trimmed) blank(key);
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) blank(key);
  return date;
}

export function requireClientRequestId(value: string | undefined): string {
  const trimmed = value?.trim() ?? '';
  if (!trimmed || trimmed.length > 200) {
    throw new CopyError('clientRequestId is unset', 'trade.copy_leader_request_unset');
  }
  return trimmed;
}

export function normaliseListingWrite(input: UpsertLeaderListingInput): NormalisedListingWrite {
  const leaderUserId = input.leaderUserId?.trim() ?? '';
  if (!leaderUserId) blank('leaderUserId');
  const displayName = input.displayName?.trim() ?? '';
  if (!displayName) blank('displayName');
  const recordKind = input.recordKind?.trim() ?? '';
  if (!(COPY_LEADER_RECORD_KINDS as readonly string[]).includes(recordKind)) {
    throw new CopyError('recordKind is unset', 'trade.copy_leader_record_blank');
  }
  let marketMode: CopyLeaderMarketMode | null = null;
  if (input.marketMode !== undefined) {
    const mode = input.marketMode.trim();
    if (!(COPY_LEADER_MARKET_MODES as readonly string[]).includes(mode)) {
      throw new CopyError('marketMode is not a copy market mode', 'trade.copy_leader_mode_invalid');
    }
    marketMode = mode as CopyLeaderMarketMode;
  }
  const state = input.state ?? 'unlisted';
  if (!(COPY_LEADER_LISTING_STATES as readonly string[]).includes(state)) {
    throw new CopyError('state is not a listing state', 'trade.copy_leader_state_invalid');
  }
  const evidenceRef = optionalText(input.evidenceRef, 'evidenceRef');
  if (recordKind === 'verified_live' && !evidenceRef) {
    throw new CopyError('verified_live requires an evidence reference', 'trade.copy_leader_evidence_unset');
  }
  let capacity: number | null = null;
  if (input.capacity !== undefined && input.capacity !== null) {
    if (typeof input.capacity !== 'number' || !Number.isInteger(input.capacity) || input.capacity < 0) {
      throw new CopyError('capacity must be a non-negative integer or omitted', 'trade.copy_leader_record_blank');
    }
    capacity = input.capacity;
  }
  const assets: string[] = [];
  if (input.assets !== undefined && input.assets !== null) {
    for (const item of input.assets) {
      const symbol = item.trim();
      if (!symbol) blank('assets');
      assets.push(symbol);
    }
  }
  return {
    leaderUserId,
    displayName,
    marketMode,
    recordKind: recordKind as CopyLeaderRecordKind,
    state: state as CopyLeaderListingState,
    tenureStart: optionalTime(input.tenureStart, 'tenureStart'),
    assets,
    capacity,
    strategyVersion: optionalText(input.strategyVersion, 'strategyVersion'),
    publishedReturn: optionalDecimal(input.publishedReturn, 'publishedReturn'),
    maximumDrawdown: optionalDecimal(input.maximumDrawdown, 'maximumDrawdown'),
    windowStart: optionalTime(input.windowStart, 'windowStart'),
    windowEnd: optionalTime(input.windowEnd, 'windowEnd'),
    netOfCosts: input.netOfCosts === undefined ? null : input.netOfCosts,
    evidenceRef,
  };
}

function heldText(value: string | null): Held<string, 'no_published_record'> {
  return value === null ? { value: null, reason: 'no_published_record' } : { value, reason: null };
}

function heldTime(value: Date | null): Held<string, 'no_published_record'> {
  return value === null ? { value: null, reason: 'no_published_record' } : { value: value.toISOString(), reason: null };
}

export function presentLeaderRow(listing: StoredLeaderListing, copiersCount: number, law: CopyFeeShareLaw): LeaderDirectoryRow {
  const row: LeaderDirectoryRow = {
    leaderRef: listing.leaderRef,
    displayName: listing.displayName,
    marketMode: listing.marketMode,
    recordKind: listing.recordKind,
    tenureStart: listing.tenureStart ? listing.tenureStart.toISOString() : null,
    assets: [...listing.assets],
    strategyVersion: listing.strategyVersion,
    publishedReturn: heldText(listing.publishedReturn),
    maximumDrawdown: heldText(listing.maximumDrawdown),
    windowStart: heldTime(listing.windowStart),
    windowEnd: heldTime(listing.windowEnd),
    netOfCosts: listing.netOfCosts === null ? { value: null, reason: 'no_published_record' } : { value: listing.netOfCosts, reason: null },
    copiersCount,
    capacity: listing.capacity === null ? { value: null, reason: 'capacity_unpublished' } : { value: listing.capacity, reason: null },
    leaderShareBps:
      law.published === true ? { value: String(law.leaderShareBps), reason: null } : { value: null, reason: 'leader_share_unpublished' },
  };
  const keys = Object.keys(row);
  if (keys.length !== LEADER_DIRECTORY_ROW_KEYS.length || LEADER_DIRECTORY_ROW_KEYS.some((key) => !keys.includes(key))) {
    throw new Error('leader directory row left the allowlist');
  }
  return row;
}

export function presentLeaderPage(leaders: readonly LeaderDirectoryRow[], nextCursor: string | null): LeaderDirectoryPage {
  return { leaders, nextCursor };
}

const CURSOR_EPOCH = new Date(0);

export function encodeListingCursor(listedAt: Date, leaderRef: string): string {
  return Buffer.from(`${listedAt.toISOString()}\n${leaderRef}`, 'utf8').toString('base64url');
}

export function decodeListingCursor(cursor: string | null | undefined): { readonly listedAt: Date; readonly leaderRef: string } {
  if (cursor === undefined || cursor === null || cursor === '') {
    return { listedAt: CURSOR_EPOCH, leaderRef: '' };
  }
  let raw: string;
  try {
    raw = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new CopyError('listLeaders cursor is not valid', 'trade.copy_leaders_cursor_invalid');
  }
  const split = raw.indexOf('\n');
  if (split <= 0) throw new CopyError('listLeaders cursor is not valid', 'trade.copy_leaders_cursor_invalid');
  const listedAt = new Date(raw.slice(0, split));
  const leaderRef = raw.slice(split + 1);
  if (Number.isNaN(listedAt.getTime()) || !leaderRef) {
    throw new CopyError('listLeaders cursor is not valid', 'trade.copy_leaders_cursor_invalid');
  }
  return { listedAt, leaderRef };
}

export function listingContentKey(
  row: Pick<
    StoredLeaderListing,
    | 'displayName'
    | 'marketMode'
    | 'recordKind'
    | 'tenureStart'
    | 'assets'
    | 'capacity'
    | 'publishedReturn'
    | 'maximumDrawdown'
    | 'windowStart'
    | 'windowEnd'
    | 'netOfCosts'
    | 'evidenceRef'
  >,
): string {
  return JSON.stringify({
    displayName: row.displayName,
    marketMode: row.marketMode,
    recordKind: row.recordKind,
    tenureStart: row.tenureStart?.toISOString() ?? null,
    assets: row.assets,
    capacity: row.capacity,
    publishedReturn: row.publishedReturn,
    maximumDrawdown: row.maximumDrawdown,
    windowStart: row.windowStart?.toISOString() ?? null,
    windowEnd: row.windowEnd?.toISOString() ?? null,
    netOfCosts: row.netOfCosts,
    evidenceRef: row.evidenceRef,
  });
}
