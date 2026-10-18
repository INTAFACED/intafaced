/**
 * Leader events a follower may read (TRD-0681).
 *
 * Append-only. The operator reason is not a field here. Detail is the
 * published listing fact only: no account id, no other followers, no fills.
 */

import { CopyError } from './errors.js';
import type { CopyLeaderListingState } from './leader-listing.js';

export const COPY_LEADER_EVENT_KINDS = [
  'listing_edited',
  'strategy_version_changed',
  'suspended',
  'resumed',
  'delisted',
  'capacity_full',
] as const;
export type CopyLeaderEventKind = (typeof COPY_LEADER_EVENT_KINDS)[number];

export const LEADER_EVENT_KEYS = ['eventId', 'leaderRef', 'kind', 'occurredAt', 'detail'] as const;
export const LEADER_EVENTS_PAGE_KEYS = ['events', 'nextCursor'] as const;

export type LeaderEventDetail =
  | { readonly displayName: string; readonly recordKind: string; readonly strategyVersion: string | null }
  | { readonly strategyVersion: string | null }
  | { readonly state: 'suspended' | 'listed' | 'delisted' }
  | { readonly capacity: number };

export type LeaderEventRow = {
  readonly eventId: string;
  readonly leaderRef: string;
  readonly kind: CopyLeaderEventKind;
  readonly occurredAt: string;
  readonly detail: LeaderEventDetail;
};

export type LeaderEventsPage = {
  readonly events: readonly LeaderEventRow[];
  readonly nextCursor: string | null;
};

export type StoredLeaderEvent = {
  readonly eventId: string;
  readonly leaderRef: string;
  readonly kind: CopyLeaderEventKind;
  readonly occurredAt: Date;
  readonly detail: LeaderEventDetail;
};

/** First time a leader becomes listed is the publish, not an event. Later state moves are. */
export function eventKindForStateChange(from: CopyLeaderListingState, to: CopyLeaderListingState): CopyLeaderEventKind | null {
  if (from === to) return null;
  if (to === 'suspended') return 'suspended';
  if (to === 'delisted') return 'delisted';
  if (to === 'listed' && (from === 'suspended' || from === 'delisted')) return 'resumed';
  return null;
}

export function stateEventDetail(kind: CopyLeaderEventKind): LeaderEventDetail | null {
  if (kind === 'suspended') return { state: 'suspended' };
  if (kind === 'delisted') return { state: 'delisted' };
  if (kind === 'resumed') return { state: 'listed' };
  return null;
}

export function presentLeaderEvent(event: StoredLeaderEvent): LeaderEventRow {
  const row: LeaderEventRow = {
    eventId: event.eventId,
    leaderRef: event.leaderRef,
    kind: event.kind,
    occurredAt: event.occurredAt.toISOString(),
    detail: event.detail,
  };
  const keys = Object.keys(row);
  if (keys.length !== LEADER_EVENT_KEYS.length || LEADER_EVENT_KEYS.some((key) => !keys.includes(key))) {
    throw new Error('leader event left the allowlist');
  }
  return row;
}

export function presentLeaderEventsPage(events: readonly LeaderEventRow[], nextCursor: string | null): LeaderEventsPage {
  return { events, nextCursor };
}

const FAR_FUTURE = new Date('9999-01-01T00:00:00.000Z');
const MAX_UUID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

export function encodeEventCursor(occurredAt: Date, eventId: string): string {
  return Buffer.from(`${occurredAt.toISOString()}\n${eventId}`, 'utf8').toString('base64url');
}

export function decodeEventCursor(cursor: string | null | undefined): {
  readonly occurredAt: Date;
  readonly eventId: string;
  readonly hasCursor: boolean;
} {
  if (cursor === undefined || cursor === null || cursor === '') {
    return { occurredAt: FAR_FUTURE, eventId: MAX_UUID, hasCursor: false };
  }
  let raw: string;
  try {
    raw = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new CopyError('followEvents cursor is not valid', 'trade.copy_leaders_cursor_invalid');
  }
  const split = raw.indexOf('\n');
  if (split <= 0) throw new CopyError('followEvents cursor is not valid', 'trade.copy_leaders_cursor_invalid');
  const occurredAt = new Date(raw.slice(0, split));
  const eventId = raw.slice(split + 1);
  if (Number.isNaN(occurredAt.getTime()) || !eventId) {
    throw new CopyError('followEvents cursor is not valid', 'trade.copy_leaders_cursor_invalid');
  }
  return { occurredAt, eventId, hasCursor: true };
}
