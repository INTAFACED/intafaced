import type { Sql } from 'postgres';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';

/**
 * THE ONE DEFINITION OF EVERY PROJECTED FIGURE.
 *
 * `computeFromSource` is the only code that turns payments, payment events,
 * settlements and checkout sessions into projection rows. The refresher, the
 * rebuild job and the reconcile check all call it, so "what the projection should
 * say" has one answer. Nothing here adds or subtracts incrementally: a merchant-day
 * is always recomputed whole, which is why it cannot drift.
 *
 * Money is `numeric(38,18)` in Postgres, scaled bigint (10^18) here, decimal
 * strings on the wire. There is no `number` anywhere near an amount; the only
 * `number`s are row counts.
 */

export interface MetricsKey {
  readonly merchantId: string;
  /** UTC calendar day, `YYYY-MM-DD`. */
  readonly day: string;
}

export interface MerchantDayRow extends MetricsKey {
  readonly assetCode: string;
  readonly paymentsCreated: number;
  readonly captured: Amount;
  readonly capturedCount: number;
  readonly largestCaptured: Amount;
  readonly refunded: Amount;
  readonly refundedCount: number;
  readonly settleGross: Amount;
  readonly settleFees: Amount;
  readonly settleNet: Amount;
  readonly settleCount: number;
  readonly unsettledNet: Amount;
}
export interface StatusRow extends MetricsKey {
  readonly status: string;
  readonly payments: number;
}
export interface LinkRow extends MetricsKey {
  readonly linkId: string;
  readonly payments: number;
}
export interface DayProjection {
  readonly days: MerchantDayRow[];
  readonly statuses: StatusRow[];
  readonly links: LinkRow[];
}

export const emptyProjection = (): DayProjection => ({ days: [], statuses: [], links: [] });

const keyArrays = (keys: readonly MetricsKey[]) => ({ ids: keys.map((k) => k.merchantId), days: keys.map((k) => k.day) });

/** Rows exactly as `computeFromSource` / `readProjection` select them. */
interface DayRaw {
  merchant_id: string;
  day: string;
  asset_code: string;
  payments_created: number;
  captured: string;
  captured_count: number;
  largest_captured: string;
  refunded: string;
  refunded_count: number;
  settle_gross: string;
  settle_fees: string;
  settle_net: string;
  settle_count: number;
  unsettled_net: string;
}
const dayRow = (r: DayRaw): MerchantDayRow => ({
  merchantId: r.merchant_id,
  day: r.day,
  assetCode: r.asset_code,
  paymentsCreated: Number(r.payments_created),
  captured: parseAmount(r.captured),
  capturedCount: Number(r.captured_count),
  largestCaptured: parseAmount(r.largest_captured),
  refunded: parseAmount(r.refunded),
  refundedCount: Number(r.refunded_count),
  settleGross: parseAmount(r.settle_gross),
  settleFees: parseAmount(r.settle_fees),
  settleNet: parseAmount(r.settle_net),
  settleCount: Number(r.settle_count),
  unsettledNet: parseAmount(r.unsettled_net),
});
const statusRow = (r: { merchant_id: string; day: string; status: string; payments: number }): StatusRow => ({
  merchantId: r.merchant_id,
  day: r.day,
  status: r.status,
  payments: Number(r.payments),
});
const linkRow = (r: { merchant_id: string; day: string; link_id: string; payments: number }): LinkRow => ({
  merchantId: r.merchant_id,
  day: r.day,
  linkId: r.link_id,
  payments: Number(r.payments),
});

/**
 * Recompute the projection rows for `keys` from the source tables.
 *
 * Bucketing (UTC days, half-open):
 *   payments_created, status mix, link usage, unsettled_net -> payments.created_at
 *   captured, captured_count, largest_captured              -> the `captured` event's ts
 *   refunded, refunded_count                                -> the day the payment was FIRST
 *                                                              captured (refund cohort, so a
 *                                                              window's net is never negative)
 *   settle_*                                                -> settlements.created_at, only
 *                                                              status posted | paid_out
 * `captured` / `refunded` amounts are the `payload.amount` decimal strings the
 * payment service writes, summed as exact `numeric`.
 */
export async function computeFromSource(sql: Sql, keys: readonly MetricsKey[]): Promise<DayProjection> {
  if (keys.length === 0) return emptyProjection();
  const { ids, days } = keyArrays(keys);
  const k = sql`
    k AS (
      SELECT t.merchant_id, t.day,
             (t.day::timestamp AT TIME ZONE 'UTC') AS t0,
             ((t.day + 1)::timestamp AT TIME ZONE 'UTC') AS t1
        FROM unnest(${sql.array(ids)}::uuid[], ${sql.array(days)}::date[]) AS t(merchant_id, day)
    )`;

  const dayRows = await sql<DayRaw[]>`
    WITH ${k},
    cr AS (
      SELECT k.merchant_id, k.day, p.currency AS asset_code, count(*)::int AS payments_created
        FROM k JOIN pay.payments p ON p.merchant_id = k.merchant_id AND p.created_at >= k.t0 AND p.created_at < k.t1
       GROUP BY 1, 2, 3
    ),
    ev AS (
      SELECT k.merchant_id, k.day, p.currency AS asset_code,
             sum((e.payload->>'amount')::numeric) AS captured,
             count(*)::int AS captured_count,
             max((e.payload->>'amount')::numeric) AS largest_captured
        FROM k
        JOIN pay.payment_events e ON e.event = 'captured' AND e.ts >= k.t0 AND e.ts < k.t1
        JOIN pay.payments p ON p.id = e.payment_id AND p.merchant_id = k.merchant_id
       GROUP BY 1, 2, 3
    ),
    cohort AS (
      SELECT k.merchant_id, k.day, p.id AS payment_id, p.currency AS asset_code
        FROM k
        JOIN pay.payment_events e ON e.event = 'captured' AND e.ts >= k.t0 AND e.ts < k.t1
        JOIN pay.payments p ON p.id = e.payment_id AND p.merchant_id = k.merchant_id
       WHERE NOT EXISTS (
         SELECT 1 FROM pay.payment_events e2 WHERE e2.payment_id = e.payment_id AND e2.event = 'captured' AND e2.ts < e.ts
       )
       GROUP BY 1, 2, 3, 4
    ),
    rf AS (
      SELECT c.merchant_id, c.day, c.asset_code,
             sum((r.payload->>'amount')::numeric) AS refunded, count(*)::int AS refunded_count
        FROM cohort c JOIN pay.payment_events r ON r.payment_id = c.payment_id AND r.event = 'refunded'
       GROUP BY 1, 2, 3
    ),
    un AS (
      SELECT k.merchant_id, k.day, p.currency AS asset_code,
             sum(COALESCE(cap.s, 0) - COALESCE(ref.s, 0)) AS unsettled_net
        FROM k
        JOIN pay.payments p ON p.merchant_id = k.merchant_id AND p.created_at >= k.t0 AND p.created_at < k.t1 AND p.status = 'captured'
        LEFT JOIN LATERAL (
          SELECT sum((x.payload->>'amount')::numeric) AS s FROM pay.payment_events x WHERE x.payment_id = p.id AND x.event = 'captured'
        ) cap ON true
        LEFT JOIN LATERAL (
          SELECT sum((x.payload->>'amount')::numeric) AS s FROM pay.payment_events x WHERE x.payment_id = p.id AND x.event = 'refunded'
        ) ref ON true
       GROUP BY 1, 2, 3
    ),
    st AS (
      SELECT k.merchant_id, k.day, s.asset_id AS asset_code,
             sum(s.gross) AS settle_gross, sum(s.fees) AS settle_fees, sum(s.net) AS settle_net, count(*)::int AS settle_count
        FROM k JOIN pay.settlements s
          ON s.merchant_id = k.merchant_id AND s.created_at >= k.t0 AND s.created_at < k.t1 AND s.status IN ('posted', 'paid_out')
       GROUP BY 1, 2, 3
    ),
    allk AS (
      SELECT merchant_id, day, asset_code FROM cr UNION
      SELECT merchant_id, day, asset_code FROM ev UNION
      SELECT merchant_id, day, asset_code FROM rf UNION
      SELECT merchant_id, day, asset_code FROM un UNION
      SELECT merchant_id, day, asset_code FROM st
    )
    SELECT a.merchant_id, a.day::text AS day, a.asset_code,
           COALESCE(cr.payments_created, 0) AS payments_created,
           COALESCE(ev.captured, 0)::text AS captured,
           COALESCE(ev.captured_count, 0) AS captured_count,
           COALESCE(ev.largest_captured, 0)::text AS largest_captured,
           COALESCE(rf.refunded, 0)::text AS refunded,
           COALESCE(rf.refunded_count, 0) AS refunded_count,
           COALESCE(st.settle_gross, 0)::text AS settle_gross,
           COALESCE(st.settle_fees, 0)::text AS settle_fees,
           COALESCE(st.settle_net, 0)::text AS settle_net,
           COALESCE(st.settle_count, 0) AS settle_count,
           COALESCE(un.unsettled_net, 0)::text AS unsettled_net
      FROM allk a
      LEFT JOIN cr USING (merchant_id, day, asset_code)
      LEFT JOIN ev USING (merchant_id, day, asset_code)
      LEFT JOIN rf USING (merchant_id, day, asset_code)
      LEFT JOIN un USING (merchant_id, day, asset_code)
      LEFT JOIN st USING (merchant_id, day, asset_code)
     ORDER BY a.merchant_id, a.day, a.asset_code
  `;

  const statusRows = await sql<Array<{ merchant_id: string; day: string; status: string; payments: number }>>`
    WITH ${k}
    SELECT k.merchant_id, k.day::text AS day, p.status::text AS status, count(*)::int AS payments
      FROM k JOIN pay.payments p ON p.merchant_id = k.merchant_id AND p.created_at >= k.t0 AND p.created_at < k.t1
     GROUP BY 1, 2, 3 ORDER BY 1, 2, 3
  `;

  const linkRows = await sql<Array<{ merchant_id: string; day: string; link_id: string; payments: number }>>`
    WITH ${k}
    SELECT k.merchant_id, k.day::text AS day, cs.link_id, count(DISTINCT p.id)::int AS payments
      FROM k
      JOIN pay.payments p ON p.merchant_id = k.merchant_id AND p.created_at >= k.t0 AND p.created_at < k.t1
      JOIN pay.checkout_sessions cs ON cs.payment_id = p.id
     WHERE EXISTS (SELECT 1 FROM pay.payment_events e WHERE e.payment_id = p.id AND e.event = 'captured')
     GROUP BY 1, 2, 3 ORDER BY 1, 2, 3
  `;

  return { days: dayRows.map(dayRow), statuses: statusRows.map(statusRow), links: linkRows.map(linkRow) };
}

/** What the projection tables currently say for `keys`. */
export async function readProjection(sql: Sql, keys: readonly MetricsKey[]): Promise<DayProjection> {
  if (keys.length === 0) return emptyProjection();
  const { ids, days } = keyArrays(keys);
  const k = sql`k AS (SELECT t.merchant_id, t.day FROM unnest(${sql.array(ids)}::uuid[], ${sql.array(days)}::date[]) AS t(merchant_id, day))`;
  const dayRows = await sql<DayRaw[]>`
    WITH ${k}
    SELECT m.merchant_id, m.day::text AS day, m.asset_code, m.payments_created,
           m.captured::text, m.captured_count, m.largest_captured::text, m.refunded::text, m.refunded_count,
           m.settle_gross::text, m.settle_fees::text, m.settle_net::text, m.settle_count, m.unsettled_net::text
      FROM pay.metrics_merchant_day m JOIN k ON k.merchant_id = m.merchant_id AND k.day = m.day
     ORDER BY m.merchant_id, m.day, m.asset_code
  `;
  const statusRows = await sql<Array<{ merchant_id: string; day: string; status: string; payments: number }>>`
    WITH ${k}
    SELECT m.merchant_id, m.day::text AS day, m.status::text AS status, m.payments
      FROM pay.metrics_merchant_day_status m JOIN k ON k.merchant_id = m.merchant_id AND k.day = m.day
     ORDER BY 1, 2, 3
  `;
  const linkRows = await sql<Array<{ merchant_id: string; day: string; link_id: string; payments: number }>>`
    WITH ${k}
    SELECT m.merchant_id, m.day::text AS day, m.link_id, m.payments
      FROM pay.metrics_merchant_day_link m JOIN k ON k.merchant_id = m.merchant_id AND k.day = m.day
     ORDER BY 1, 2, 3
  `;
  return { days: dayRows.map(dayRow), statuses: statusRows.map(statusRow), links: linkRows.map(linkRow) };
}

/** Replace one merchant-day's projection rows with `next`. Call inside the key's transaction. */
export async function replaceProjection(tx: Sql, key: MetricsKey, next: DayProjection): Promise<void> {
  await tx`DELETE FROM pay.metrics_merchant_day WHERE merchant_id = ${key.merchantId} AND day = ${key.day}::date`;
  await tx`DELETE FROM pay.metrics_merchant_day_status WHERE merchant_id = ${key.merchantId} AND day = ${key.day}::date`;
  await tx`DELETE FROM pay.metrics_merchant_day_link WHERE merchant_id = ${key.merchantId} AND day = ${key.day}::date`;
  for (const r of next.days) {
    await tx`
      INSERT INTO pay.metrics_merchant_day (
        merchant_id, day, asset_code, payments_created, captured, captured_count, largest_captured, refunded, refunded_count,
        settle_gross, settle_fees, settle_net, settle_count, unsettled_net
      ) VALUES (
        ${r.merchantId}, ${r.day}::date, ${r.assetCode}, ${r.paymentsCreated}, ${formatAmount(r.captured)}::numeric, ${r.capturedCount},
        ${formatAmount(r.largestCaptured)}::numeric, ${formatAmount(r.refunded)}::numeric, ${r.refundedCount},
        ${formatAmount(r.settleGross)}::numeric, ${formatAmount(r.settleFees)}::numeric, ${formatAmount(r.settleNet)}::numeric,
        ${r.settleCount}, ${formatAmount(r.unsettledNet)}::numeric
      )`;
  }
  for (const r of next.statuses) {
    await tx`
      INSERT INTO pay.metrics_merchant_day_status (merchant_id, day, status, payments)
      VALUES (${r.merchantId}, ${r.day}::date, ${r.status}::pay.payment_status, ${r.payments})`;
  }
  for (const r of next.links) {
    await tx`
      INSERT INTO pay.metrics_merchant_day_link (merchant_id, day, link_id, payments)
      VALUES (${r.merchantId}, ${r.day}::date, ${r.linkId}, ${r.payments})`;
  }
}

/** Every merchant-day a source row can contribute to. A superset is harmless: an empty recompute writes nothing. */
export async function listSourceKeys(sql: Sql, merchantId?: string): Promise<MetricsKey[]> {
  const only = merchantId ? sql`AND merchant_id = ${merchantId}` : sql``;
  const rows = await sql<Array<{ merchant_id: string; day: string }>>`
    SELECT DISTINCT merchant_id, day::text AS day FROM (
      SELECT merchant_id, (created_at AT TIME ZONE 'UTC')::date AS day FROM pay.payments WHERE true ${only}
      UNION
      SELECT p.merchant_id, (e.ts AT TIME ZONE 'UTC')::date
        FROM pay.payment_events e JOIN pay.payments p ON p.id = e.payment_id
       WHERE e.event = 'captured' ${merchantId ? sql`AND p.merchant_id = ${merchantId}` : sql``}
      UNION
      SELECT merchant_id, (created_at AT TIME ZONE 'UTC')::date FROM pay.settlements WHERE true ${only}
    ) k ORDER BY 1, 2
  `;
  return rows.map((r) => ({ merchantId: r.merchant_id, day: r.day }));
}

/** Every merchant-day the projection tables hold a row for. */
export async function listProjectionKeys(sql: Sql, merchantId?: string): Promise<MetricsKey[]> {
  const only = merchantId ? sql`WHERE merchant_id = ${merchantId}` : sql``;
  const rows = await sql<Array<{ merchant_id: string; day: string }>>`
    SELECT DISTINCT merchant_id, day::text AS day FROM (
      SELECT merchant_id, day FROM pay.metrics_merchant_day ${only}
      UNION SELECT merchant_id, day FROM pay.metrics_merchant_day_status ${only}
      UNION SELECT merchant_id, day FROM pay.metrics_merchant_day_link ${only}
    ) k ORDER BY 1, 2
  `;
  return rows.map((r) => ({ merchantId: r.merchant_id, day: r.day }));
}
