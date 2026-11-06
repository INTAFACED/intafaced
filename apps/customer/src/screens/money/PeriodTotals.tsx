import { useEffect, useState } from 'react';
import { useSession } from '../../features/session/session';
import { lineTotalsSchema, type LineTotal } from '../../features/money/contracts';
import { LineTotals } from '../../features/money/StatementExtras';
import { dayStart, rangeProblem, type ActivityFilters } from './activity-filter';
import { usePreferences } from '../../shared/preferences';

const DAY = 24 * 60 * 60 * 1000;

/**
 * J-bank-16 #1: with a start and an end day picked, the net per coin of every posted line in those days, folded by the
 * bank the same way a statement's total is, so a statement over the same dates shows the same figure. Whatever the
 * search or direction filters, it totals every line in the dates, and says so.
 */
export function PeriodTotals({ filters }: { filters: ActivityFilters }) {
  const { api } = useSession();
  const { timeZone } = usePreferences();
  const start = filters.from ? dayStart(filters.from, timeZone) : null;
  const endDay = filters.to ? dayStart(filters.to, timeZone) : null;
  const ok = start !== null && endDay !== null && rangeProblem(filters, timeZone) === null;
  const from = ok ? new Date(start).toISOString() : null;
  const to = ok ? new Date(endDay + DAY - 1).toISOString() : null;
  const [totals, setTotals] = useState<readonly LineTotal[] | null>(null);

  useEffect(() => {
    setTotals(null);
    if (!from || !to) return;
    let live = true;
    void api.query('bank', 'statements.totals', { from, to }, lineTotalsSchema).then((result) => {
      if (live && result.ok) setTotals(result.data.totals);
    });
    return () => {
      live = false;
    };
  }, [api, from, to]);

  if (!totals) return null;
  return <LineTotals totals={totals} testId="money-period-totals" />;
}
