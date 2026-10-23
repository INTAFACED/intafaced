import type { QuantBacktestResult, QuantSampleSection, QuantVerdictCriteria, QUANT_VERDICT_CRITERIA } from '@intafaced/contracts';
import { formatAmount, parseAmount, sub, type Amount } from '@intafaced/ledger-client/money';
import { drawdownOf, percent, roundTripsOf } from './metrics.js';

type Criterion = (typeof QUANT_VERDICT_CRITERIA)[number];
type Sections = { readonly inSample: QuantSampleSection; readonly outOfSample: QuantSampleSection };

const CRITERIA: readonly Criterion[] = ['minTrades', 'minReturnPercent', 'maxDrawdownPercent', 'maxShortfallPercent'];

function section(from: string, to: string, start: Amount, points: readonly Amount[], roundTrips: number): QuantSampleSection {
  const end = points.length ? points[points.length - 1]! : start;
  const drawdown = drawdownOf([start, ...points]);
  return {
    from,
    to,
    startEquity: formatAmount(start),
    endEquity: formatAmount(end),
    returnPercent: percent(sub(end, start), start),
    maxDrawdownPercent: percent(drawdown.fall, drawdown.base),
    roundTrips,
  };
}

/**
 * The in-sample and out-of-sample parts of a split run (ENGINE BT-9), from its stored equity and trades. An equity point
 * belongs to the part its bar opened in. A round trip belongs to the part it was entered in, so a position opened in
 * sample and closed after the split counts in sample: the out-of-sample part is judged only on what it started.
 */
export function sectionsOf(
  result: Pick<QuantBacktestResult, 'trades' | 'equity' | 'totals' | 'window'>,
  outOfSampleFrom: string,
): Sections {
  const splitMs = Date.parse(outOfSampleFrom);
  const before = result.equity.filter((point) => Date.parse(point.ts) < splitMs).map((point) => parseAmount(point.equity));
  const after = result.equity.filter((point) => Date.parse(point.ts) >= splitMs).map((point) => parseAmount(point.equity));
  const trips = roundTripsOf(result.trades);
  const insideCount = trips.filter((trip) => Date.parse(trip.entryTs) < splitMs).length;
  const startCash = parseAmount(result.totals.startCash);
  const inSample = section(result.window.from, outOfSampleFrom, startCash, before, insideCount);
  const splitEquity = before.length ? before[before.length - 1]! : startCash;
  const outOfSample = section(outOfSampleFrom, result.window.to, splitEquity, after, trips.length - insideCount);
  return { inSample, outOfSample };
}

/**
 * The out-of-sample verdict (ENGINE MT-7), computed and never typed. Every criterion must be set: any blank one makes
 * the verdict inconclusive, named in `unset`, and it never reads passed. Fewer round trips than the minimum is
 * inconclusive too; otherwise each criterion the part misses is a reason it failed.
 */
export function verdictOf(sections: Sections | null, criteria: QuantVerdictCriteria): QuantBacktestResult['verdict'] {
  const unset = CRITERIA.filter((name) => criteria[name] === null);
  const judged = (status: QuantBacktestResult['verdict']['status'], reasons: string[]) => ({ status, reasons, unset, criteria });
  if (!sections) return judged('inconclusive', ['not_split']);
  if (unset.length) return judged('inconclusive', ['criteria_unset']);
  const { inSample, outOfSample } = sections;
  if (outOfSample.roundTrips < Number(criteria.minTrades)) return judged('inconclusive', ['too_few_trades']);
  const oosReturn = outOfSample.returnPercent.value;
  const oosDrawdown = outOfSample.maxDrawdownPercent.value;
  const isReturn = inSample.returnPercent.value;
  if (oosReturn === null || oosDrawdown === null || isReturn === null) return judged('inconclusive', ['section_undefined']);
  const reasons: string[] = [];
  if (parseAmount(oosReturn) < parseAmount(criteria.minReturnPercent!)) reasons.push('return_below_minimum');
  if (parseAmount(oosDrawdown) > parseAmount(criteria.maxDrawdownPercent!)) reasons.push('drawdown_above_maximum');
  if (sub(parseAmount(isReturn), parseAmount(oosReturn)) > parseAmount(criteria.maxShortfallPercent!)) {
    reasons.push('shortfall_above_maximum');
  }
  return reasons.length ? judged('failed', reasons) : judged('passed', []);
}
