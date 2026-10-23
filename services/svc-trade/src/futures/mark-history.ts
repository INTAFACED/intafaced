/**
 * Mark-history export (MKT-0107).
 *
 * Each period carries the risk mark that was published for it. A period whose
 * mark was not published stays null. The last trade is not written into that slot.
 */

export interface MarkHistoryPeriod {
  readonly periodId: string;
  readonly riskMark: string | null;
  readonly lastTrade: string | null;
}

export interface MarkHistorySlot {
  readonly periodId: string;
  readonly mark: string | null;
}

export function exportMarkHistory(periods: readonly MarkHistoryPeriod[]): MarkHistorySlot[] {
  return periods.map((period) => ({
    periodId: period.periodId,
    mark: period.riskMark,
  }));
}
