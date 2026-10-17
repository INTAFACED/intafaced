import type { ClaimRow, RunCounts, RunKind, RunListPage, StoredRun, StoredRunResult } from './types.js';

export interface BeginRun {
  readonly userId: string | null;
  readonly idempotencyKey: string;
  readonly kind: RunKind;
  readonly strategyId: string | null;
  readonly strategyVersion: number | null;
}

export interface FinishRun {
  readonly id: string;
  readonly userId: string | null;
  readonly outcome: string;
  readonly stored: StoredRunResult;
}

export interface ClaimInput {
  readonly id: string;
  readonly runId: string;
  readonly userId: string;
  readonly idempotencyKey: string;
  readonly pnl: string;
  readonly environment: ClaimRow['environment'];
  readonly kind: ClaimRow['kind'];
  readonly claimLabel: ClaimRow['claimLabel'];
}

export interface RunRepository {
  replay(userId: string | null, idempotencyKey: string): Promise<StoredRun | null>;
  begin(input: BeginRun): Promise<StoredRun>;
  /** Sets finished and outcome once. A second call refuses. */
  finish(input: FinishRun): Promise<StoredRun>;
  get(input: { readonly userId: string; readonly id: string }): Promise<StoredRun | null>;
  list(input: {
    readonly from: string | null;
    readonly to: string | null;
    readonly kind: RunKind | null;
    readonly userId: string | null;
    readonly limit: number;
    readonly cursor: string | null;
  }): Promise<RunListPage>;
  counts(input: { readonly from: string; readonly to: string }): Promise<RunCounts>;
  claimOnce(input: ClaimInput): Promise<ClaimRow>;
}
