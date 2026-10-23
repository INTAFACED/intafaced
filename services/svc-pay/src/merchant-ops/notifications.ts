import type { Sql } from 'postgres';
import { MerchantOpsError } from './errors.js';
import { iso } from './money.js';
import { decodeCursor, encodeCursor, requireLimit, toPage } from './pagination.js';
import { assertPermission, type MerchantCaller } from './roles.js';

/**
 * IN-APP NOTIFICATIONS ONLY. A row here is something a merchant sees when they
 * open the portal. Nothing in this file sends email or SMS, and there is no
 * address or phone column anywhere to send to.
 *
 * Read state is per merchant (one feed per merchant), not per teammate.
 * Preferences: a kind with no row is ON. A `threshold` is whatever the merchant
 * typed (decimal string); there is no default number.
 */
export const NOTIFICATION_KINDS = [
  'payout_awaiting_approval',
  'settlement_failed',
  'payout_failed',
  'limit_threshold',
  'dispute_opened',
  'dispute_due',
  'webhook_failing',
  'operator_pause',
  'export_ready',
  'team_change',
  'payout_destination',
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface NewNotification {
  readonly merchantId: string;
  readonly kind: NotificationKind;
  readonly title: string;
  readonly body?: string;
  readonly subjectType?: string;
  readonly subjectId?: string;
  /** Same key = same notification; a retried producer adds nothing. */
  readonly dedupeKey?: string;
}

/**
 * The producer door for other streams (W1 approvals, W5 halts, ...). Honors the
 * merchant's preference for the kind and is idempotent on `dedupeKey`.
 * Returns the new id, or null when the merchant turned the kind off or it was a repeat.
 */
export async function recordMerchantNotification(sql: Sql, n: NewNotification): Promise<string | null> {
  const pref = await sql<Array<{ in_app: boolean }>>`
    SELECT in_app FROM pay.merchant_notification_preferences WHERE merchant_id = ${n.merchantId} AND kind = ${n.kind}`;
  if (pref[0] && !pref[0].in_app) return null;
  const rows = await sql<Array<{ id: string }>>`
    INSERT INTO pay.merchant_notifications (merchant_id, kind, title, body, subject_type, subject_id, dedupe_key)
    VALUES (${n.merchantId}, ${n.kind}, ${n.title}, ${n.body ?? null}, ${n.subjectType ?? null}, ${n.subjectId ?? null}, ${n.dedupeKey ?? null})
    ON CONFLICT (merchant_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
    RETURNING id`;
  return rows[0]?.id ?? null;
}

export class NotificationService {
  constructor(private readonly sql: Sql) {}

  async list(
    caller: MerchantCaller,
    input: { limit?: number | undefined; cursor?: string; unreadOnly?: boolean; kind?: NotificationKind },
  ) {
    assertPermission(caller, 'notifications.read');
    const limit = requireLimit(input.limit);
    const after = decodeCursor(input.cursor);
    const sql = this.sql;
    type Row = {
      id: string;
      kind: string;
      title: string;
      body: string | null;
      subject_type: string | null;
      subject_id: string | null;
      created_at: Date;
      read_at: Date | null;
      cursor_ts: string;
    };
    const rows = await sql<Row[]>`
      SELECT id, kind, title, body, subject_type, subject_id, created_at, read_at,
             to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts
        FROM pay.merchant_notifications
       WHERE merchant_id = ${caller.merchantId}
         ${input.unreadOnly ? sql`AND read_at IS NULL` : sql``}
         ${input.kind ? sql`AND kind = ${input.kind}` : sql``}
         ${after ? sql`AND (created_at, id) < ((${after.ts}::text)::timestamptz, ${after.key}::uuid)` : sql``}
       ORDER BY created_at DESC, id DESC
       LIMIT ${limit + 1}`;
    return toPage(
      rows,
      limit,
      (r) => ({
        notificationId: r.id,
        kind: r.kind as NotificationKind,
        title: r.title,
        body: r.body,
        subjectType: r.subject_type,
        subjectId: r.subject_id,
        createdAt: iso(r.created_at),
        readAt: r.read_at ? iso(r.read_at) : null,
      }),
      (r) => encodeCursor(r.cursor_ts, r.id),
    );
  }

  async unreadCount(caller: MerchantCaller) {
    assertPermission(caller, 'notifications.read');
    const rows = await this.sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM pay.merchant_notifications WHERE merchant_id = ${caller.merchantId} AND read_at IS NULL`;
    return { unread: rows[0]!.n };
  }

  /** Mark specific notifications read. An id that is not this merchant's refuses exactly like one that does not exist. */
  async markRead(caller: MerchantCaller, ids: string[]) {
    assertPermission(caller, 'notifications.read');
    const unique = [...new Set(ids)];
    return this.sql.begin(async (tx) => {
      const owned = await tx<Array<{ id: string }>>`
        SELECT id FROM pay.merchant_notifications WHERE merchant_id = ${caller.merchantId} AND id IN ${tx(unique)} FOR UPDATE`;
      if (owned.length !== unique.length) throw new MerchantOpsError('pay.notification_not_found', 'not_found');
      const updated = await tx<Array<{ id: string }>>`
        UPDATE pay.merchant_notifications SET read_at = now(), read_by = ${caller.userId}
         WHERE merchant_id = ${caller.merchantId} AND id IN ${tx(unique)} AND read_at IS NULL RETURNING id`;
      return { marked: updated.length };
    });
  }

  async markAllRead(caller: MerchantCaller) {
    assertPermission(caller, 'notifications.read');
    const updated = await this.sql<Array<{ id: string }>>`
      UPDATE pay.merchant_notifications SET read_at = now(), read_by = ${caller.userId}
       WHERE merchant_id = ${caller.merchantId} AND read_at IS NULL RETURNING id`;
    return { marked: updated.length };
  }

  /** Every kind, with the merchant's choice or the on-by-default. */
  async preferences(caller: MerchantCaller) {
    assertPermission(caller, 'notifications.read');
    const rows = await this.sql<Array<{ kind: string; in_app: boolean; threshold: string | null; updated_by: string; updated_at: Date }>>`
      SELECT kind, in_app, threshold, updated_by, updated_at FROM pay.merchant_notification_preferences WHERE merchant_id = ${caller.merchantId}`;
    const byKind = new Map(rows.map((r) => [r.kind, r]));
    return NOTIFICATION_KINDS.map((kind) => {
      const r = byKind.get(kind);
      return {
        kind,
        inApp: r ? r.in_app : true,
        threshold: r?.threshold ?? null,
        updatedBy: r ? r.updated_by : null,
        updatedAt: r ? iso(r.updated_at) : null,
      };
    });
  }

  async setPreference(caller: MerchantCaller, input: { kind: NotificationKind; inApp: boolean; threshold?: string | null }) {
    assertPermission(caller, 'notifications.manage');
    if (input.threshold != null && input.kind !== 'limit_threshold')
      throw new MerchantOpsError('pay.notification_threshold_unsupported', 'bad_request');
    const threshold = input.threshold ?? null;
    // The current choice and its history row commit together, so the history never misses a change.
    await this.sql.begin(async (tx) => {
      await tx`
        INSERT INTO pay.merchant_notification_preferences (merchant_id, kind, in_app, threshold, updated_by)
        VALUES (${caller.merchantId}, ${input.kind}, ${input.inApp}, ${threshold}, ${caller.userId})
        ON CONFLICT (merchant_id, kind) DO UPDATE
          SET in_app = EXCLUDED.in_app, threshold = EXCLUDED.threshold, updated_by = EXCLUDED.updated_by, updated_at = now()`;
      await tx`
        INSERT INTO pay.merchant_notification_preference_events (merchant_id, kind, in_app, threshold, actor_id)
        VALUES (${caller.merchantId}, ${input.kind}, ${input.inApp}, ${threshold}, ${caller.userId})`;
    });
    return (await this.preferences(caller)).find((p) => p.kind === input.kind)!;
  }

  /** Every preference change, newest first: what was set, by whom and when. Changes before migration 0130 are not recorded. */
  async preferenceHistory(caller: MerchantCaller, input: { limit?: number | undefined; cursor?: string }) {
    assertPermission(caller, 'notifications.read');
    const limit = requireLimit(input.limit);
    const after = decodeCursor(input.cursor);
    // A key past bigint would fail inside Postgres; refuse it here by name like any other forged cursor.
    if (after && !(/^[0-9]{1,19}$/.test(after.key) && BigInt(after.key) <= 9223372036854775807n))
      throw new MerchantOpsError('pay.cursor_invalid', 'bad_request');
    const sql = this.sql;
    type Row = { seq_text: string; kind: string; in_app: boolean; threshold: string | null; actor_id: string; created_at: Date };
    const rows = await sql<Row[]>`
      SELECT seq::text AS seq_text, kind, in_app, threshold, actor_id, created_at
        FROM pay.merchant_notification_preference_events
       WHERE merchant_id = ${caller.merchantId}
         ${after ? sql`AND seq < ${after.key}::bigint` : sql``}
       ORDER BY seq DESC
       LIMIT ${limit + 1}`;
    return toPage(
      rows,
      limit,
      (r) => ({
        seq: r.seq_text,
        kind: r.kind as NotificationKind,
        inApp: r.in_app,
        threshold: r.threshold,
        actorId: r.actor_id,
        createdAt: iso(r.created_at),
      }),
      (r) => encodeCursor('1970-01-01T00:00:00.000000Z', r.seq_text),
    );
  }
}
