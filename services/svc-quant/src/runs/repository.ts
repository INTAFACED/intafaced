import type {
  ClaimRow,
  PaperSettings,
  RunCounts,
  RunHistoryPage,
  RunKind,
  RunListPage,
  StoredPaperRun,
  StoredRun,
  StoredRunResult,
} from './types.js';

export interface BeginRun {
  readonly userId: string | null;
  readonly idempotencyKey: string;
  readonly kind: RunKind;
  readonly strategyId: string | null;
  readonly strategyVersion: number | null;
  /** A paper run's start settings, stored in the same transaction as its row. */
  readonly paper?: PaperSettings;
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
  /** Whether this account has at least one finished run with outcome ok, per kind. Feeds the quick start ticks. */
  okKinds(input: { readonly userId: string }): Promise<{ readonly backtest: boolean; readonly sandbox: boolean }>;
  claimOnce(input: ClaimInput): Promise<ClaimRow>;
  /** One account's own runs of a kind whose key starts with `keyPrefix`, newest first, each with its label. */
  history(input: {
    readonly userId: string;
    readonly kind: RunKind;
    readonly keyPrefix: string;
    readonly limit: number;
    readonly cursor: string | null;
    /** Only the runs of this one strategy, when given (a strategy's own page). */
    readonly strategyId?: string | null;
  }): Promise<RunHistoryPage>;
  /**
   * How many distinct finished runs the account has of one strategy on one symbol and bar size, among the runs whose key
   * starts with `keyPrefix` (ENGINE MT-6). Each distinct run key is one variant tried; a replay is the same run.
   */
  variantCount(input: {
    readonly userId: string;
    readonly strategyId: string;
    readonly symbol: string;
    readonly barSize: string;
    readonly keyPrefix: string;
  }): Promise<number>;
  /**
   * Sets the label of one of the account's own runs. The label lives beside the run, never in it: the run row and its
   * result stay as they were stored. Another account's run refuses as not found.
   */
  setLabel(input: { readonly userId: string; readonly runId: string; readonly label: string }): Promise<{ readonly label: string }>;
  /** One account's paper runs, newest first, of one strategy when given. */
  paperRuns(input: {
    readonly userId: string;
    readonly strategyId: string | null;
    readonly limit: number;
  }): Promise<readonly StoredPaperRun[]>;
  /** One of the account's own paper runs; another account's reads as null. */
  paperRun(input: { readonly userId: string; readonly id: string }): Promise<StoredPaperRun | null>;
}
