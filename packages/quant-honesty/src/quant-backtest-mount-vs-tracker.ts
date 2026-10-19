/**
 * quant.backtest mount vs tracker — contract/refusal boundary (D-S-18).
 *
 * Event-level engine + walk-forward shipped (backtest.run). Residual: Monte Carlo.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const QUANT_BACKTEST_TRACKER_ID = 'quant.backtest' as const;

export const QUANT_BACKTEST_HONEST_GAPS = ['gap.monte_carlo'] as const;

export const QUANT_BACKTEST_CONTRACT_FILES = ['quant-honesty.ts', 'quant-honesty.test.ts'] as const;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export function connectDataLakeTrackerDone(): boolean {
  const src = readFileSync(join(ROOT, 'tooling/tracker/features.mjs'), 'utf8');
  const match = src.match(/f\('connect\.data-lake'[\s\S]*?status:\s*'([^']+)'/);
  return match?.[1] === 'done';
}

export function quantStudioTrackerDone(): boolean {
  const src = readFileSync(join(ROOT, 'tooling/tracker/features.mjs'), 'utf8');
  const match = src.match(/f\('quant\.studio'[\s\S]*?status:\s*'([^']+)'/);
  return match?.[1] === 'done';
}

export function quantBacktestContractFilesPresent(): boolean {
  const here = dirname(fileURLToPath(import.meta.url));
  return QUANT_BACKTEST_CONTRACT_FILES.every((file) => existsSync(join(here, file)));
}

export function quantBacktestRefusalBoundaryInSource(): boolean {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, 'quant-honesty.ts'), 'utf8');
  return (
    /assessBacktestSurface/.test(src) &&
    /missing_out_of_sample_verdict/.test(src) &&
    /assessStrategyComparisonOrder/.test(src) &&
    /buildPerformanceContextLabels/.test(src)
  );
}

export function quantBacktestEventEnginePresent(): boolean {
  return (
    existsSync(join(ROOT, 'services/svc-quant/src/backtest/run.ts')) && existsSync(join(ROOT, 'apps/customer/src/features/more/Quant.tsx'))
  );
}

export function quantBacktestTrackerBackendDoneBarMet(): boolean {
  return (
    connectDataLakeTrackerDone() &&
    quantStudioTrackerDone() &&
    quantBacktestContractFilesPresent() &&
    quantBacktestRefusalBoundaryInSource() &&
    quantBacktestEventEnginePresent()
  );
}

export function quantBacktestMountVsTrackerBoardCard(): {
  readonly tracker: typeof QUANT_BACKTEST_TRACKER_ID;
  readonly gaps: number;
  readonly backendDoneBarMet: boolean;
  readonly dataLakeDependencyMet: boolean;
  readonly studioDependencyMet: boolean;
} {
  return {
    tracker: QUANT_BACKTEST_TRACKER_ID,
    gaps: QUANT_BACKTEST_HONEST_GAPS.length,
    backendDoneBarMet: quantBacktestTrackerBackendDoneBarMet(),
    dataLakeDependencyMet: connectDataLakeTrackerDone(),
    studioDependencyMet: quantStudioTrackerDone(),
  };
}
