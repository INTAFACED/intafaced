import { parseAmount as amt, type Amount } from '@intafaced/ledger-client';
import type { DayProjection, MerchantDayRow, StatusRow, LinkRow } from '../../../services/svc-pay/src/metrics/compute.js';

export interface Sources {
  payments: Array<{ id: string; merchant_id: string; currency: string; status: string; created_at: Date }>;
  events: Array<{ payment_id: string; event: string; payload: { amount: string }; ts: Date }>;
  settlements: Array<{ merchant_id: string; asset_id: string; gross: string; fees: string; net: string; status: string; created_at: Date }>;
  sessions: Array<{ payment_id: string | null; link_id: string }>;
}
const dayOf = (d: Date) => d.toISOString().slice(0, 10);

/** Independent bigint source-row loop, adapted from W2's acceptance oracle.
 * Shares types and decimal parsing only; never calls production metrics compute/diff.
 */
export function recompute({ payments, events, settlements, sessions }: Sources): DayProjection {
  const byId = new Map(payments.map((p) => [p.id, p]));
  type Mut = { -readonly [K in keyof MerchantDayRow]: MerchantDayRow[K] };
  const rows = new Map<string, Mut>();
  const row = (merchantId: string, day: string, assetCode: string): Mut => {
    const id = `${merchantId}|${day}|${assetCode}`;
    let r = rows.get(id);
    if (!r) {
      r = {
        merchantId,
        day,
        assetCode,
        paymentsCreated: 0,
        captured: 0n,
        capturedCount: 0,
        largestCaptured: 0n,
        refunded: 0n,
        refundedCount: 0,
        settleGross: 0n,
        settleFees: 0n,
        settleNet: 0n,
        settleCount: 0,
        unsettledNet: 0n,
      };
      rows.set(id, r);
    }
    return r;
  };
  const keep = (_merchantId: string) => true;

  const firstCapture = new Map<string, Date>();
  const capturedBy = new Map<string, Amount>();
  const refundedBy = new Map<string, Amount>();
  for (const e of events) {
    const p = byId.get(e.payment_id)!;
    const a = amt(e.payload.amount);
    if (e.event === 'captured') {
      const first = firstCapture.get(p.id);
      if (!first || e.ts < first) firstCapture.set(p.id, e.ts);
      capturedBy.set(p.id, (capturedBy.get(p.id) ?? 0n) + a);
      if (keep(p.merchant_id)) {
        const r = row(p.merchant_id, dayOf(e.ts), p.currency);
        r.captured += a;
        r.capturedCount += 1;
        if (a > r.largestCaptured) r.largestCaptured = a;
      }
    } else {
      refundedBy.set(p.id, (refundedBy.get(p.id) ?? 0n) + a);
    }
  }
  for (const e of events) {
    if (e.event !== 'refunded') continue;
    const p = byId.get(e.payment_id)!;
    const first = firstCapture.get(p.id);
    if (!first || !keep(p.merchant_id)) continue;
    const r = row(p.merchant_id, dayOf(first), p.currency);
    r.refunded += amt(e.payload.amount);
    r.refundedCount += 1;
  }
  const statuses = new Map<string, StatusRow>();
  const links = new Map<string, LinkRow>();
  const linkOf = new Map(sessions.filter((s) => s.payment_id).map((s) => [s.payment_id!, s.link_id]));
  for (const p of payments) {
    if (!keep(p.merchant_id)) continue;
    const day = dayOf(p.created_at);
    const r = row(p.merchant_id, day, p.currency);
    r.paymentsCreated += 1;
    if (p.status === 'captured') r.unsettledNet += (capturedBy.get(p.id) ?? 0n) - (refundedBy.get(p.id) ?? 0n);
    const sid = `${p.merchant_id}|${day}|${p.status}`;
    const s = statuses.get(sid);
    statuses.set(sid, { merchantId: p.merchant_id, day, status: p.status, payments: (s?.payments ?? 0) + 1 });
    const link = linkOf.get(p.id);
    if (link && capturedBy.has(p.id)) {
      const lid = `${p.merchant_id}|${day}|${link}`;
      const l = links.get(lid);
      links.set(lid, { merchantId: p.merchant_id, day, linkId: link, payments: (l?.payments ?? 0) + 1 });
    }
  }
  for (const s of settlements) {
    if (!keep(s.merchant_id) || !['posted', 'paid_out'].includes(s.status)) continue;
    const r = row(s.merchant_id, dayOf(s.created_at), s.asset_id);
    r.settleGross += amt(s.gross);
    r.settleFees += amt(s.fees);
    r.settleNet += amt(s.net);
    r.settleCount += 1;
  }
  return { days: [...rows.values()], statuses: [...statuses.values()], links: [...links.values()] };
}

const canonical = (p: DayProjection) =>
  JSON.stringify(
    {
      days: [...p.days].sort((a, b) => `${a.merchantId}|${a.day}|${a.assetCode}`.localeCompare(`${b.merchantId}|${b.day}|${b.assetCode}`)),
      statuses: [...p.statuses].sort((a, b) =>
        `${a.merchantId}|${a.day}|${a.status}`.localeCompare(`${b.merchantId}|${b.day}|${b.status}`),
      ),
      links: [...p.links].sort((a, b) => `${a.merchantId}|${a.day}|${a.linkId}`.localeCompare(`${b.merchantId}|${b.day}|${b.linkId}`)),
    },
    (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
  );

export function assertProjection(expected: DayProjection, actual: DayProjection): void {
  if (canonical(expected) !== canonical(actual))
    throw new Error('pay-sim metrics drift: read model differs from independent source recompute');
}
