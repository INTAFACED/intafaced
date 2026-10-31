import type { Sql } from 'postgres';
import {
  PAY_PAYMENT_STATUSES,
  type FounderGlobalMetrics,
  type FounderMerchantList,
  type MerchantMetricsSeries,
  type MerchantMetricsSnapshot,
  type MerchantSettlementAssets,
  type MetricsFreshness,
  type PayAssetAmount,
  type PayMetricWindow,
} from '@intafaced/contracts';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { MetricsError, merchantNotFound } from './errors.js';
import { resolveRange, resolveWindow } from './window.js';

/** Live ledger reads. Balances are never copied into svc-pay (one money book). */
export interface BalanceReader {
  clearingBalance(merchantId: string, assetId: string): Promise<Amount>;
  merchantBalance(merchantId: string, assetId: string): Promise<Amount>;
}

export interface RailHealthRow {
  railId: string;
  ok: boolean;
  detail: string | null;
}

export interface MetricsReaderDeps {
  sql: Sql;
  balances: BalanceReader;
  /** Open fraud-review count, optionally for one merchant. The queue is a port; see runtime.ts. */
  openFraudReviews: (merchantId?: string) => number | Promise<number>;
  railHealth: () => RailHealthRow[];
  /**
   * The assets a business can settle in (`PAY_SETTLEMENT_ASSETS`, parsed by `parseSettlementAssets`). `null` or absent
   * is unset: `merchantSettlementAssets` refuses `pay.settlement_assets_unset` and never guesses a list.
   */
  settlementAssets?: readonly string[] | null;
  now?: () => Date;
}

const MERCHANT_STATUSES = ['pending', 'active', 'suspended', 'closed'] as const;
const KYB_STATUSES = ['none', 'pending', 'approved', 'rejected'] as const;

const amt = (v: string | null | undefined): Amount => parseAmount(v ?? '0');
const asAmount = (assetCode: string, v: Amount): PayAssetAmount => ({ assetCode, amount: formatAmount(v) });

/** Wire dates are ISO instants with an explicit `Z`. */
const iso = (d: Date) => d.toISOString();

function encodeCursor(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}
function decodeCursor(cursor: string): string {
  const id = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) throw new MetricsError('pay.metrics_cursor_invalid');
  return id;
}

/**
 * READS the projection (and the ledger for balances). Every response carries
 * `freshness`: `asOf` is the moment through which every committed source write is
 * reflected, and `lagSeconds` is how far behind that is. With nothing waiting to
 * be processed `asOf` is the read time and lag is 0; with marks waiting `asOf` is
 * the oldest unprocessed mark. The mark query and the figures are read in ONE
 * repeatable-read snapshot, so a figure never claims to be fresher than it is.
 */
export class MetricsReader {
  private readonly now: () => Date;
  constructor(private readonly deps: MetricsReaderDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  private async snapshot<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
    return (await this.deps.sql.begin('isolation level repeatable read read only', (tx) => fn(tx as unknown as Sql))) as T;
  }

  private async freshness(tx: Sql, merchantId?: string): Promise<MetricsFreshness> {
    const only = merchantId ? tx`WHERE merchant_id = ${merchantId}` : tx``;
    const [row] = await tx<
      Array<{ oldest: Date | null; now: Date }>
    >`SELECT min(marked_at) AS oldest, now() AS now FROM pay.metrics_dirty ${only}`;
    const now = row?.now ?? this.now();
    const asOf = row?.oldest ?? now;
    return { asOf: iso(asOf), lagSeconds: Math.max(0, Math.trunc((now.getTime() - asOf.getTime()) / 1000)) };
  }

  private async assertMerchantExists(tx: Sql, merchantId: string): Promise<void> {
    const rows = await tx`SELECT 1 FROM pay.merchants WHERE id = ${merchantId}`;
    if (rows.length === 0) throw merchantNotFound();
  }

  /** A merchant's figures over a window of whole UTC days. The caller has already been authorised for `merchantId`. */
  async merchantSnapshot(merchantId: string, window: PayMetricWindow): Promise<MerchantMetricsSnapshot> {
    const range = resolveWindow(window, this.now());
    const read = await this.snapshot(async (tx) => {
      await this.assertMerchantExists(tx, merchantId);
      const perAsset = await tx<
        Array<{
          asset_code: string;
          captured: string;
          captured_count: string;
          largest: string;
          refunded: string;
          settle_gross: string;
          settle_fees: string;
          settle_net: string;
          settle_count: string;
        }>
      >`
        SELECT asset_code, sum(captured)::text AS captured, sum(captured_count)::text AS captured_count,
               max(largest_captured)::text AS largest, sum(refunded)::text AS refunded,
               sum(settle_gross)::text AS settle_gross, sum(settle_fees)::text AS settle_fees,
               sum(settle_net)::text AS settle_net, sum(settle_count)::text AS settle_count
          FROM pay.metrics_merchant_day
         WHERE merchant_id = ${merchantId} AND day >= ${range.from}::date AND day < ${range.to}::date
         GROUP BY asset_code ORDER BY asset_code`;
      const mix = await tx<Array<{ status: string; payments: string }>>`
        SELECT status::text AS status, sum(payments)::text AS payments FROM pay.metrics_merchant_day_status
         WHERE merchant_id = ${merchantId} AND day >= ${range.from}::date AND day < ${range.to}::date GROUP BY status`;
      const [links] = await tx<Array<{ used: string; payments: string }>>`
        SELECT count(DISTINCT link_id)::text AS used, COALESCE(sum(payments), 0)::text AS payments FROM pay.metrics_merchant_day_link
         WHERE merchant_id = ${merchantId} AND day >= ${range.from}::date AND day < ${range.to}::date`;
      const assets = await tx<Array<{ asset_code: string }>>`
        SELECT DISTINCT asset_code FROM pay.metrics_merchant_day WHERE merchant_id = ${merchantId} ORDER BY asset_code`;
      return { perAsset, mix, links, assets, freshness: await this.freshness(tx, merchantId) };
    });

    const balances: MerchantMetricsSnapshot['balances'] = [];
    for (const { asset_code: assetCode } of read.assets) {
      try {
        balances.push({
          assetCode,
          clearing: formatAmount(await this.deps.balances.clearingBalance(merchantId, assetCode)),
          available: formatAmount(await this.deps.balances.merchantBalance(merchantId, assetCode)),
        });
      } catch {
        // Never invent a balance: if the ledger cannot be read, say so.
        throw new MetricsError('pay.metrics_balance_unavailable');
      }
    }

    const counts = new Map(read.mix.map((m) => [m.status, Number(m.payments)] as const));
    const statusMix = PAY_PAYMENT_STATUSES.map((status) => ({ status, count: counts.get(status) ?? 0 }));
    const settled = read.perAsset.filter((a) => Number(a.settle_count) > 0);
    const sold = read.perAsset.filter((a) => Number(a.captured_count) > 0);
    return {
      merchantId,
      window,
      freshness: read.freshness,
      balances,
      paymentCount: statusMix.reduce((n, s) => n + s.count, 0),
      statusMix,
      captured: read.perAsset.map((a) => asAmount(a.asset_code, amt(a.captured))),
      refunded: read.perAsset.map((a) => asAmount(a.asset_code, amt(a.refunded))),
      net: read.perAsset.map((a) => asAmount(a.asset_code, amt(a.captured) - amt(a.refunded))),
      settlements: settled.map((a) => ({
        assetCode: a.asset_code,
        gross: formatAmount(amt(a.settle_gross)),
        fees: formatAmount(amt(a.settle_fees)),
        net: formatAmount(amt(a.settle_net)),
      })),
      // Floor division of the exact scaled sum by the exact count: no float, no rounding up.
      averagePayment: sold.map((a) => asAmount(a.asset_code, amt(a.captured) / BigInt(a.captured_count))),
      largestPayment: sold.map((a) => asAmount(a.asset_code, amt(a.largest))),
      linkUsage: { linksUsed: Number(read.links?.used ?? 0), paymentsViaLinks: Number(read.links?.payments ?? 0) },
      feeRevenue: settled.map((a) => asAmount(a.asset_code, amt(a.settle_fees))),
      // Conversion (W6) has not landed; null, never zero.
      conversionVolume: null,
    };
  }

  /**
   * Every asset the business can settle in, each with its clearing and available figures read from the ledger now. A
   * zero here is the ledger's own answer for an account nothing has posted to, not a filled-in figure. The caller has
   * already been authorised for `merchantId`.
   */
  async merchantSettlementAssets(merchantId: string): Promise<MerchantSettlementAssets> {
    const enabled = this.deps.settlementAssets ?? null;
    if (!enabled || enabled.length === 0) throw new MetricsError('pay.settlement_assets_unset');
    await this.snapshot((tx) => this.assertMerchantExists(tx, merchantId));
    const asOf = iso(this.now());
    const assets: MerchantSettlementAssets['assets'] = [];
    for (const assetCode of enabled) {
      try {
        assets.push({
          assetCode,
          clearing: formatAmount(await this.deps.balances.clearingBalance(merchantId, assetCode)),
          available: formatAmount(await this.deps.balances.merchantBalance(merchantId, assetCode)),
        });
      } catch {
        // Never a zero for a balance that could not be read: the whole read refuses, no row is left half-filled.
        throw new MetricsError('pay.metrics_balance_unavailable');
      }
    }
    return { merchantId, asOf, assets };
  }

  /** Daily buckets of captured volume and fee revenue. */
  async merchantSeries(input: { merchantId: string; from: string; to: string }): Promise<MerchantMetricsSeries> {
    const range = resolveRange(input.from, input.to);
    const read = await this.snapshot(async (tx) => {
      await this.assertMerchantExists(tx, input.merchantId);
      const points = await tx<Array<{ day: string; asset_code: string; volume: string; fee_revenue: string }>>`
        SELECT day::text AS day, asset_code, captured::text AS volume, settle_fees::text AS fee_revenue
          FROM pay.metrics_merchant_day
         WHERE merchant_id = ${input.merchantId} AND day >= ${range.from}::date AND day < ${range.to}::date
           AND (captured_count > 0 OR settle_count > 0)
         ORDER BY day, asset_code`;
      return { points, freshness: await this.freshness(tx, input.merchantId) };
    });
    return {
      merchantId: input.merchantId,
      freshness: read.freshness,
      points: read.points.map((p) => ({
        day: p.day,
        assetCode: p.asset_code,
        volume: formatAmount(amt(p.volume)),
        feeRevenue: formatAmount(amt(p.fee_revenue)),
      })),
    };
  }

  /** Cross-merchant totals. Founder-only; the caller is authorised by `founderProcedure`. */
  async globalMetrics(window: PayMetricWindow): Promise<FounderGlobalMetrics> {
    const range = resolveWindow(window, this.now());
    const read = await this.snapshot(async (tx) => {
      const perAsset = await tx<Array<{ asset_code: string; volume: string; revenue: string }>>`
        SELECT asset_code, sum(captured)::text AS volume, sum(settle_fees)::text AS revenue FROM pay.metrics_merchant_day
         WHERE day >= ${range.from}::date AND day < ${range.to}::date GROUP BY asset_code ORDER BY asset_code`;
      const [active] = await tx<Array<{ n: string }>>`
        SELECT count(DISTINCT merchant_id)::text AS n FROM pay.metrics_merchant_day
         WHERE day >= ${range.from}::date AND day < ${range.to}::date AND captured_count > 0`;
      const pending = await tx<Array<{ asset_code: string; amount: string }>>`
        SELECT asset_code, sum(unsettled_net)::text AS amount FROM pay.metrics_merchant_day GROUP BY asset_code
        HAVING sum(unsettled_net) > 0 ORDER BY asset_code`;
      // The merchant table is small and already exact; counting it live cannot drift.
      const byStatus = await tx<
        Array<{ status: string; n: string }>
      >`SELECT status::text AS status, count(*)::text AS n FROM pay.merchants GROUP BY status`;
      const byKyb = await tx<
        Array<{ kyb: string; n: string }>
      >`SELECT kyb_status::text AS kyb, count(*)::text AS n FROM pay.merchants GROUP BY kyb_status`;
      return { perAsset, active, pending, byStatus, byKyb, freshness: await this.freshness(tx) };
    });
    const status = new Map(read.byStatus.map((r) => [r.status, Number(r.n)] as const));
    const kyb = new Map(read.byKyb.map((r) => [r.kyb, Number(r.n)] as const));
    return {
      freshness: read.freshness,
      volume: read.perAsset.map((a) => asAmount(a.asset_code, amt(a.volume))),
      revenue: read.perAsset.map((a) => asAmount(a.asset_code, amt(a.revenue))),
      activeMerchants: Number(read.active?.n ?? 0),
      // Captured and not yet settled (net of refunds), as of now - not windowed.
      pendingSettlement: read.pending.map((a) => asAmount(a.asset_code, amt(a.amount))),
      openFraudReviews: await this.deps.openFraudReviews(),
      pendingKyb: kyb.get('pending') ?? 0,
      onboardingFunnel: [
        ...MERCHANT_STATUSES.map((s) => ({ step: `status.${s}`, count: status.get(s) ?? 0 })),
        ...KYB_STATUSES.map((s) => ({ step: `kyb.${s}`, count: kyb.get(s) ?? 0 })),
      ],
      railHealth: this.deps.railHealth(),
    };
  }

  /** One merchant's row per page, lifetime volume and fee revenue. Keyset-paged on merchant id. */
  async merchantList(input: {
    limit: number;
    cursor?: string;
    filter?: { status?: string; tierId?: string; kybStatus?: string; merchantId?: string };
  }): Promise<FounderMerchantList> {
    const f = input.filter ?? {};
    if (f.tierId !== undefined) throw new MetricsError('pay.metrics_filter_unsupported');
    if (f.status !== undefined && !(MERCHANT_STATUSES as readonly string[]).includes(f.status))
      throw new MetricsError('pay.metrics_filter_invalid');
    if (f.kybStatus !== undefined && !(KYB_STATUSES as readonly string[]).includes(f.kybStatus))
      throw new MetricsError('pay.metrics_filter_invalid');
    const after = input.cursor ? decodeCursor(input.cursor) : null;

    const read = await this.snapshot(async (tx) => {
      const merchants = await tx<Array<{ id: string; status: string; kyb_status: string; display_name: string | null }>>`
        SELECT id, status::text AS status, kyb_status::text AS kyb_status, display_name FROM pay.merchants
         WHERE true
           ${after ? tx`AND id > ${after}::uuid` : tx``}
           ${f.merchantId ? tx`AND id = ${f.merchantId}::uuid` : tx``}
           ${f.status ? tx`AND status = ${f.status}::pay.merchant_status` : tx``}
           ${f.kybStatus ? tx`AND kyb_status = ${f.kybStatus}::pay.kyb_status` : tx``}
         ORDER BY id LIMIT ${input.limit + 1}`;
      const page = merchants.slice(0, input.limit);
      const totals = page.length
        ? await tx<Array<{ merchant_id: string; asset_code: string; volume: string; revenue: string }>>`
            SELECT merchant_id, asset_code, sum(captured)::text AS volume, sum(settle_fees)::text AS revenue
              FROM pay.metrics_merchant_day WHERE merchant_id = ANY(${tx.array(page.map((m) => m.id))}::uuid[])
             GROUP BY merchant_id, asset_code ORDER BY merchant_id, asset_code`
        : [];
      return { merchants, page, totals, freshness: await this.freshness(tx) };
    });
    const rows = await Promise.all(
      read.page.map(async (m) => {
        const mine = read.totals.filter((t) => t.merchant_id === m.id);
        return {
          merchantId: m.id,
          displayName: m.display_name,
          status: m.status,
          // Tiers belong to the control room (W1); until it lands there is no tier to report.
          tierId: null,
          kybStatus: m.kyb_status,
          volume: mine.filter((t) => amt(t.volume) > 0n).map((t) => asAmount(t.asset_code, amt(t.volume))),
          revenue: mine.filter((t) => amt(t.revenue) > 0n).map((t) => asAmount(t.asset_code, amt(t.revenue))),
          openFlags: await this.deps.openFraudReviews(m.id),
        };
      }),
    );
    const last = read.page[read.page.length - 1];
    return {
      freshness: read.freshness,
      rows,
      nextCursor: read.merchants.length > input.limit && last ? encodeCursor(last.id) : null,
    };
  }
}
