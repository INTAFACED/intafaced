import { add, formatAmount, parseAmount, sub, ZERO } from '@intafaced/money-math';
import type { JournalTrade, TradeJournal } from '@intafaced/contracts/trade-journal-procedures';

/** One closed trade on both lines: what it made and what it counts keeping the person's rules, each running total after it. */
export interface EquityPoint {
  readonly trade: JournalTrade;
  readonly at: string;
  /** "What I made": the running total of every closed trade's net result, oldest first, after this one. */
  readonly made: string;
  /** "Keeping my rules": the same over each trade's result on the rules line. */
  readonly rules: string;
}

/**
 * The two lines of J-portfolio-19 #1, from the journal's own trades (svc-trade works out each trade's rules result,
 * record `@intafaced/contracts/trade-journal-procedures`): oldest closed first, each point the running totals after that
 * trade. The gap is the rules line's end less what was made, as the service's own totals give it.
 */
export function equityOf(journal: TradeJournal): { points: readonly EquityPoint[]; made: string; rules: string; gap: string } {
  const ordered = [...journal.trades].sort((a, b) => Date.parse(a.closedAt) - Date.parse(b.closedAt));
  let made = ZERO;
  let rules = ZERO;
  const points = ordered.map((trade) => {
    made = add(made, parseAmount(trade.netPnl));
    rules = add(rules, parseAmount(trade.rules.netPnl));
    return { trade, at: trade.closedAt, made: formatAmount(made), rules: formatAmount(rules) };
  });
  const gap = formatAmount(sub(parseAmount(journal.totals.rulesNetPnl), parseAmount(journal.totals.netPnl)));
  return { points, made: journal.totals.netPnl, rules: journal.totals.rulesNetPnl, gap };
}

/** Where each line is drawn, in a 1000 by 240 plot: x by the point's place in time order, y on one scale for both lines. */
export function equityPlaces(points: readonly EquityPoint[]) {
  const W = 1000;
  const H = 240;
  const PAD = 12;
  // Floats for drawing only: every figure shown is the decimal string itself.
  const values = [0, ...points.flatMap((p) => [parseFloat(p.made), parseFloat(p.rules)])];
  const low = Math.min(...values);
  const high = Math.max(...values);
  const span = high - low || 1;
  const x = (i: number) => (points.length <= 1 ? W / 2 : PAD + (i * (W - 2 * PAD)) / (points.length - 1));
  const y = (v: string) => H - PAD - ((parseFloat(v) - low) * (H - 2 * PAD)) / span;
  return {
    width: W,
    height: H,
    zeroY: y('0'),
    made: points.map((p, i) => ({ x: x(i), y: y(p.made) })),
    rules: points.map((p, i) => ({ x: x(i), y: y(p.rules) })),
  };
}

/** The figures the "how it was worked out" view names for one trade on the rules line. */
export function minusOneRLessFees(trade: JournalTrade): string | null {
  if (trade.rules.oneR === null) return null;
  return formatAmount(sub(sub(ZERO, parseAmount(trade.rules.oneR)), parseAmount(trade.fees)));
}
