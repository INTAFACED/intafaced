import { dec } from './deps';
import type { MoneyRow, MoneyView } from './portfolio-source';

/**
 * Best and worst movers (PF-overview-01): the coins held whose price moved most today, read from the same valuation as
 * the total (each row's own 24 h move over what it was worth a day ago). Dollar coins do not move and are left out. A
 * coin with no 24 h figure is never ranked as flat: it is named apart, so nothing missing reads as "no move".
 */
export interface CoinMovers {
  /** Coins that rose, biggest rise first. */
  best: MoneyRow[];
  /** Coins that fell, biggest fall first. */
  worst: MoneyRow[];
  /** Coins that did not move at all today. */
  flat: MoneyRow[];
  /** Priced coins with no 24 h figure, so they cannot be ranked. */
  unranked: string[];
}

/** At most this many coins on each side. */
export const MOVERS_PER_SIDE = 3;

export function moversOf(view: Pick<MoneyView, 'rows'>, perSide = MOVERS_PER_SIDE): CoinMovers {
  const ranked: Array<{ row: MoneyRow; move: bigint }> = [];
  const unranked: string[] = [];
  for (const row of view.rows) {
    if (row.class === 'cash' || row.usdValue === null) continue;
    const move = dec(row.changeRatio);
    if (move === null) unranked.push(row.asset);
    else ranked.push({ row, move });
  }
  const byMove = (a: { move: bigint }, b: { move: bigint }) => (a.move === b.move ? 0 : a.move > b.move ? -1 : 1);
  ranked.sort(byMove);
  return {
    best: ranked
      .filter((item) => item.move > 0n)
      .slice(0, perSide)
      .map((item) => item.row),
    worst: ranked
      .filter((item) => item.move < 0n)
      .reverse()
      .slice(0, perSide)
      .map((item) => item.row),
    flat: ranked.filter((item) => item.move === 0n).map((item) => item.row),
    unranked,
  };
}
