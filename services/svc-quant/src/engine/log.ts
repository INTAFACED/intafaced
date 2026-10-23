import type { QuantBacktestLogLine, QuantBacktestResult } from '@intafaced/contracts';

type Stored = Omit<QuantBacktestResult, 'runId' | 'metrics' | 'log'>;

/** Modelling choices a reader must weigh are warnings; the ones every run makes are information. */
const WARN_ASSUMPTIONS = new Set([
  'stop_loss_first',
  'take_profit_without_slippage',
  'open_position_marked_at_last_close',
  'risk_limits_not_simulated',
]);

/**
 * The log of a run (AL-backtest-03), derived from what the run stored, in time order: what was read, each fill, each
 * gap and each order that did not fill, then the modelling choices. Deterministic, so the same run always reads the
 * same log, and a run stored before the log existed has one too.
 */
export function logOf(run: Stored): QuantBacktestLogLine[] {
  const timed: QuantBacktestLogLine[] = [
    ...run.coverage.gaps.map((gap): QuantBacktestLogLine => ({
      level: 'warn',
      code: 'gap',
      ts: gap.from,
      values: { from: gap.from, to: gap.to },
    })),
    ...run.trades.map((trade): QuantBacktestLogLine => ({
      level: 'info',
      code: 'fill',
      ts: trade.ts,
      values: { side: trade.side, reason: trade.reason, qty: trade.qty, price: trade.price, fee: trade.fee },
    })),
    ...run.rejected.map((row): QuantBacktestLogLine => ({
      level: 'warn',
      code: 'not_filled',
      ts: row.ts,
      values: { side: row.side, reason: row.reason },
    })),
  ].sort((a, b) => (a.ts! < b.ts! ? -1 : a.ts! > b.ts! ? 1 : 0));
  return [
    {
      level: 'info',
      code: 'bars_read',
      ts: null,
      values: {
        symbol: run.symbol,
        bars: String(run.coverage.bars),
        expected: String(run.coverage.expected),
        barSize: run.coverage.barSize,
      },
    },
    {
      level: 'info',
      code: 'costs',
      ts: null,
      values: {
        schedule: run.costs.feeScheduleVersion,
        role: run.costs.feeRole,
        feeBps: String(run.costs.feeBps),
        slippageBps: run.costs.slippageBps,
        delayBars: String(run.costs.delayBars),
      },
    },
    ...timed,
    ...run.assumptions.map((name): QuantBacktestLogLine => ({
      level: WARN_ASSUMPTIONS.has(name) ? 'warn' : 'info',
      code: 'assumption',
      ts: null,
      values: { name },
    })),
    { level: 'info', code: 'finished', ts: null, values: { trades: String(run.trades.length), net: run.totals.net } },
  ];
}
