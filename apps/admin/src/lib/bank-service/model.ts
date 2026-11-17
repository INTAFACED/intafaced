/**
 * The finance desk's bank service reads (J-bank-28 #3 #4): ramp metrics and direct debit mandates, each as the partner
 * reports it through svc-bank (`ops.rampMetrics`, `ops.directDebitMandates`). A shape this console does not understand is
 * refused whole, never guessed at. Pure, so the server loader and its tests share it.
 */
type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : null);
const str = (v: unknown): v is string => typeof v === 'string';
const strOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';
const count = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const list = <T>(v: unknown, each: (x: unknown) => T | null): T[] | null => {
  if (!Array.isArray(v)) return null;
  const out = v.map(each);
  return out.every((x): x is T => x !== null) ? out : null;
};

export interface RampMetrics {
  readonly label: string;
  readonly asOf: string;
  readonly health: string;
  readonly lastOpenedAt: string | null;
  readonly lastPaidAt: string | null;
  readonly orders: { state: string; count: number }[];
  readonly quoteExpiries: { count: number; latest: { orderId: string; expiredAt: string }[] };
}

export function parseRampMetrics(raw: unknown): { partner: RampMetrics | null } | null {
  const r = rec(raw);
  if (!r || !('partner' in r)) return null;
  if (r.partner === null) return { partner: null };
  const p = rec(r.partner);
  const q = rec(p?.quoteExpiries);
  if (!p || !q) return null;
  if (!(str(p.label) && str(p.asOf) && str(p.health) && strOrNull(p.lastOpenedAt) && strOrNull(p.lastPaidAt) && count(q.count)))
    return null;
  const orders = list(p.orders, (x) => {
    const o = rec(x);
    return o && str(o.state) && count(o.count) ? { state: o.state, count: o.count } : null;
  });
  const latest = list(q.latest, (x) => {
    const e = rec(x);
    return e && str(e.orderId) && str(e.expiredAt) ? { orderId: e.orderId, expiredAt: e.expiredAt } : null;
  });
  if (!orders || !latest) return null;
  return {
    partner: {
      label: p.label,
      asOf: p.asOf,
      health: p.health,
      lastOpenedAt: p.lastOpenedAt,
      lastPaidAt: p.lastPaidAt,
      orders,
      quoteExpiries: { count: q.count, latest },
    },
  };
}

export interface MandateLine {
  readonly mandateId: string;
  readonly userId: string;
  readonly state: 'active' | 'blocked';
  readonly blockedAt: string | null;
  readonly creditorName: string | null;
  readonly reference: string | null;
  readonly assetId: string | null;
  readonly refunds: { collectionId: string; assetId: string; amount: string; moveId: string; refundedAt: string }[];
  readonly failures: { collectionId: string; code: string; at: string }[];
}
export interface DirectDebitsReport {
  readonly label: string;
  readonly asOf: string;
  readonly mandates: MandateLine[];
  readonly failuresByReason: { code: string; count: number }[];
  readonly refundCount: number;
}

export function parseDirectDebits(raw: unknown): { partner: DirectDebitsReport | null } | null {
  const r = rec(raw);
  if (!r || !('partner' in r)) return null;
  if (r.partner === null) return { partner: null };
  const p = rec(r.partner);
  if (!p || !(str(p.label) && str(p.asOf) && count(p.refundCount))) return null;
  const mandates = list(p.mandates, (x): MandateLine | null => {
    const m = rec(x);
    if (!m || !(str(m.mandateId) && str(m.userId) && (m.state === 'active' || m.state === 'blocked') && strOrNull(m.blockedAt)))
      return null;
    if (!(strOrNull(m.creditorName) && strOrNull(m.reference) && strOrNull(m.assetId))) return null;
    const refunds = list(m.refunds, (y) => {
      const f = rec(y);
      return f && str(f.collectionId) && str(f.assetId) && str(f.amount) && str(f.moveId) && str(f.refundedAt)
        ? { collectionId: f.collectionId, assetId: f.assetId, amount: f.amount, moveId: f.moveId, refundedAt: f.refundedAt }
        : null;
    });
    const failures = list(m.failures, (y) => {
      const f = rec(y);
      return f && str(f.collectionId) && str(f.code) && str(f.at) ? { collectionId: f.collectionId, code: f.code, at: f.at } : null;
    });
    if (!refunds || !failures) return null;
    return {
      mandateId: m.mandateId,
      userId: m.userId,
      state: m.state,
      blockedAt: m.blockedAt,
      creditorName: m.creditorName,
      reference: m.reference,
      assetId: m.assetId,
      refunds,
      failures,
    };
  });
  const byReason = list(p.failuresByReason, (x) => {
    const f = rec(x);
    return f && str(f.code) && count(f.count) ? { code: f.code, count: f.count } : null;
  });
  if (!mandates || !byReason) return null;
  return { partner: { label: p.label, asOf: p.asOf, mandates, failuresByReason: byReason, refundCount: p.refundCount } };
}
