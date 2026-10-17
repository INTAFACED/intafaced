/** Paper run record. Not a balance and not a ledger post. */

export interface EquityPoint {
  readonly ts: string;
  readonly equity: string;
}

export interface RunTrade {
  readonly ts: string;
  readonly symbol: string;
  readonly qty: string;
  readonly price: string;
}

export interface CostEvidence {
  readonly kind: string;
  readonly source: string;
}

/** Absent evidence is null. Never a zero fee, slippage, or latency. */
export interface CostBreakdown {
  readonly fees: CostEvidence | null;
  readonly slippage: CostEvidence | null;
  readonly latency: CostEvidence | null;
}

export interface RunResultBody {
  readonly equityCurve: readonly EquityPoint[] | null;
  readonly trades: readonly RunTrade[] | null;
  readonly costs: CostBreakdown | null;
  readonly pnl: string | null;
  readonly simulated: true;
  readonly live: false;
  readonly environment: string;
  readonly kind: 'paper' | 'simulated';
  readonly claimLabel: string;
}

export interface StoredRunResult {
  readonly detail: RunResultBody | null;
  readonly response: unknown;
}

export type RunKind = 'backtest' | 'sandbox';

export interface StoredRun {
  readonly id: string;
  readonly userId: string | null;
  readonly kind: RunKind;
  readonly strategyId: string | null;
  readonly strategyVersion: number | null;
  readonly started: string;
  readonly finished: string | null;
  readonly outcome: string | null;
  readonly detail: RunResultBody | null;
  readonly response: unknown;
  readonly idempotencyKey: string;
}

export interface RunSummary {
  readonly id: string;
  readonly kind: RunKind;
  readonly userId: string | null;
  readonly started: string;
  readonly duration: number | null;
  readonly outcome: string | null;
}

export interface RunListPage {
  readonly runs: readonly RunSummary[];
  readonly nextCursor: string | null;
}

export interface RunCounts {
  readonly byKind: { readonly backtest: number; readonly sandbox: number };
  readonly byOutcome: readonly { readonly outcome: string; readonly count: number }[];
  readonly asOf: string;
}

export interface ClaimRow {
  readonly id: string;
  readonly runId: string;
  readonly userId: string;
  readonly pnl: string;
  readonly environment: 'paper' | 'backtest' | 'shadow';
  readonly kind: 'paper' | 'simulated';
  readonly claimLabel: 'Paper — not live performance' | 'Historical simulation — not a forecast' | 'Shadow — not live performance';
  readonly live: false;
  readonly simulated: true;
  readonly createdAt: string;
}
