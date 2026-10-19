/**
 * quant.studio mount vs tracker — contract/refusal boundary (D-S-18).
 *
 * Visual builder shipped at /quant/studio (the Quant room in apps/customer + studio.save).
 * Residual: sandbox-escape test suite.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const QUANT_STUDIO_TRACKER_ID = 'quant.studio' as const;

export const QUANT_STUDIO_HONEST_GAPS = ['gap.sandbox_escape_suite'] as const;

export const QUANT_STUDIO_CONTRACT_FILES = ['quant-honesty.ts', 'quant-honesty.test.ts'] as const;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export function connectDataLakeTrackerDone(): boolean {
  const src = readFileSync(join(ROOT, 'tooling/tracker/features.mjs'), 'utf8');
  const match = src.match(/f\('connect\.data-lake'[\s\S]*?status:\s*'([^']+)'/);
  return match?.[1] === 'done';
}

export function quantStudioContractFilesPresent(): boolean {
  const here = dirname(fileURLToPath(import.meta.url));
  return QUANT_STUDIO_CONTRACT_FILES.every((file) => existsSync(join(here, file)));
}

export function quantStudioRefusalBoundaryInSource(): boolean {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, 'quant-honesty.ts'), 'utf8');
  return /assessBacktestSurface/.test(src) && /missing_out_of_sample_verdict/.test(src);
}

export function quantStudioVisualBuilderPresent(): boolean {
  return existsSync(join(ROOT, 'apps/customer/src/features/more/Quant.tsx'));
}

export function quantStudioTrackerBackendDoneBarMet(): boolean {
  return (
    connectDataLakeTrackerDone() &&
    quantStudioContractFilesPresent() &&
    quantStudioRefusalBoundaryInSource() &&
    quantStudioVisualBuilderPresent()
  );
}

export function quantStudioMountVsTrackerBoardCard(): {
  readonly tracker: typeof QUANT_STUDIO_TRACKER_ID;
  readonly gaps: number;
  readonly backendDoneBarMet: boolean;
  readonly dataLakeDependencyMet: boolean;
} {
  return {
    tracker: QUANT_STUDIO_TRACKER_ID,
    gaps: QUANT_STUDIO_HONEST_GAPS.length,
    backendDoneBarMet: quantStudioTrackerBackendDoneBarMet(),
    dataLakeDependencyMet: connectDataLakeTrackerDone(),
  };
}
