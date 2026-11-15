import type { Sql } from 'postgres';
import type { OutsideFunds } from '@intafaced/contracts';
import { formatAmount, parseAmount, type Amount } from '@intafaced/ledger-client';
import { iso } from '../merchant-ops/money.js';
import type { MerchantCaller } from '../merchant-ops/roles.js';

/**
 * A business's money held outside our book, per asset and holder (J-merchant-04: "the merchant sees it as clearing, then
 * available, as the acquiring partner or the chain reports, with its time"; launch money model, OWNER 226).
 *
 * Read from the payments' own append-only events, which record what the chain or the partner reported, never from the
 * ledger (our ledger holds only our fee on these payments):
 * - an open payment to the business's own wallet: the chain's last report (`rail.pending`): what is final is available
 *   in the wallet, what is still confirming is clearing;
 * - a captured payment: available, unless the partner reported its funds held (`funds.pending` with no `funds.available`
 *   since), which is clearing. Captured minus refunded: a refund the partner reported is no longer the business's.
 * `asOf` is the newest of those reports' times.
 */
interface Row {
  currency: string;
  custody: 'merchant_wallet' | 'partner';
  status: string;
  amount: string;
  received: string | null;
  confirming: string | null;
  pending_at: Date | null;
  held: boolean;
  report_at: Date | null;
  refunded: string | null;
}

const CAPTURED = new Set(['captured', 'settled', 'refunded', 'disputed']);

export async function outsideFundsOf(sql: Sql, caller: MerchantCaller): Promise<OutsideFunds> {
  const rows = await sql<Row[]>`
    SELECT p.currency, p.custody, p.status::text AS status, p.amount::text AS amount,
           pend.payload->>'received' AS received, pend.payload->>'confirming' AS confirming, pend.ts AS pending_at,
           (EXISTS (SELECT 1 FROM pay.payment_events f WHERE f.payment_id = p.id AND f.event = 'funds.pending')
             AND NOT EXISTS (SELECT 1 FROM pay.payment_events f WHERE f.payment_id = p.id AND f.event = 'funds.available')) AS held,
           (SELECT max(e.ts) FROM pay.payment_events e
             WHERE e.payment_id = p.id AND e.event IN ('captured', 'funds.pending', 'funds.available', 'refunded')) AS report_at,
           (SELECT COALESCE(sum((e.payload->>'amount')::numeric), 0)::text FROM pay.payment_events e
             WHERE e.payment_id = p.id AND e.event = 'refunded') AS refunded
      FROM pay.payments p
      LEFT JOIN LATERAL (
        SELECT e.payload, e.ts FROM pay.payment_events e
         WHERE e.payment_id = p.id AND e.event = 'rail.pending'
         ORDER BY e.seq DESC LIMIT 1
      ) pend ON true
     WHERE p.merchant_id = ${caller.merchantId} AND p.custody IN ('merchant_wallet', 'partner')
  `;
  const by = new Map<
    string,
    { clearing: Amount; available: Amount; asOf: Date; payments: number; custody: Row['custody']; currency: string }
  >();
  for (const r of rows) {
    let clearing = 0n;
    let available = 0n;
    let at: Date | null = null;
    if (CAPTURED.has(r.status)) {
      const net = parseAmount(r.amount) - (r.refunded ? parseAmount(r.refunded) : 0n);
      if (net > 0n) {
        if (r.held) clearing = net;
        else available = net;
      }
      at = r.report_at;
    } else if (r.status === 'created' && r.pending_at) {
      available = r.received ? parseAmount(r.received) : 0n;
      clearing = r.confirming ? parseAmount(r.confirming) : 0n;
      at = r.pending_at;
    }
    if (!at || (clearing === 0n && available === 0n)) continue;
    const key = `${r.currency}\0${r.custody}`;
    const cur = by.get(key);
    if (cur) {
      cur.clearing += clearing;
      cur.available += available;
      cur.payments += 1;
      if (at > cur.asOf) cur.asOf = at;
    } else by.set(key, { clearing, available, asOf: at, payments: 1, custody: r.custody, currency: r.currency });
  }
  return {
    rows: [...by.values()]
      .sort((a, b) => a.currency.localeCompare(b.currency) || a.custody.localeCompare(b.custody))
      .map((v) => ({
        assetId: v.currency,
        holder: v.custody === 'merchant_wallet' ? ('own_wallet' as const) : ('partner' as const),
        source: v.custody === 'merchant_wallet' ? ('chain' as const) : ('partner' as const),
        clearing: formatAmount(v.clearing),
        available: formatAmount(v.available),
        asOf: iso(v.asOf),
        payments: v.payments,
      })),
  };
}
