import type { QuantBacktestResult, QuantMetric, QuantPublicResult, QuantReport, QuantSeriesSummary } from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client/money';

/** One equity series reduced to the figures a chart and a public page need. */
export function seriesSummary(equity: QuantBacktestResult['equity']): QuantSeriesSummary {
  if (equity.length === 0) return { points: 0, first: null, last: null, low: null, high: null };
  let low = equity[0]!;
  let high = equity[0]!;
  let lowValue = parseAmount(low.equity);
  let highValue = lowValue;
  for (const point of equity.slice(1)) {
    const value = parseAmount(point.equity);
    if (value < lowValue) {
      low = point;
      lowValue = value;
    }
    if (value > highValue) {
      high = point;
      highValue = value;
    }
  }
  const first = equity[0]!;
  const last = equity[equity.length - 1]!;
  return {
    points: equity.length,
    first: { ts: first.ts, equity: first.equity },
    last: { ts: last.ts, equity: last.equity },
    low: low.equity,
    high: high.equity,
  };
}

function row(name: string, value: string): { name: string; value: string } {
  return { name, value: value.trim() ? value : 'none' };
}

/** Assumption name, gap ends, and margin kind and level. A line with no values keeps a non-empty fallback. */
function warnValue(line: { readonly ts: string | null; readonly values: Readonly<Record<string, string>> }): string {
  const parts = Object.entries(line.values).flatMap(([key, value]) => {
    const text = value.trim();
    return text ? [`${key} ${text}`] : [];
  });
  return parts.length > 0 ? parts.join(', ') : (line.ts ?? 'no time');
}

function metricLine(metric: QuantMetric): string {
  return metric.value ?? `not defined (${metric.reason ?? 'unset'})`;
}

/**
 * The print document for one presented run. Sections are always the six named ones, each with at least one row, so a
 * layout has no empty section. Derived; nothing is stored.
 */
export function reportOf(result: QuantBacktestResult): QuantReport {
  const charts = seriesSummary(result.equity);
  const warningRows = [
    ...result.checks
      .filter((check) => check.status === 'warning')
      .map((check) => row(check.name, `warning ${JSON.stringify(check.evidence)}`)),
    ...result.log.filter((line) => line.level === 'warn').map((line) => row(line.code, warnValue(line))),
  ];
  return {
    runId: result.runId,
    claimLabel: result.claimLabel,
    simulated: true,
    live: false,
    sections: [
      {
        id: 'parameters',
        rows: [
          row('symbol', result.symbol),
          row('from', result.window.from),
          row('to', result.window.to),
          row('fillTiming', result.fillTiming),
          row('feeScheduleVersion', result.costs.feeScheduleVersion),
          row('feeRole', result.costs.feeRole),
          row('feeBps', String(result.costs.feeBps)),
          row('slippageBps', result.costs.slippageBps),
          row('delayBars', String(result.costs.delayBars)),
          row('startCash', result.totals.startCash),
          row('strategyVersion', String(result.strategyVersion)),
          row('split', result.split ? `${result.split.preset} from ${result.split.outOfSampleFrom}` : 'not split'),
          row('account', result.account ? `margin leverage ${result.account.leverage}` : 'cash'),
        ],
      },
      {
        id: 'statistics',
        rows: [
          row('net', metricLine(result.metrics.returns.net)),
          row('netPercent', metricLine(result.metrics.returns.netPercent)),
          row('grossProfit', metricLine(result.metrics.returns.grossProfit)),
          row('grossLoss', metricLine(result.metrics.returns.grossLoss)),
          row('profitFactor', metricLine(result.metrics.returns.profitFactor)),
          row('expectedPayoff', metricLine(result.metrics.returns.expectedPayoff)),
          row('sharpe', metricLine(result.metrics.returns.sharpe)),
          row('sortino', metricLine(result.metrics.returns.sortino)),
          row('maxDrawdown', metricLine(result.metrics.risk.maxDrawdown)),
          row('maxDrawdownPercent', metricLine(result.metrics.risk.maxDrawdownPercent)),
          row('maxRunUp', metricLine(result.metrics.risk.maxRunUp)),
          row('roundTrips', String(result.metrics.trades.roundTrips)),
          row('winRate', metricLine(result.metrics.trades.winRate)),
          row('verdict', result.verdict.status),
          row('variantCount', result.variantCount === null ? 'not counted' : String(result.variantCount)),
        ],
      },
      {
        id: 'charts',
        rows: [
          row('points', String(charts.points)),
          row('first', charts.first ? `${charts.first.ts} ${charts.first.equity}` : 'none'),
          row('last', charts.last ? `${charts.last.ts} ${charts.last.equity}` : 'none'),
          row('low', charts.low ?? 'none'),
          row('high', charts.high ?? 'none'),
        ],
      },
      {
        id: 'coverage',
        rows: [
          row('barSize', result.coverage.barSize),
          row('bars', String(result.coverage.bars)),
          row('expected', String(result.coverage.expected)),
          row('fraction', result.coverage.fraction),
          row('gaps', result.coverage.gaps.length === 0 ? 'none' : String(result.coverage.gaps.length)),
        ],
      },
      {
        id: 'warnings',
        rows: warningRows.length > 0 ? warningRows : [row('warnings', 'none')],
      },
      {
        id: 'labels',
        rows: [row('claimLabel', result.claimLabel), row('simulated', 'true'), row('live', 'false')],
      },
    ],
  };
}

/** The public page. Account, source and the run key are not fields of this object. */
export function publicResultOf(result: QuantBacktestResult): QuantPublicResult {
  return {
    claimLabel: result.claimLabel,
    simulated: true,
    live: false,
    symbol: result.symbol,
    window: result.window,
    coverage: result.coverage,
    costs: result.costs,
    totals: result.totals,
    metrics: result.metrics,
    verdict: result.verdict,
    checks: result.checks,
    warnings: result.log.filter((line) => line.level === 'warn'),
    charts: seriesSummary(result.equity),
    variantCount: result.variantCount,
  };
}
