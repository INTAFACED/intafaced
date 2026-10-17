/**
 * Recent conversions, read from the ledger (TRMKT R3). A conversion is one order whose ledger lines are exactly one
 * `trade` line going out and one coming in, in two different assets. Lines with no `orderId` never group. Amounts are
 * passed through as the exact decimal strings the ledger sent: no arithmetic here.
 */
import type { ActivityItem } from './deps';

export interface RecentConversion {
  id: string;
  fromAsset: string;
  fromAmount: string;
  toAsset: string;
  toAmount: string;
  /** ISO time of the later of the two lines. */
  at: string;
}

const ms = (iso: string): number => {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
};

export function recentConversions(items: readonly ActivityItem[], limit = 8): RecentConversion[] {
  const orders = new Map<string, ActivityItem[]>();
  for (const line of items) {
    if (!line.orderId) continue;
    const lines = orders.get(line.orderId);
    if (lines) lines.push(line);
    else orders.set(line.orderId, [line]);
  }
  const found: RecentConversion[] = [];
  for (const [orderId, lines] of orders) {
    // Holds, releases or fee lines mean a spot order, which Buy and sell shows; a conversion has two trade lines only.
    if (lines.some((line) => line.kind !== 'trade') || lines.length !== 2) continue;
    const out = lines.find((line) => line.direction === 'out');
    const into = lines.find((line) => line.direction === 'in');
    if (!out || !into || out.asset === into.asset) continue;
    found.push({
      id: orderId,
      fromAsset: out.asset,
      fromAmount: out.amount,
      toAsset: into.asset,
      toAmount: into.amount,
      at: ms(out.postedAt) >= ms(into.postedAt) ? out.postedAt : into.postedAt,
    });
  }
  return found.sort((a, b) => ms(b.at) - ms(a.at)).slice(0, limit);
}
