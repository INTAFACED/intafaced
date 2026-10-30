import type { Sql } from 'postgres';
import { maskDestination, safeDestinationLabel } from '../control/mask-destination.js';
import { MerchantOpsError } from './errors.js';
import { iso, money } from './money.js';
import { decodeCursor, encodeCursor, requireLimit, toPage } from './pagination.js';
import { assertPermission, type MerchantCaller } from './roles.js';

/**
 * Merchant activity (portal /pay/activity).
 *
 * A read of rows the merchant already owns: payment events, team changes, KYB
 * transitions, dispute evidence and responses, export jobs, payout approvals,
 * webhook endpoints and deliveries, and each payer detail a teammate unmasked
 * (who, which field; the reason stays in `payment.unmaskReads`). `pay.control_audit` is not a source. That
 * table is the founder control room (captured-over-cap, destination reads,
 * tier and pricing edits).
 *
 * Destinations are masked with the same function the approval view uses. Free
 * text (KYB reasons, dispute notes, webhook payloads, signing secrets) is not
 * selected. Detail keys are an allowlist applied again in process, so a new
 * column cannot leak by being named in SQL alone.
 */

export const ACTIVITY_OBJECT_TYPES = ['payment', 'team', 'kyb', 'dispute', 'export', 'approval', 'webhook'] as const;
export type ActivityObjectType = (typeof ACTIVITY_OBJECT_TYPES)[number];

const DETAIL_KEYS = new Set([
  'amount',
  'asset',
  'fromStatus',
  'toStatus',
  'role',
  'settlementId',
  'eventType',
  'attempts',
  'host',
  'fee',
  'status',
  'field',
]);
const DECIMAL = /^[0-9]+(\.[0-9]+)?$/;
const LABEL = /^[A-Za-z0-9._:@+-]{1,64}$/;

export interface ActivityItem {
  readonly id: string;
  readonly occurredAt: string;
  readonly actorId: string;
  readonly action: string;
  readonly objectType: ActivityObjectType;
  readonly objectId: string;
  readonly detail: Record<string, string>;
}

/** Keep allowlisted detail. Mask a destination if one was selected. Never copy the raw ref. */
export function projectActivityDetail(
  detail: Record<string, unknown> | null,
  destination: { kind: string; ref: string } | null,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (detail) {
    for (const [key, value] of Object.entries(detail)) {
      if (!DETAIL_KEYS.has(key) || typeof value !== 'string') continue;
      if ((key === 'amount' || key === 'fee') && DECIMAL.test(value)) out[key] = money(value);
      else if (key !== 'amount' && key !== 'fee' && LABEL.test(value)) out[key] = value;
    }
  }
  if (destination && destination.ref.trim().length > 0) {
    out.destinationKind = safeDestinationLabel(destination.kind, destination.ref);
    out.destinationMasked = maskDestination(destination.kind, destination.ref);
  }
  return out;
}

interface ActivityRow {
  id: string;
  cursor_ts: string;
  occurred_at: Date;
  actor_id: string;
  action: string;
  object_type: ActivityObjectType;
  object_id: string;
  detail: Record<string, unknown> | null;
  destination_kind: string | null;
  destination_ref: string | null;
}

export class ActivityFeed {
  constructor(private readonly sql: Sql) {}

  async list(
    caller: MerchantCaller,
    input: {
      limit?: number | undefined;
      cursor?: string;
      objectType?: ActivityObjectType;
      action?: string;
      actorId?: string;
      from?: string;
      to?: string;
      search?: string;
    },
  ) {
    assertPermission(caller, 'activity.read');
    const limit = requireLimit(input.limit);
    const after = decodeCursor(input.cursor);
    if (input.from && input.to && Date.parse(input.from) > Date.parse(input.to)) {
      throw new MerchantOpsError('pay.cursor_invalid', 'bad_request');
    }
    const sql = this.sql;
    const merchantId = caller.merchantId;
    const cap = limit + 1;
    /**
     * Each source stops at one page. The cursor, time window, and filters sit
     * inside the branch so a narrow page cannot scan that source's history.
     * `occurred`, `idCol`, `actionSql`, `actorSql`, and `objectIdSql` are fixed
     * column expressions, never caller text.
     */
    const bound = (
      objectType: ActivityObjectType,
      occurred: string,
      idCol: string,
      actionSql: string,
      actorSql: string,
      objectIdSql: string,
    ) => {
      const skipType = input.objectType !== undefined && input.objectType !== objectType;
      return sql`
        ${skipType ? sql`AND false` : sql``}
        ${after ? sql`AND (${sql.unsafe(occurred)}, ${sql.unsafe(idCol)}::text) < ((${after.ts}::text)::timestamptz, ${after.key})` : sql``}
        ${input.from ? sql`AND ${sql.unsafe(occurred)} >= (${input.from}::text)::timestamptz` : sql``}
        ${input.to ? sql`AND ${sql.unsafe(occurred)} < (${input.to}::text)::timestamptz` : sql``}
        ${input.action ? sql`AND (${sql.unsafe(actionSql)}) = ${input.action}` : sql``}
        ${input.actorId ? sql`AND (${sql.unsafe(actorSql)}) = ${input.actorId}` : sql``}
        ${input.search ? sql`AND (${sql.unsafe(objectIdSql)} = ${input.search} OR ${sql.unsafe(idCol)}::text = ${input.search})` : sql``}
        ORDER BY ${sql.unsafe(occurred)} DESC, ${sql.unsafe(idCol)} DESC
        LIMIT ${cap}`;
    };
    const paymentActor = `CASE WHEN coalesce(e.payload->>'actorUserId', '') ~ '^[A-Za-z0-9:_-]{1,128}$' THEN e.payload->>'actorUserId' ELSE 'system' END`;
    const kybActor = `CASE WHEN k.actor_scope LIKE 'pay:%' THEN k.actor_id ELSE 'intafaced' END`;
    const rows = await sql<ActivityRow[]>`
      WITH events AS (
        (
        SELECT e.id::text AS id, e.ts AS occurred_at,
               to_char(e.ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts,
               ${sql.unsafe(paymentActor)} AS actor_id,
               e.event AS action, 'payment'::text AS object_type, e.payment_id::text AS object_id,
               jsonb_strip_nulls(jsonb_build_object(
                 'amount', CASE WHEN e.payload->>'amount' ~ '^[0-9]+(\\.[0-9]+)?$' THEN e.payload->>'amount' ELSE NULL END,
                 'asset', CASE WHEN p.currency ~ '^[A-Za-z0-9._-]{1,16}$' THEN p.currency ELSE NULL END
               )) AS detail,
               NULL::text AS destination_kind, NULL::text AS destination_ref
          FROM pay.payment_events e
          JOIN pay.payments p ON p.id = e.payment_id
         WHERE p.merchant_id = ${merchantId}
         ${bound('payment', 'e.ts', 'e.id', 'e.event', paymentActor, 'e.payment_id::text')}
        )
        UNION ALL
        (
        SELECT u.id::text, u.created_at,
               to_char(u.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
               u.actor_id, 'payment.unmasked', 'payment', u.payment_id::text,
               jsonb_build_object('field', u.field, 'role', u.actor_role),
               NULL, NULL
          FROM pay.payment_unmask_reads u
         WHERE u.merchant_id = ${merchantId}
         ${bound('payment', 'u.created_at', 'u.id', `'payment.unmasked'`, 'u.actor_id', 'u.payment_id::text')}
        )
        UNION ALL
        (
        SELECT t.id::text, t.created_at,
               to_char(t.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
               t.actor_id, t.action, 'team', t.member_user_id,
               jsonb_strip_nulls(jsonb_build_object('role', t.to_role, 'fromStatus', t.from_role, 'toStatus', t.to_role)),
               NULL, NULL
          FROM pay.merchant_team_events t
         WHERE t.merchant_id = ${merchantId}
         ${bound('team', 't.created_at', 't.id', 't.action', 't.actor_id', 't.member_user_id')}
        )
        UNION ALL
        (
        SELECT k.id::text, k.created_at,
               to_char(k.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
               ${sql.unsafe(kybActor)}, k.to_status::text, 'kyb', k.id::text,
               jsonb_build_object('fromStatus', k.from_status::text, 'toStatus', k.to_status::text),
               NULL, NULL
          FROM pay.merchant_kyb_events k
         WHERE k.merchant_id = ${merchantId}
         ${bound('kyb', 'k.created_at', 'k.id', 'k.to_status::text', kybActor, 'k.id::text')}
        )
        UNION ALL
        (
        SELECT r.id::text, r.created_at,
               to_char(r.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
               r.responded_by, r.action, 'dispute', r.dispute_id,
               jsonb_build_object('status', r.resulting_status),
               NULL, NULL
          FROM pay.merchant_dispute_responses r
         WHERE r.merchant_id = ${merchantId}
         ${bound('dispute', 'r.created_at', 'r.id', 'r.action', 'r.responded_by', 'r.dispute_id')}
        )
        UNION ALL
        (
        SELECT v.id::text, v.created_at,
               to_char(v.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
               v.added_by, 'evidence_added', 'dispute', v.dispute_id,
               jsonb_build_object('status', v.kind),
               NULL, NULL
          FROM pay.merchant_dispute_evidence v
         WHERE v.merchant_id = ${merchantId}
         ${bound('dispute', 'v.created_at', 'v.id', `'evidence_added'`, 'v.added_by', 'v.dispute_id')}
        )
        UNION ALL
        (
        SELECT x.id::text, x.created_at,
               to_char(x.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
               x.requested_by, 'export_' || x.status, 'export', x.id::text,
               jsonb_build_object('status', x.status),
               NULL, NULL
          FROM pay.merchant_export_jobs x
         WHERE x.merchant_id = ${merchantId}
         ${bound('export', 'x.created_at', 'x.id', `'export_' || x.status`, 'x.requested_by', 'x.id::text')}
        )
        UNION ALL
        (
        SELECT a.id::text, a.created_at,
               to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
               a.maker_user_id, 'payout_' || a.status, 'approval', a.id::text,
               jsonb_strip_nulls(jsonb_build_object(
                 'status', a.status,
                 'settlementId', a.settlement_id::text,
                 'amount', a.amount::text,
                 'asset', a.asset_code
               )),
               a.destination_kind, a.destination_ref
          FROM pay.control_payout_approvals a
         WHERE a.merchant_id = ${merchantId}
         ${bound('approval', 'a.created_at', 'a.id', `'payout_' || a.status`, 'a.maker_user_id', 'a.id::text')}
        )
        UNION ALL
        (
        SELECT w.id::text, w.created_at,
               to_char(w.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
               'system', 'endpoint_' || w.status, 'webhook', w.id::text,
               jsonb_strip_nulls(jsonb_build_object('status', w.status, 'host', substring(w.url from '://([^/:]+)'))),
               NULL, NULL
          FROM pay.merchant_webhook_endpoints w
         WHERE w.merchant_id = ${merchantId}
         ${bound('webhook', 'w.created_at', 'w.id', `'endpoint_' || w.status`, `'system'`, 'w.id::text')}
        )
        UNION ALL
        (
        SELECT d.id::text, d.created_at,
               to_char(d.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
               'system', 'delivery_' || d.status, 'webhook', d.id::text,
               jsonb_build_object('status', d.status, 'eventType', d.event_type, 'attempts', d.attempts::text),
               NULL, NULL
          FROM pay.merchant_webhook_deliveries d
         WHERE d.merchant_id = ${merchantId}
         ${bound('webhook', 'd.created_at', 'd.id', `'delivery_' || d.status`, `'system'`, 'd.id::text')}
        )
      )
      SELECT id, cursor_ts, occurred_at, actor_id, action, object_type, object_id, detail, destination_kind, destination_ref
        FROM events
       ORDER BY occurred_at DESC, id DESC
       LIMIT ${cap}`;
    return toPage(rows, limit, toItem, (row) => encodeCursor(row.cursor_ts, row.id));
  }
}

function toItem(row: ActivityRow): ActivityItem {
  const destination = row.destination_ref && row.destination_kind ? { kind: row.destination_kind, ref: row.destination_ref } : null;
  return {
    id: row.id,
    occurredAt: iso(row.occurred_at),
    actorId: row.actor_id,
    action: row.action,
    objectType: row.object_type,
    objectId: row.object_id,
    detail: projectActivityDetail(row.detail, destination),
  };
}
