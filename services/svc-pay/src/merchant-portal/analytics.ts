import type { Sql } from 'postgres';
import { formatAmount, parseAmount } from '@intafaced/ledger-client';
import type { MerchantAreaFence } from '../merchant-ownership.js';
import { assertMerchantAreaAccess } from '../merchant-ownership.js';
import { allowMerchantRead } from '../merchant-read-access.js';
import type { MerchantReadPermission, MerchantTeamRead } from '../merchant-team-read.js';
import type { PayService } from '../payment-service.js';
import { resolveRange, type DayRange } from '../metrics/window.js';
import type { PermissionArea } from '../submerchants.js';
import { decodeSeriesCursor, encodeSeriesCursor, requirePageLimit, type SeriesCursor } from './series-cursor.js';
import { ListQueryError } from '../list-page.js';

type Bucket = 'day' | 'week';

export interface AnalyticsInput {
  merchantId: string;
  from: string;
  to: string;
  bucket: Bucket;
  limit?: number;
  cursor?: string;
  assetId?: string;
}

interface PointRow {
  period: string;
  asset_code: string;
  volume?: string;
  count?: number;
  gross?: string;
  fees?: string;
  net?: string;
  refunded?: string;
}

const money = (value: string): string => formatAmount(parseAmount(value));

function assetOf(assetId: string | undefined): string | null {
  if (assetId === undefined) return null;
  if (!/^[A-Za-z0-9._-]{1,16}$/.test(assetId)) {
    throw new ListQueryError('pay.list_asset_invalid', 'Asset filter is not a valid asset code');
  }
  return assetId;
}

/**
 * Volume (captured) and fees (settlement gross, fees, net, refunds) from the
 * merchant-day projection. Each row is one period and one asset. The query
 * groups by both, so two assets are never added together.
 *
 * Effective rate stays null: the projection stores fee totals, not the pricing
 * rule that produced them. Conversion cost is not on this projection.
 */
export class MerchantAnalyticsService {
  constructor(
    private readonly sql: Sql,
    private readonly pay: Pick<PayService, 'getMerchant' | 'getMerchantByUserId'>,
    private readonly trees: MerchantAreaFence | null,
    private readonly team: MerchantTeamRead,
  ) {}

  async volume(userId: string | undefined, input: AnalyticsInput) {
    await this.fence(userId, input.merchantId, 'payment', 'payments.read');
    const page = this.page(input);
    const read = await this.snapshot(input.merchantId, async (tx) => {
      const rows = await this.points(tx, input, page, 'volume');
      return { rows, freshness: await this.freshness(tx, input.merchantId) };
    });
    return this.pack(input, page.range, read.freshness, read.rows, (row) => ({
      period: row.period,
      assetCode: row.asset_code,
      count: row.count ?? 0,
      volume: money(row.volume ?? '0'),
    }));
  }

  async fees(userId: string | undefined, input: AnalyticsInput) {
    await this.fence(userId, input.merchantId, 'settlement', 'settlements.read');
    const page = this.page(input);
    const read = await this.snapshot(input.merchantId, async (tx) => {
      const rows = await this.points(tx, input, page, 'fees');
      return { rows, freshness: await this.freshness(tx, input.merchantId) };
    });
    const packed = this.pack(input, page.range, read.freshness, read.rows, (row) => ({
      period: row.period,
      assetCode: row.asset_code,
      gross: money(row.gross ?? '0'),
      fees: money(row.fees ?? '0'),
      net: money(row.net ?? '0'),
      refunded: money(row.refunded ?? '0'),
    }));
    return {
      ...packed,
      effectiveRate: null,
      effectiveRateReason: 'not_aggregated' as const,
      conversionCost: null,
      byRule: [],
    };
  }

  private page(input: AnalyticsInput) {
    return {
      limit: requirePageLimit(input.limit, 'pay.analytics_limit_unset'),
      cursor: input.cursor === undefined ? null : decodeSeriesCursor(input.cursor),
      asset: assetOf(input.assetId),
      range: resolveRange(input.from, input.to),
    };
  }

  private async fence(userId: string | undefined, merchantId: string, area: PermissionArea, permission: MerchantReadPermission) {
    await allowMerchantRead({
      ownerCheck: () => assertMerchantAreaAccess(this.pay, userId, merchantId, area, this.trees),
      team: this.team,
      userId,
      merchantId,
      permission,
    });
  }

  private async snapshot<T>(merchantId: string, fn: (tx: Sql) => Promise<T>): Promise<T> {
    void merchantId;
    return (await this.sql.begin('isolation level repeatable read read only', (tx) => fn(tx as unknown as Sql))) as T;
  }

  private async freshness(tx: Sql, merchantId: string) {
    const [row] = await tx<Array<{ oldest: Date | null; as_of_now: Date }>>`
      SELECT min(marked_at) AS oldest, now() AS as_of_now FROM pay.metrics_dirty WHERE merchant_id = ${merchantId}`;
    const now = row?.as_of_now ?? new Date();
    const asOf = row?.oldest ?? now;
    return { asOf: asOf.toISOString(), lagSeconds: Math.max(0, Math.trunc((now.getTime() - asOf.getTime()) / 1000)) };
  }

  private async points(
    tx: Sql,
    input: AnalyticsInput,
    page: { limit: number; cursor: SeriesCursor | null; asset: string | null; range: DayRange },
    kind: 'volume' | 'fees',
  ): Promise<PointRow[]> {
    const period = input.bucket === 'week' ? tx`date_trunc('week', day::timestamp)::date` : tx`day`;
    const asset = page.asset ? tx`AND asset_code = ${page.asset}` : tx``;
    const cursor = page.cursor ? tx`WHERE (period, asset_code) < (${page.cursor.period}::date, ${page.cursor.assetCode})` : tx``;
    if (kind === 'volume') {
      return tx<PointRow[]>`
        SELECT to_char(period, 'YYYY-MM-DD') AS period, asset_code, volume, count FROM (
          SELECT ${period} AS period, asset_code,
                 sum(captured)::text AS volume, sum(captured_count)::int AS count
            FROM pay.metrics_merchant_day
           WHERE merchant_id = ${input.merchantId}
             AND day >= ${page.range.from}::date AND day < ${page.range.to}::date
             ${asset}
           GROUP BY 1, asset_code
          HAVING sum(captured_count) > 0 OR sum(captured) > 0
        ) grouped
        ${cursor}
        ORDER BY period DESC, asset_code DESC
        LIMIT ${page.limit + 1}`;
    }
    return tx<PointRow[]>`
      SELECT to_char(period, 'YYYY-MM-DD') AS period, asset_code, gross, fees, net, refunded FROM (
        SELECT ${period} AS period, asset_code,
               sum(settle_gross)::text AS gross, sum(settle_fees)::text AS fees,
               sum(settle_net)::text AS net, sum(refunded)::text AS refunded
          FROM pay.metrics_merchant_day
         WHERE merchant_id = ${input.merchantId}
           AND day >= ${page.range.from}::date AND day < ${page.range.to}::date
           ${asset}
         GROUP BY 1, asset_code
        HAVING sum(settle_gross) > 0 OR sum(settle_fees) > 0 OR sum(settle_net) > 0 OR sum(refunded) > 0
      ) grouped
      ${cursor}
      ORDER BY period DESC, asset_code DESC
      LIMIT ${page.limit + 1}`;
  }

  private pack<T extends { period: string; assetCode: string }>(
    input: AnalyticsInput,
    range: DayRange,
    freshness: { asOf: string | null; lagSeconds: number | null },
    rows: PointRow[],
    map: (row: PointRow) => T,
  ) {
    const limit = requirePageLimit(input.limit, 'pay.analytics_limit_unset');
    const hasMore = rows.length > limit;
    const kept = hasMore ? rows.slice(0, limit) : rows;
    const last = kept[kept.length - 1];
    return {
      merchantId: input.merchantId,
      bucket: input.bucket,
      from: range.from,
      to: range.to,
      freshness,
      items: kept.map(map),
      nextCursor: hasMore && last ? encodeSeriesCursor(last.period, last.asset_code) : null,
    };
  }
}
