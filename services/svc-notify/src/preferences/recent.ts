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

export function encodeRecentCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`, 'utf8').toString('base64url');
}

export function decodeRecentCursor(cursor: string): { createdAt: Date; id: string } {
  let text = '';
  try {
    text = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw new RecentDeliveriesError('notify.recent_deliveries_cursor_invalid');
  }
  const pipe = text.indexOf('|');
  if (pipe <= 0 || pipe !== text.lastIndexOf('|')) {
    throw new RecentDeliveriesError('notify.recent_deliveries_cursor_invalid');
  }
  const createdAt = new Date(text.slice(0, pipe));
  const id = text.slice(pipe + 1);
  if (Number.isNaN(createdAt.getTime()) || !UUID.test(id)) {
    throw new RecentDeliveriesError('notify.recent_deliveries_cursor_invalid');
  }
  return { createdAt, id };
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
