/**
 * §29 Quant honesty boundary (D26-P1-X6).
 *
 * This package builds no backtest engine and computes no return. It is the
 * contract/refusal door that must exist before any result surface: incomplete
 * evidence is refused instead of being rendered with a caveat.
 */

export const OUT_OF_SAMPLE_STATUSES = ['passed', 'failed', 'inconclusive'] as const;
export type OutOfSampleStatus = (typeof OUT_OF_SAMPLE_STATUSES)[number];

export interface OutOfSampleVerdict {
  readonly status: OutOfSampleStatus;
  readonly evaluatedFrom: string;
  readonly evaluatedTo: string;
  readonly sampleCount: number;
}

export const FEE_MODEL_KINDS = ['venue-schedule', 'tiered-venue-schedule'] as const;
export type FeeModelKind = (typeof FEE_MODEL_KINDS)[number];

export const SLIPPAGE_MODEL_KINDS = ['order-book-replay', 'measured-impact'] as const;
export type SlippageModelKind = (typeof SLIPPAGE_MODEL_KINDS)[number];

export const LATENCY_MODEL_KINDS = ['measured-distribution', 'event-replay'] as const;
export type LatencyModelKind = (typeof LATENCY_MODEL_KINDS)[number];

export interface CostModelEvidence<TKind extends string> {
  readonly kind: TKind;
  /** Immutable source/version reference supplied by §27 Connect or its data lake. */
  readonly source: string;
}

export interface BacktestCostModel {
  readonly fees?: CostModelEvidence<FeeModelKind> | null;
  readonly slippage?: CostModelEvidence<SlippageModelKind> | null;
  readonly latency?: CostModelEvidence<LatencyModelKind> | null;
}

/**
 * Candidate evidence supplied by a future backtest engine.
 *
 * Optional members are deliberate: external/runtime data can be incomplete.
 * `assessBacktestSurface` is the fail-closed boundary that turns incomplete
 * candidates into typed refusals.
 */
export interface BacktestSurfaceCandidate {
  readonly runId: string;
  readonly strategyId: string;
  readonly strategyVariantCount?: number;
  readonly outOfSampleVerdict?: OutOfSampleVerdict | null;
  readonly costModel?: BacktestCostModel | null;
}

export type BacktestSurfaceRefusalCode =
  | 'invalid_run_identity'
  | 'missing_out_of_sample_verdict'
  | 'invalid_out_of_sample_verdict'
  | 'missing_fee_model'
  | 'invalid_fee_model'
  | 'missing_slippage_model'
  | 'invalid_slippage_model'
  | 'missing_latency_model'
  | 'invalid_latency_model'
  | 'invalid_strategy_count';

export interface BacktestSurfaceRefusal {
  readonly code: BacktestSurfaceRefusalCode;
  readonly detail: string;
}

export interface BacktestCostDisclosure {
  readonly component: 'fees' | 'slippage' | 'latency';
  readonly modelled: true;
  readonly model: FeeModelKind | SlippageModelKind | LatencyModelKind;
  readonly source: string;
}

export interface RenderableBacktestSurface {
  readonly runId: string;
  readonly strategyId: string;
  readonly claimLabel: 'Historical simulation — not a forecast';
  readonly outOfSample: OutOfSampleVerdict & {
    readonly label: `Out-of-sample: ${OutOfSampleStatus}`;
  };
  readonly strategyCount: {
    readonly value: number;
    readonly label: `${number} strategies tested`;
  };
  readonly costs: readonly [BacktestCostDisclosure, BacktestCostDisclosure, BacktestCostDisclosure];
}

export type BacktestSurfaceAssessment =
  { readonly ok: true; readonly surface: RenderableBacktestSurface } | { readonly ok: false; readonly refusal: BacktestSurfaceRefusal };

function refuse(code: BacktestSurfaceRefusalCode, detail: string): BacktestSurfaceAssessment {
  return { ok: false, refusal: { code, detail } };
}

function validIdentity(value: string): boolean {
  return value.trim().length > 0;
}

function validIsoInstant(value: string): number | null {
  if (value.trim().length === 0) return null;
  const epoch = Date.parse(value);
  return Number.isFinite(epoch) ? epoch : null;
}

function validOutOfSampleVerdict(verdict: OutOfSampleVerdict): boolean {
  if (!(OUT_OF_SAMPLE_STATUSES as readonly string[]).includes(verdict.status)) return false;
  if (!Number.isSafeInteger(verdict.sampleCount) || verdict.sampleCount < 1) return false;

  const from = validIsoInstant(verdict.evaluatedFrom);
  const to = validIsoInstant(verdict.evaluatedTo);
  return from !== null && to !== null && from < to;
}

function validCostEvidence<TKind extends string>(evidence: CostModelEvidence<TKind>, allowedKinds: readonly string[]): boolean {
  return allowedKinds.includes(evidence.kind) && evidence.source.trim().length > 0;
}

/**
 * Refuse-first gate for every future Quant result surface.
 *
 * A caller receives a renderable contract only when every §29 honesty fact is
 * present. No return field is accepted or calculated here, so this boundary
 * cannot invent a performance claim while the engine/data lake is absent.
 */
export function assessBacktestSurface(candidate: BacktestSurfaceCandidate): BacktestSurfaceAssessment {
  if (!validIdentity(candidate.runId) || !validIdentity(candidate.strategyId)) {
    return refuse('invalid_run_identity', 'runId and strategyId must be non-blank source identities');
  }

  const verdict = candidate.outOfSampleVerdict;
  if (!verdict) {
    return refuse('missing_out_of_sample_verdict', 'out-of-sample verdict is mandatory; the result must not render');
  }
  if (!validOutOfSampleVerdict(verdict)) {
    return refuse('invalid_out_of_sample_verdict', 'out-of-sample verdict needs a valid ordered window and a positive sample count');
  }

  const fees = candidate.costModel?.fees;
  if (!fees) return refuse('missing_fee_model', 'fees must be modelled; the run must be refused');
  if (!validCostEvidence(fees, FEE_MODEL_KINDS)) {
    return refuse('invalid_fee_model', 'fee model kind and source provenance must be declared');
  }

  const slippage = candidate.costModel?.slippage;
  if (!slippage) return refuse('missing_slippage_model', 'slippage must be modelled; the run must be refused');
  if (!validCostEvidence(slippage, SLIPPAGE_MODEL_KINDS)) {
    return refuse('invalid_slippage_model', 'slippage model kind and source provenance must be declared');
  }

  const latency = candidate.costModel?.latency;
  if (!latency) return refuse('missing_latency_model', 'latency must be modelled; the run must be refused');
  if (!validCostEvidence(latency, LATENCY_MODEL_KINDS)) {
    return refuse('invalid_latency_model', 'latency model kind and source provenance must be declared');
  }

  const strategyCount = candidate.strategyVariantCount;
  if (!Number.isSafeInteger(strategyCount) || strategyCount === undefined || strategyCount < 1) {
    return refuse('invalid_strategy_count', 'a positive integer strategy variant count is mandatory');
  }

  return {
    ok: true,
    surface: {
      runId: candidate.runId,
      strategyId: candidate.strategyId,
      claimLabel: 'Historical simulation — not a forecast',
      outOfSample: {
        status: verdict.status,
        evaluatedFrom: verdict.evaluatedFrom,
        evaluatedTo: verdict.evaluatedTo,
        sampleCount: verdict.sampleCount,
        label: `Out-of-sample: ${verdict.status}`,
      },
      strategyCount: {
        value: strategyCount,
        label: `${strategyCount} strategies tested`,
      },
      costs: [
        { component: 'fees', modelled: true, model: fees.kind, source: fees.source },
        { component: 'slippage', modelled: true, model: slippage.kind, source: slippage.source },
        { component: 'latency', modelled: true, model: latency.kind, source: latency.source },
      ],
    },
  };
}

export const ALLOWED_STRATEGY_COMPARISON_ORDERS = ['strategy_name', 'created_at'] as const;
export type StrategyComparisonOrder = (typeof ALLOWED_STRATEGY_COMPARISON_ORDERS)[number];

export type StrategyComparisonOrderAssessment =
  | { readonly ok: true; readonly order: StrategyComparisonOrder }
  | {
      readonly ok: false;
      readonly refusal: {
        readonly code: 'returns_ranked_leaderboard_forbidden' | 'unsupported_comparison_order';
        readonly detail: string;
      };
    };

/**
 * Runtime guard for untyped HTTP/UI input. Historical performance is never an
 * ordering option, even when the return itself was calculated truthfully.
 */
export function assessStrategyComparisonOrder(order: string): StrategyComparisonOrderAssessment {
  if (order === 'historical_return') {
    return {
      ok: false,
      refusal: {
        code: 'returns_ranked_leaderboard_forbidden',
        detail: 'historical return cannot order a strategy comparison',
      },
    };
  }
  if ((ALLOWED_STRATEGY_COMPARISON_ORDERS as readonly string[]).includes(order)) {
    return { ok: true, order: order as StrategyComparisonOrder };
  }
  return {
    ok: false,
    refusal: {
      code: 'unsupported_comparison_order',
      detail: 'strategy comparisons support only stable non-performance ordering',
    },
  };
}

export interface PerformanceContextLabel {
  readonly text: 'Live performance' | 'Historical simulation';
  readonly visualWeight: 'primary';
}

/** Equal-weight labels required when live and simulated performance coexist. */
export function buildPerformanceContextLabels(): {
  readonly live: PerformanceContextLabel;
  readonly backtest: PerformanceContextLabel;
} {
  return {
    live: { text: 'Live performance', visualWeight: 'primary' },
    backtest: { text: 'Historical simulation', visualWeight: 'primary' },
  };
}

export const QUANT_PERFORMANCE_ENVIRONMENTS = ['live', 'paper', 'backtest', 'shadow'] as const;
export type QuantPerformanceEnvironment = (typeof QUANT_PERFORMANCE_ENVIRONMENTS)[number];

export const SIMULATED_PERFORMANCE_ENVIRONMENTS = ['paper', 'backtest', 'shadow'] as const;
export type SimulatedPerformanceEnvironment = (typeof SIMULATED_PERFORMANCE_ENVIRONMENTS)[number];

export type SimulatedNotLiveRefusalCode = 'missing_environment' | 'unknown_environment' | 'live_environment_refused' | 'simulated_as_live';

export type SimulatedClaimLabel =
  'Paper — not live performance' | 'Historical simulation — not a forecast' | 'Shadow — not live performance';

export interface SimulatedPerformanceStamp {
  readonly environment: SimulatedPerformanceEnvironment;
  readonly kind: 'paper' | 'simulated';
  readonly claimLabel: SimulatedClaimLabel;
  readonly live: false;
  readonly simulated: true;
}

export type SimulatedNotLiveAssessment =
  | { readonly ok: true; readonly stamp: SimulatedPerformanceStamp }
  | { readonly ok: false; readonly refusal: { readonly code: SimulatedNotLiveRefusalCode; readonly detail: string } };

const CLAIM_BY_ENV = {
  paper: 'Paper — not live performance',
  backtest: 'Historical simulation — not a forecast',
  shadow: 'Shadow — not live performance',
} as const satisfies Record<SimulatedPerformanceEnvironment, SimulatedClaimLabel>;

const KIND_BY_ENV = {
  paper: 'paper',
  backtest: 'simulated',
  shadow: 'simulated',
} as const satisfies Record<SimulatedPerformanceEnvironment, 'paper' | 'simulated'>;

function refuseSimulatedNotLive(code: SimulatedNotLiveRefusalCode, detail: string): SimulatedNotLiveAssessment {
  return { ok: false, refusal: { code, detail } };
}

function presentedAsLive(presentedAs: string): boolean {
  const normalized = presentedAs.trim().toLowerCase();
  return normalized === 'live' || normalized === 'live performance';
}

/**
 * Paper / backtest / shadow results cannot be labelled or returned as live.
 * Missing environment refuses closed — never default to live.
 */
export function assessSimulatedNotLive(input: {
  readonly environment?: string | null;
  readonly presentedAs?: string | null;
  readonly allowed?: readonly SimulatedPerformanceEnvironment[];
}): SimulatedNotLiveAssessment {
  const envRaw = input.environment?.trim() ?? '';
  if (envRaw.length === 0) {
    return refuseSimulatedNotLive('missing_environment', 'environment is required — never default to live');
  }
  if (envRaw === 'live') {
    return refuseSimulatedNotLive('live_environment_refused', 'paper, backtest, and shadow results cannot run or render as live');
  }
  if (!(SIMULATED_PERFORMANCE_ENVIRONMENTS as readonly string[]).includes(envRaw)) {
    return refuseSimulatedNotLive('unknown_environment', 'environment must be live, paper, backtest, or shadow');
  }

  const environment = envRaw as SimulatedPerformanceEnvironment;
  if (input.allowed && !input.allowed.includes(environment)) {
    return refuseSimulatedNotLive('unknown_environment', `this surface admits ${input.allowed.join(', ')} — not ${environment}`);
  }

  const presented = input.presentedAs?.trim() ?? '';
  if (presented.length > 0 && presentedAsLive(presented)) {
    return refuseSimulatedNotLive('simulated_as_live', 'simulated or paper PnL cannot be presented as live');
  }

  return {
    ok: true,
    stamp: {
      environment,
      kind: KIND_BY_ENV[environment],
      claimLabel: CLAIM_BY_ENV[environment],
      live: false,
      simulated: true,
    },
  };
}
