import type { QuantBacktestResult, QuantCheck, QuantCheckThresholds, QuantMetric, QuantSampleSection } from '@intafaced/contracts';
import { formatAmount, parseAmount, sub, type Amount } from '@intafaced/ledger-client/money';
import { percent } from './metrics.js';

type Sections = { readonly inSample: QuantSampleSection; readonly outOfSample: QuantSampleSection };
type Checked = Pick<QuantBacktestResult, 'totals' | 'variantCount' | 'coverage'> & {
  /** Undefined: the run was stored before the sensitivity run existed. */
  readonly offsetRun?: QuantBacktestResult['offsetRun'];
};

const abs = (value: Amount) => (value < 0n ? -value : value);

/** A measured figure against a threshold: warning above it, clear at or under it, not set while the owner left it blank. */
function judged(name: QuantCheck['name'], figure: Amount, threshold: string | null, evidence: QuantCheck['evidence']): QuantCheck {
  if (threshold === null) return { name, status: 'not_set', threshold, evidence };
  return { name, status: figure > parseAmount(threshold) ? 'warning' : 'clear', threshold, evidence };
}

const notApplicable = (name: QuantCheck['name'], reason: string, threshold: string | null): QuantCheck => ({
  name,
  status: 'not_applicable',
  threshold,
  evidence: { reason },
});

/** The run's whole-window return in percent of the starting cash. */
export function returnOf(totals: QuantBacktestResult['totals']): QuantMetric {
  const start = parseAmount(totals.startCash);
  return percent(sub(parseAmount(totals.endEquity), start), start);
}

/**
 * Every check on a result (ENGINE BT-9), from what the run stored and the owner's thresholds as they stood when it
 * finished. All six are always listed. The engine reads closed bars only and a stored run is never rewritten, so
 * look-ahead and repainting are ruled out by construction; a test in engine.test.ts holds the look-ahead canary.
 */
export function checksOf(result: Checked, sections: Sections | null, thresholds: QuantCheckThresholds): QuantCheck[] {
  const checks: QuantCheck[] = [];

  // Overfitting: how far the out-of-sample return falls below the in-sample one, in percentage points.
  const isReturn = sections?.inSample.returnPercent.value ?? null;
  const oosReturn = sections?.outOfSample.returnPercent.value ?? null;
  if (!sections) checks.push(notApplicable('sample_gap', 'not_split', thresholds.maxSampleGapPercent));
  else if (isReturn === null || oosReturn === null) {
    checks.push(notApplicable('sample_gap', 'section_undefined', thresholds.maxSampleGapPercent));
  } else {
    const gap = sub(parseAmount(isReturn), parseAmount(oosReturn));
    checks.push(
      judged('sample_gap', gap, thresholds.maxSampleGapPercent, {
        inSampleReturnPercent: isReturn,
        outOfSampleReturnPercent: oosReturn,
        gapPercent: formatAmount(gap),
      }),
    );
  }

  // Overfitting: many variants tried makes a good-looking one more likely to be luck.
  if (result.variantCount === null) checks.push(notApplicable('variant_count', 'not_counted', thresholds.maxVariants));
  else {
    checks.push(
      judged('variant_count', parseAmount(String(result.variantCount)), thresholds.maxVariants, { variants: String(result.variantCount) }),
    );
  }

  // Sensitivity: the same run started one bar later. A large move means the result leans on its first bar.
  const base = returnOf(result.totals).value;
  const offset = result.offsetRun?.returnPercent.value ?? null;
  if (result.offsetRun === undefined) checks.push(notApplicable('bar_offset', 'not_run', thresholds.maxOffsetShiftPercent));
  else if (result.offsetRun === null) checks.push(notApplicable('bar_offset', 'too_few_bars', thresholds.maxOffsetShiftPercent));
  else if (base === null || offset === null) checks.push(notApplicable('bar_offset', 'return_undefined', thresholds.maxOffsetShiftPercent));
  else {
    const shift = abs(sub(parseAmount(base), parseAmount(offset)));
    checks.push(
      judged('bar_offset', shift, thresholds.maxOffsetShiftPercent, {
        returnPercent: base,
        offsetFrom: result.offsetRun.from,
        offsetReturnPercent: offset,
        shiftPercent: formatAmount(shift),
      }),
    );
  }

  // Bars: time bars built from the exchange's own trades, the standard kind; no range, renko or tick bars are offered.
  checks.push({ name: 'bar_type', status: 'clear', threshold: null, evidence: { barSize: result.coverage.barSize, kind: 'time' } });
  checks.push({ name: 'look_ahead', status: 'by_construction', threshold: null, evidence: { rule: 'closed_bars_only' } });
  checks.push({ name: 'repainting', status: 'by_construction', threshold: null, evidence: { rule: 'stored_run_immutable' } });
  return checks;
}
