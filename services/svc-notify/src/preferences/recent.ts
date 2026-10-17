/**
 * One page of the caller's own finished deliveries.
 * `accepted` is `sent` (a transport took it). `abandoned` counts as `failed`.
 * `pending` is still in flight and is not on this page.
 */

import type { DeliveryRecord, DeliveryStatus } from '../channel-store.js';

export const RECENT_DELIVERIES_LIMIT_MAX = 50;

export type RecentOutcome = 'sent' | 'refused' | 'failed';

export class RecentDeliveriesError extends Error {
  constructor(readonly code: 'notify.recent_deliveries_limit_invalid' | 'notify.recent_deliveries_cursor_invalid') {
    super(code);
    this.name = 'RecentDeliveriesError';
  }
}

export function clampRecentDeliveriesLimit(limit: number): number {
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
    throw new RecentDeliveriesError('notify.recent_deliveries_limit_invalid');
  }
  return Math.min(limit, RECENT_DELIVERIES_LIMIT_MAX);
}

export function recentOutcome(status: DeliveryStatus): RecentOutcome | null {
  if (status === 'accepted') return 'sent';
  if (status === 'refused') return 'refused';
  if (status === 'failed' || status === 'abandoned') return 'failed';
  return null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The previous page's last delivery id. The timestamp stays in the database. */
export function encodeRecentCursor(row: { id: string }): string {
  return Buffer.from(row.id, 'utf8').toString('base64url');
}

export function decodeRecentCursor(cursor: string): string {
  let text = '';
  try {
    text = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new RecentDeliveriesError('notify.recent_deliveries_cursor_invalid');
  }
  if (!UUID.test(text)) throw new RecentDeliveriesError('notify.recent_deliveries_cursor_invalid');
  return text;
}

export function recentDeliveryWire(row: DeliveryRecord) {
  const outcome = recentOutcome(row.status);
  if (!outcome) return null;
  return {
    notificationId: row.notificationId,
    channel: row.channel,
    status: row.status,
    outcome,
    attempts: row.attempts,
    attemptedAt: row.attemptedAt?.toISOString() ?? null,
    acceptedAt: row.acceptedAt?.toISOString() ?? null,
    refusalCode: row.refusalCode,
  };
}
