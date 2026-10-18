import type { Sql } from 'postgres';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import { ListQueryError, decodeListCursor, encodeListCursor } from '../list-page.js';
import { resolveWindow } from '../metrics/window.js';
import { SubMerchantError, type SubMerchantService } from '../submerchants.js';
import { requirePageLimit } from './series-cursor.js';
import { PortalError } from './errors.js';

const money = (value: string): string => formatAmount(parseAmount(value));

/**
 * PayFac child summary for `/pay/network/:child`.
 *
 * The node record is the existing subtree read (`merchant.profile`). Volume and
 * recent payments are included only when the caller holds `payment`. Grant
 * areas are included only when the caller holds `permission`. A missing area
 * is null, not an empty list, so "no payments" and "not granted" stay distinct.
 * Implicit root authority is not printed as a grant.
 */
export async function readSubMerchantSummary(
  sql: Sql,
  subMerchants: SubMerchantService,
  actorMerchantId: string,
  input: { merchantId: string; recentPaymentsLimit?: number; grantsLimit?: number; recentPaymentsCursor?: string },
) {
  const record = await subMerchants.getSubMerchant(actorMerchantId, input.merchantId);
  const [payment, permission] = await Promise.all([
    subMerchants.holds(actorMerchantId, input.merchantId, 'payment'),
    subMerchants.holds(actorMerchantId, input.merchantId, 'permission'),
  ]);
  const names = await sql<Array<{ display_name: string | null; legal_name: string | null }>>`
    SELECT display_name, legal_name FROM pay.merchants WHERE id = ${input.merchantId}`;
  let recentPayments: {
    items: Array<{ id: string; status: string; amount: string; assetId: string; createdAt: string }>;
    nextCursor: string | null;
  } | null = null;
  let volume: {
    window: { kind: 'preset'; preset: 'rolling_30d' };
    items: Array<{ assetCode: string; volume: string; count: number }>;
  } | null = null;
  if (payment) {
    const limit = pageLimit(input.recentPaymentsLimit, 'pay.submerchant_summary_limit_unset');
    const cursor = input.recentPaymentsCursor === undefined ? null : decodePaymentCursor(input.recentPaymentsCursor);
    const rows = await sql<Array<{ id: string; status: string; amount: string; currency: string; created_at: Date; cursor_ts: string }>>`
      SELECT id, status::text AS status, amount::text AS amount, currency, created_at,
             to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts
        FROM pay.payments
       WHERE merchant_id = ${input.merchantId}
         ${cursor ? sql`AND (created_at, id) < ((${cursor.createdAtCursor}::text)::timestamptz, ${cursor.id}::uuid)` : sql``}
       ORDER BY created_at DESC, id DESC
       LIMIT ${limit + 1}`;
    const hasMore = rows.length > limit;
    const kept = hasMore ? rows.slice(0, limit) : rows;
    const last = kept[kept.length - 1];
    recentPayments = {
      items: kept.map((row) => ({
        id: row.id,
        status: row.status,
        amount: money(row.amount),
        assetId: row.currency,
        createdAt: row.created_at.toISOString(),
      })),
      nextCursor: hasMore && last ? encodeListCursor(last.cursor_ts, last.id) : null,
    };
    const range = resolveWindow({ kind: 'preset', preset: 'rolling_30d' }, new Date());
    const totals = await sql<Array<{ asset_code: string; volume: string; count: number }>>`
      SELECT asset_code, sum(captured)::text AS volume, sum(captured_count)::int AS count
        FROM pay.metrics_merchant_day
       WHERE merchant_id = ${input.merchantId} AND day >= ${range.from}::date AND day < ${range.to}::date
       GROUP BY asset_code
      HAVING sum(captured_count) > 0 OR sum(captured) > 0
       ORDER BY asset_code`;
    volume = {
      window: { kind: 'preset', preset: 'rolling_30d' },
      items: totals.map((row) => ({ assetCode: row.asset_code, volume: money(row.volume), count: row.count })),
    };
  }
  let grants: { items: Array<{ area: string; granteeMerchantId: string }> } | null = null;
  if (permission) {
    const limit = pageLimit(input.grantsLimit, 'pay.submerchant_summary_grants_limit_unset');
    const listed = await subMerchants.listPermissions(actorMerchantId, input.merchantId, limit);
    grants = { items: listed.map((grant) => ({ area: grant.area, granteeMerchantId: grant.granteeMerchantId })) };
  }
  return {
    ...record,
    createdAt: record.createdAt.toISOString(),
    displayName: names[0]?.display_name ?? null,
    legalName: names[0]?.legal_name ?? null,
    volume,
    recentPayments,
    grants,
  };
}

function pageLimit(limit: number | undefined, code: `pay.${string}`): number {
  try {
    return requirePageLimit(limit, code);
  } catch (err) {
    if (err instanceof PortalError) {
      throw new SubMerchantError(
        err.code,
        code === 'pay.submerchant_summary_limit_unset'
          ? 'pay.submerchant_summary_limit_unset'
          : 'pay.submerchant_summary_grants_limit_unset',
      );
    }
    throw err;
  }
}

function decodePaymentCursor(raw: string) {
  try {
    return decodeListCursor(raw);
  } catch (err) {
    if (err instanceof ListQueryError) throw new SubMerchantError('List cursor is not valid', 'pay.list_cursor_invalid');
    throw err;
  }
}
