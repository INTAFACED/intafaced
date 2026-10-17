// TEST DATA ONLY. Nothing here is a real figure.
import { NOT_MINE, DAY, iso, ok } from '../../mock/shared.mjs';

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const weekStart = (day) => {
  const d = new Date(`${day}T00:00:00.000Z`);
  const back = (d.getUTCDay() + 6) % 7;
  return dayOf(d.getTime() - back * DAY);
};

/** Volume and fees by day or week, from a fixed 60-day history. */
export function createAnalyticsMock(ctx) {
  const { scenario, now } = ctx;
  const has = scenario !== 'quiet' && scenario !== 'new';
  const days = has ? Array.from({ length: 60 }, (_, i) => dayOf(now - (59 - i) * DAY)) : [];
  const rows = (from, to, asset) =>
    days
      .filter((d) => d >= from && d < to)
      .flatMap((d, i) =>
        ['USDT', 'USD']
          .filter((a) => (!asset || a === asset) && (a === 'USDT' || i % 3 === 0))
          .map((a) => ({
            day: d,
            asset: a,
            count: a === 'USDT' ? 1 + ((i * 7) % 9) : 2,
            volume: a === 'USDT' ? (300 + ((i * 137) % 900)).toFixed(2) : '85.50',
          })),
      );
  const group = (list, bucket) => {
    const by = new Map();
    for (const r of list) {
      const period = bucket === 'week' ? weekStart(r.day) : r.day;
      const k = `${period}|${r.asset}`;
      const cur = by.get(k) ?? { period, assetCode: r.asset, count: 0, volume: 0 };
      cur.count += r.count;
      cur.volume += Number(r.volume);
      by.set(k, cur);
    }
    return [...by.values()].sort((a, b) =>
      a.period === b.period ? b.assetCode.localeCompare(a.assetCode) : b.period.localeCompare(a.period),
    );
  };
  const freshness = () => ({ asOf: iso(now - 90_000), lagSeconds: 90 });
  return {
    async handle(procedure, input, route) {
      if (procedure !== 'merchantAnalytics.volume' && procedure !== 'merchantAnalytics.fees') return NOT_MINE;
      const from = input.from.slice(0, 10);
      const to = input.to.slice(0, 10);
      const grouped = group(rows(from, to, input.assetId), input.bucket);
      const base = { merchantId: input.merchantId, bucket: input.bucket, from, to, freshness: freshness(), nextCursor: null };
      if (procedure === 'merchantAnalytics.volume')
        return ok(route, {
          ...base,
          items: grouped.map((g) => ({ period: g.period, assetCode: g.assetCode, count: g.count, volume: g.volume.toFixed(2) })),
        });
      return ok(route, {
        ...base,
        items: grouped.map((g) => {
          const fees = g.volume * 0.029;
          return {
            period: g.period,
            assetCode: g.assetCode,
            gross: g.volume.toFixed(2),
            fees: fees.toFixed(2),
            net: (g.volume - fees).toFixed(2),
            refunded: '0',
          };
        }),
        effectiveRate: null,
        effectiveRateReason: 'not_aggregated',
        conversionCost: null,
        byRule: [],
      });
    },
  };
}
