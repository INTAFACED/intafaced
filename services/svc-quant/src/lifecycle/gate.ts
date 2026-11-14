import type {
  QuantBacktestResult,
  QuantGateCheckResult,
  QuantGateCriterion,
  QuantOwnerCriterion,
  QuantStage,
  QuantVerdictCriteria,
} from '@intafaced/contracts';
import { parseAmount } from '@intafaced/ledger-client/money';
import type { OwnerCriterionRow } from './repository.js';

/** The values an operator may set for each owner criterion: a whole number of minutes, or a percentage. */
export const OWNER_CRITERION_FORMAT: Record<QuantOwnerCriterion, RegExp> = {
  'gate.paperMinutes': /^\d{1,6}$/,
  'gate.maxDrawdownPercent': /^\d{1,3}(\.\d{1,4})?$/,
  'oos.minTrades': /^\d{1,6}$/,
  'oos.minReturnPercent': /^-?\d{1,6}(\.\d{1,4})?$/,
  'oos.maxDrawdownPercent': /^\d{1,3}(\.\d{1,4})?$/,
  'oos.maxShortfallPercent': /^\d{1,6}(\.\d{1,4})?$/,
};

/** What each gate criterion is called on a refusal. */
export const GATE_CRITERION_NAMES: Record<QuantGateCriterion, string> = {
  paperMinutes: 'the shortest paper run, in minutes',
  maxDrawdownPercent: 'the largest drawdown of the validating backtest, in percent',
};

export type GateCriteria = Record<QuantGateCriterion, string | null>;

/** The gate's criteria as stored by an operator; one with no row is blank. */
export function gateCriteriaOf(rows: readonly OwnerCriterionRow[]): GateCriteria {
  const value = (name: QuantOwnerCriterion) => rows.find((row) => row.name === name)?.value ?? null;
  return { paperMinutes: value('gate.paperMinutes'), maxDrawdownPercent: value('gate.maxDrawdownPercent') };
}

/** The out-of-sample criteria a new run is judged against: an operator's row wins; with none, the boot value stands. */
export function verdictCriteriaOf(rows: readonly OwnerCriterionRow[], boot: QuantVerdictCriteria): QuantVerdictCriteria {
  const pick = (name: QuantOwnerCriterion, fallback: string | null) => {
    const row = rows.find((r) => r.name === name);
    return row ? row.value : fallback;
  };
  return {
    minTrades: pick('oos.minTrades', boot.minTrades),
    minReturnPercent: pick('oos.minReturnPercent', boot.minReturnPercent),
    maxDrawdownPercent: pick('oos.maxDrawdownPercent', boot.maxDrawdownPercent),
    maxShortfallPercent: pick('oos.maxShortfallPercent', boot.maxShortfallPercent),
  };
}

export interface GateInputs {
  readonly criteria: GateCriteria;
  /** This version's finished bar backtests as presented (verdict computed), newest first. */
  readonly backtests: readonly QuantBacktestResult[];
  /** This version's paper runs. */
  readonly paper: readonly { readonly runId: string; readonly startedAt: string; readonly stoppedAt: string | null }[];
  readonly risk: { readonly maxDrawdown: string; readonly maxNotional: string; readonly kill: string };
  readonly nowMs: number;
}

export interface GateReading {
  readonly approved: boolean;
  readonly unset: QuantGateCriterion[];
  readonly checks: QuantGateCheckResult[];
  /** The runs the gate read to approve: the validating backtest and the paper run. */
  readonly runIds: string[];
  /** The stage the version's own runs reach before any stage row. */
  readonly derivedStage: QuantStage;
}

const MINUTE_MS = 60_000;

/**
 * The promotion gate (ENGINE LC-3), from stored runs and the owner's stored criteria only. Each blank criterion is
 * named in `unset` and its check reads not set; nothing that is not set or not met ever approves.
 */
export function evaluateGate(input: GateInputs): GateReading {
  const unset = (Object.keys(input.criteria) as QuantGateCriterion[]).filter((name) => input.criteria[name] === null);
  const passing = input.backtests.find((run) => run.verdict.status === 'passed') ?? null;
  const newest = input.backtests[0] ?? null;

  const outOfSample: QuantGateCheckResult = {
    check: 'outOfSample',
    status: passing ? 'met' : 'not_met',
    criterion: null,
    observed: passing ? 'passed' : (newest?.verdict.status ?? null),
    runId: passing?.runId ?? newest?.runId ?? null,
  };

  const blankRisk = (Object.keys(input.risk) as (keyof GateInputs['risk'])[]).filter((name) => !input.risk[name].trim());
  const riskLimits: QuantGateCheckResult = {
    check: 'riskLimits',
    status: blankRisk.length ? 'not_met' : 'met',
    criterion: null,
    observed: blankRisk.length ? blankRisk.join(',') : null,
    runId: null,
  };

  const durations = input.paper.map((run) => ({
    runId: run.runId,
    ms: (run.stoppedAt ? Date.parse(run.stoppedAt) : input.nowMs) - Date.parse(run.startedAt),
  }));
  const longest = durations.sort((a, b) => b.ms - a.ms)[0] ?? null;
  const minutes = input.criteria.paperMinutes;
  const paperDuration: QuantGateCheckResult = {
    check: 'paperDuration',
    status: minutes === null ? 'not_set' : longest && longest.ms >= Number(minutes) * MINUTE_MS ? 'met' : 'not_met',
    criterion: { name: 'paperMinutes', value: minutes },
    observed: longest ? String(Math.floor(Math.max(0, longest.ms) / MINUTE_MS)) : null,
    runId: longest?.runId ?? null,
  };

  const ceiling = input.criteria.maxDrawdownPercent;
  const drawdown = passing?.metrics.risk.maxDrawdownPercent.value ?? null;
  const maxDrawdown: QuantGateCheckResult = {
    check: 'maxDrawdown',
    status: ceiling === null ? 'not_set' : drawdown !== null && parseAmount(drawdown) <= parseAmount(ceiling) ? 'met' : 'not_met',
    criterion: { name: 'maxDrawdownPercent', value: ceiling },
    observed: drawdown,
    runId: passing?.runId ?? null,
  };

  const checks = [outOfSample, riskLimits, paperDuration, maxDrawdown];
  const approved = unset.length === 0 && checks.every((check) => check.status === 'met');
  const derivedStage: QuantStage =
    passing && input.paper.length ? 'paper' : passing ? 'validated' : input.backtests.length ? 'backtested' : 'draft';
  return {
    approved,
    unset,
    checks,
    runIds: [passing?.runId, longest?.runId].filter((id): id is string => typeof id === 'string'),
    derivedStage,
  };
}
