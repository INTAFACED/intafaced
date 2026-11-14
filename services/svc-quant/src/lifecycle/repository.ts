import type { QuantGateDecision, QuantOwnerCriterion, QuantPromoteOutput, QuantStageRow } from '@intafaced/contracts';

/** One owner criterion as an operator stored it; null value is blank ("not set"). */
export interface OwnerCriterionRow {
  readonly name: QuantOwnerCriterion;
  readonly value: string | null;
  readonly setAt: string;
  /** Present only on a write's answer: true when the write put the criterion back to its boot value. */
  readonly toBoot?: boolean;
}

/** A version's stored lifecycle: its stage rows and gate decisions, oldest first. */
export interface VersionLifecycle {
  readonly stages: readonly QuantStageRow[];
  readonly decisions: readonly QuantGateDecision[];
}

export interface RecordPromotion {
  readonly key: string;
  readonly accountId: string;
  readonly strategyId: string;
  readonly strategyVersion: number;
  readonly actor: string;
  readonly decision: QuantGateDecision;
  /** Present only when the gate approved: written in the same transaction as the decision. */
  readonly stage: QuantStageRow | null;
  /** The answer as the caller read it, kept so a retry of the same key reads it back. */
  readonly response: Omit<QuantPromoteOutput, 'lifecycle'>;
}

/**
 * The lifecycle store (AL-lifecycle-01). A decision and its stage row are one write; the same key reads the first
 * answer back; a second move into the same stage of the same version is never stored.
 */
export interface LifecycleRepository {
  criteria(): Promise<readonly OwnerCriterionRow[]>;
  setCriterion(input: {
    readonly name: QuantOwnerCriterion;
    readonly value: string | null;
    /** Removes the operator's row, so the boot value stands again. */
    readonly toBoot: boolean;
    readonly reason: string;
    readonly actor: string;
    readonly idempotencyKey: string;
  }): Promise<OwnerCriterionRow>;
  of(input: { readonly accountId: string; readonly strategyId: string; readonly strategyVersion: number }): Promise<VersionLifecycle>;
  replay(accountId: string, key: string): Promise<RecordPromotion['response'] | null>;
  /** Stores the decision and its stage row. Returns null when that stage was already reached under another key. */
  record(input: RecordPromotion): Promise<RecordPromotion['response'] | null>;
}
