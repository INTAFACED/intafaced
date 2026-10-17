import type { Sql } from 'postgres';
import { MerchantOpsError } from './errors.js';
import { iso, money } from './money.js';
import { decodeCursor, encodeCursor, requireLimit, toPage } from './pagination.js';
import { assertPermission, type MerchantCaller } from './roles.js';

/**
 * CUSTOMER DIRECTORY, derived and never stored.
 *
 * A "customer" is an opaque reference the MERCHANT supplied: `customerRef` on a
 * payment (kept in the payment's `created` event), or `customer_id` on a
 * subscription or mandate. Nothing else about a person is known or kept here,
 * so there is nothing to leak beyond what the merchant already typed in.
 *
 * Because it is a projection of the merchant's own rows, every query starts
 * from `merchant_id = caller`, and a reference that only another merchant has
 * used is, to this caller, a reference that does not exist (M1/M2).
 *
 * Money: totals are summed from the append-only `captured` / `refunded` events
 * (the same source `payments` totals use) and returned as decimal strings, one
 * line per asset. Mixed assets are never added together.
 */

/** Every (reference, source row) this merchant has, as one fragment reused by each query. */
const refs = (sql: Sql, merchantId: string) => sql`
  SELECT e.payload->>'customerRef' AS ref, 'payment'::text AS source, p.id::text AS source_id, p.created_at AS seen_at
    FROM pay.payments p
    JOIN pay.payment_events e ON e.payment_id = p.id AND e.event = 'created'
   WHERE p.merchant_id = ${merchantId} AND length(btrim(coalesce(e.payload->>'customerRef', ''))) > 0
  UNION ALL
  SELECT s.customer_id, 'subscription', s.id::text, s.created_at
    FROM pay.subscriptions s WHERE s.merchant_id = ${merchantId} AND length(btrim(s.customer_id)) > 0
  UNION ALL
  SELECT m.customer_id, 'mandate', m.id::text, m.created_at
    FROM pay.subscription_mandates m WHERE m.merchant_id = ${merchantId} AND length(btrim(m.customer_id)) > 0`;

export interface CustomerTotals {
  readonly assetId: string;
  readonly capturedAmount: string;
  readonly refundedAmount: string;
  readonly paymentCount: number;
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export class CustomerDirectory {
  constructor(private readonly sql: Sql) {}

  async list(
    caller: MerchantCaller,
    input: { limit?: number | undefined; cursor?: string; search?: string; seenAfter?: string; seenBefore?: string },
  ) {
    assertPermission(caller, 'customers.read');
    const limit = requireLimit(input.limit);
    const after = decodeCursor(input.cursor);
    const sql = this.sql;
    type Row = {
      ref: string;
      payment_count: number;
      subscription_count: number;
      mandate_count: number;
      first_seen: Date;
      last_seen: Date;
      cursor_ts: string;
    };
    const rows = await sql<Row[]>`
      WITH r AS (${refs(sql, caller.merchantId)}),
      agg AS (
        SELECT ref,
               count(*) FILTER (WHERE source = 'payment')::int AS payment_count,
               count(*) FILTER (WHERE source = 'subscription')::int AS subscription_count,
               count(*) FILTER (WHERE source = 'mandate')::int AS mandate_count,
               min(seen_at) AS first_seen,
               max(seen_at) AS last_seen
          FROM r GROUP BY ref
      )
      SELECT ref, payment_count, subscription_count, mandate_count, first_seen, last_seen,
             to_char(last_seen AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_ts
        FROM agg
       WHERE true
         ${input.search ? sql`AND ref ILIKE ${escapeLike(input.search) + '%'}` : sql``}
         ${input.seenAfter ? sql`AND last_seen >= (${input.seenAfter}::text)::timestamptz` : sql``}
         ${input.seenBefore ? sql`AND last_seen < (${input.seenBefore}::text)::timestamptz` : sql``}
         ${after ? sql`AND (last_seen, ref) < ((${after.ts}::text)::timestamptz, ${after.key})` : sql``}
       ORDER BY last_seen DESC, ref DESC
       LIMIT ${limit + 1}`;
    const page = toPage(
      rows,
      limit,
      (x) => x,
      (x) => encodeCursor(x.cursor_ts, x.ref),
    );
    const totals = await this.totalsFor(
      caller.merchantId,
      page.items.map((x) => x.ref),
    );
    return {
      items: page.items.map((x) => ({
        customerRef: x.ref,
        paymentCount: x.payment_count,
        subscriptionCount: x.subscription_count,
        mandateCount: x.mandate_count,
        firstSeenAt: iso(x.first_seen),
        lastSeenAt: iso(x.last_seen),
        totals: totals.get(x.ref) ?? [],
      })),
      nextCursor: page.nextCursor,
    };
  }

  /** KPI strip: how many customers, how many seen since a date the caller chooses, how many came back. */
  async summary(caller: MerchantCaller, input: { activeSince: string }) {
    assertPermission(caller, 'customers.read');
    const sql = this.sql;
    const rows = await sql<Array<{ customers: number; active: number; repeat: number }>>`
      WITH r AS (${refs(sql, caller.merchantId)}),
      agg AS (SELECT ref, count(*) FILTER (WHERE source = 'payment') AS payments, max(seen_at) AS last_seen FROM r GROUP BY ref)
      SELECT count(*)::int AS customers,
             count(*) FILTER (WHERE last_seen >= (${input.activeSince}::text)::timestamptz)::int AS active,
             count(*) FILTER (WHERE payments >= 2)::int AS repeat
        FROM agg`;
    const r = rows[0]!;
    return { customerCount: r.customers, activeSinceCount: r.active, repeatCustomerCount: r.repeat, activeSince: input.activeSince };
  }

  async get(caller: MerchantCaller, input: { customerRef: string; recentPaymentsLimit?: number | undefined }) {
    assertPermission(caller, 'customers.read');
    const recentLimit = requireLimit(input.recentPaymentsLimit);
    const sql = this.sql;
    const found = await sql<
      Array<{ payment_count: number; subscription_count: number; mandate_count: number; first_seen: Date; last_seen: Date }>
    >`
      WITH r AS (${refs(sql, caller.merchantId)})
      SELECT count(*) FILTER (WHERE source = 'payment')::int AS payment_count,
             count(*) FILTER (WHERE source = 'subscription')::int AS subscription_count,
               count(*) FILTER (WHERE source = 'mandate')::int AS mandate_count,
             min(seen_at) AS first_seen, max(seen_at) AS last_seen
        FROM r WHERE ref = ${input.customerRef}
       HAVING count(*) > 0`;
    // Same refusal whether the reference is another merchant's or nobody's.
    if (!found[0]) throw new MerchantOpsError('pay.customer_not_found', 'not_found');
    const totals = (await this.totalsFor(caller.merchantId, [input.customerRef])).get(input.customerRef) ?? [];
    const recent = await sql<Array<{ id: string; status: string; currency: string; amount: string; created_at: Date }>>`
      WITH r AS (${refs(sql, caller.merchantId)})
      SELECT p.id, p.status, p.currency, p.amount::text, p.created_at
        FROM r JOIN pay.payments p ON p.id::text = r.source_id AND r.source = 'payment'
       WHERE r.ref = ${input.customerRef}
       ORDER BY p.created_at DESC, p.id DESC
       LIMIT ${recentLimit}`;
    return {
      customerRef: input.customerRef,
      paymentCount: found[0].payment_count,
      subscriptionCount: found[0].subscription_count,
      mandateCount: found[0].mandate_count,
      firstSeenAt: iso(found[0].first_seen),
      lastSeenAt: iso(found[0].last_seen),
      totals,
      recentPayments: recent.map((p) => ({
        paymentId: p.id,
        status: p.status,
        assetId: p.currency,
        amount: money(p.amount),
        createdAt: iso(p.created_at),
      })),
    };
  }

  private async totalsFor(merchantId: string, customerRefs: string[]): Promise<Map<string, CustomerTotals[]>> {
    const out = new Map<string, CustomerTotals[]>();
    if (customerRefs.length === 0) return out;
    const sql = this.sql;
    const rows = await sql<Array<{ ref: string; asset_id: string; captured: string; refunded: string; payments: number }>>`
      WITH r AS (${refs(sql, merchantId)}),
      pay_refs AS (SELECT DISTINCT ref, source_id FROM r WHERE source = 'payment' AND ref IN ${sql(customerRefs)})
      SELECT pr.ref, p.currency AS asset_id,
             coalesce(sum(CASE WHEN ev.event = 'captured' THEN (ev.payload->>'amount')::numeric END), 0)::text AS captured,
             coalesce(sum(CASE WHEN ev.event = 'refunded' THEN (ev.payload->>'amount')::numeric END), 0)::text AS refunded,
             count(DISTINCT p.id)::int AS payments
        FROM pay_refs pr
        JOIN pay.payments p ON p.id::text = pr.source_id AND p.merchant_id = ${merchantId}
        LEFT JOIN pay.payment_events ev ON ev.payment_id = p.id AND ev.event IN ('captured', 'refunded')
       GROUP BY pr.ref, p.currency
       ORDER BY pr.ref, p.currency`;
    for (const row of rows) {
      const list = out.get(row.ref) ?? [];
      list.push({
        assetId: row.asset_id,
        capturedAmount: money(row.captured),
        refundedAmount: money(row.refunded),
        paymentCount: row.payments,
      });
      out.set(row.ref, list);
    }
    return out;
  }
}
