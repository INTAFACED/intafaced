// TEST DATA ONLY. Nothing here is a real figure.
import { NOT_MINE, DAY, iso, ok } from '../../mock/shared.mjs';
import { fromU, isTaken, toU } from '../../mock/world.mjs';

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const weekStart = (day) => {
  const d = new Date(`${day}T00:00:00.000Z`);
  const back = (d.getUTCDay() + 6) % 7;
  return dayOf(d.getTime() - back * DAY);
};

/** Volume and fees by day or week, worked out from the same payments every other page uses (mock/world.mjs). */
export function createAnalyticsMock(ctx) {
  const { now } = ctx;
  const freshness = () => ({ asOf: iso(Date.now() - 90_000), lagSeconds: 90 });
  /** One row per day and asset: captured payments, what they paid in, the fees taken on them, and what was refunded. */
  const rows = (from, to, asset) => {
    const by = new Map();
    for (const p of ctx.world.payments) {
      const d = dayOf(Date.parse(p.createdAt));
      if (!isTaken(p.status) || d < from || d >= to || (asset && p.assetId !== asset)) continue;
      const key = `${d}|${p.assetId}`;
      const row = by.get(key) ?? { day: d, asset: p.assetId, count: 0, volume: 0n, fees: 0n, refunded: 0n };
      row.count += 1;
      row.volume += toU(p.capturedAmount);
      row.fees += toU(p.fee);
      row.refunded += toU(p.refundedAmount);
      by.set(key, row);
    }
    return [...by.values()];
  };
  const group = (list, bucket) => {
    const by = new Map();
    for (const r of list) {
      const period = bucket === 'week' ? weekStart(r.day) : r.day;
      const k = `${period}|${r.asset}`;
      const cur = by.get(k) ?? { period, assetCode: r.asset, count: 0, volume: 0n, fees: 0n, refunded: 0n };
      cur.count += r.count;
      cur.volume += r.volume;
      cur.fees += r.fees;
      cur.refunded += r.refunded;
      by.set(k, cur);
    }
    return [...by.values()].sort((a, b) =>
      a.period === b.period ? b.assetCode.localeCompare(a.assetCode) : b.period.localeCompare(a.period),
    );
  };
  /** Declines worked out the way svc-pay does: finished payments made in the window, the rate rounded down to 2 places. */
  const declines = (input) => {
    const from = String(input?.from ?? '').slice(0, 10);
    const to = String(input?.to ?? '').slice(0, 10);
    let succeeded = 0;
    const reasons = new Map();
    for (const p of ctx.world.payments) {
      const d = dayOf(Date.parse(p.createdAt));
      if (d < from || d >= to) continue;
      if (p.status === 'failed') {
        const code = p.failure?.code ?? 'pay.failed';
        const had = reasons.get(code) ?? { code, message: p.failure?.message ?? 'The payment could not be completed.', count: 0 };
        had.count += 1;
        reasons.set(code, had);
      } else if (isTaken(p.status)) succeeded += 1;
    }
    const declined = [...reasons.values()].reduce((n, r) => n + r.count, 0);
    const finished = succeeded + declined;
    const hundredths = finished === 0 ? null : Math.floor((declined * 10000) / finished);
    const rate = hundredths === null ? null : String(hundredths / 100);
    return {
      merchantId: input?.merchantId,
      from,
      to,
      asOf: iso(Date.now() - 90_000),
      finishedCount: finished,
      succeededCount: succeeded,
      declinedCount: declined,
      rate,
      rateStatus: finished === 0 ? 'no_payments' : (declined * 10000) % finished === 0 ? 'exact' : 'rounded',
      reasons: [...reasons.values()].sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
    };
  };
  return {
    async handle(procedure, input, route) {
      if (procedure === 'merchantAnalytics.declines') return ok(route, declines(input));
      if (procedure !== 'merchantAnalytics.volume' && procedure !== 'merchantAnalytics.fees') return NOT_MINE;
      const from = input.from.slice(0, 10);
      const to = input.to.slice(0, 10);
      const grouped = group(rows(from, to, input.assetId), input.bucket);
      const base = { merchantId: input.merchantId, bucket: input.bucket, from, to, freshness: freshness(), nextCursor: null };
      if (procedure === 'merchantAnalytics.volume')
        return ok(route, {
          ...base,
          items: grouped.map((g) => ({ period: g.period, assetCode: g.assetCode, count: g.count, volume: fromU(g.volume) })),
        });
      return ok(route, {
        ...base,
        items: grouped.map((g) => ({
          period: g.period,
          assetCode: g.assetCode,
          gross: fromU(g.volume),
          fees: fromU(g.fees),
          net: fromU(g.volume - g.fees),
          refunded: fromU(g.refunded),
        })),
        effectiveRate: null,
        effectiveRateReason: 'not_aggregated',
        conversionCost: null,
        byRule: [],
      });
    },
  };
}
