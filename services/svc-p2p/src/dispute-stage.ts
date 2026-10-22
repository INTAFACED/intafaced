/**
 * Dispute stages beside the trade status (P-disputes-security-02,
 * p2p-disputes-security-004/-006; ENGINE-SPEC R5).
 *
 * Pure rules only: the edge list, `assertStage`, timed transitions and the
 * party/operator event redaction. A stage is NOT a trade status and is never
 * added to TRADE_STATUSES: no function here touches escrow, and a stage change
 * can only ever produce another stage.
 *
 * Not wired yet: the `stage`/`stage_deadline_at` columns and the append-only
 * `dispute_events` table (migration), the sweeper hook and the new
 * `disputes.events` read. A new procedure must first be mapped in the existing
 * leak sweep, which is an existing-test edit and waits for an exception.
 *
 * `waiting_on_party` is included now because P-disputes-security-05 (request
 * for information) needs it in this list; it is not terminal and returns to
 * review.
 */

export const DISPUTE_STAGES = [
  'counterparty_response',
  'providing_proof',
  'under_review',
  'under_investigation',
  'waiting_on_party',
  'pending_processing',
  'resolved',
  'cancelled',
] as const;
export type DisputeStage = (typeof DISPUTE_STAGES)[number];

export const TERMINAL_STAGES: ReadonlySet<DisputeStage> = new Set<DisputeStage>(['resolved', 'cancelled']);

/** The stage a newly opened dispute starts in. */
export const INITIAL_STAGE: DisputeStage = 'counterparty_response';

const EDGES: Readonly<Record<DisputeStage, readonly DisputeStage[]>> = {
  counterparty_response: ['providing_proof', 'under_review', 'waiting_on_party', 'cancelled'],
  providing_proof: ['under_review', 'waiting_on_party', 'cancelled'],
  under_review: ['providing_proof', 'under_investigation', 'waiting_on_party', 'pending_processing', 'cancelled'],
  under_investigation: ['under_review', 'waiting_on_party', 'pending_processing'],
  waiting_on_party: ['under_review', 'under_investigation'],
  // A ruling is being carried out; only completion follows.
  pending_processing: ['resolved'],
  resolved: [],
  cancelled: [],
};

export type DisputeStageCode = 'p2p.invalid_stage' | 'p2p.dispute_resolved' | 'p2p.config_unset';

export class DisputeStageError extends Error {
  constructor(
    message: string,
    readonly code: DisputeStageCode,
  ) {
    super(message);
    this.name = 'DisputeStageError';
  }
}

export function isDisputeStage(v: unknown): v is DisputeStage {
  return typeof v === 'string' && (DISPUTE_STAGES as readonly string[]).includes(v);
}

export function canMoveStage(from: DisputeStage, to: DisputeStage): boolean {
  return EDGES[from].includes(to);
}

export function assertStage(from: unknown, to: unknown): void {
  if (!isDisputeStage(from) || !isDisputeStage(to)) {
    throw new DisputeStageError('Unknown dispute stage.', 'p2p.invalid_stage');
  }
  if (TERMINAL_STAGES.has(from)) {
    throw new DisputeStageError(`The dispute is already ${from}.`, 'p2p.dispute_resolved');
  }
  if (!canMoveStage(from, to)) {
    throw new DisputeStageError(`A dispute cannot move from ${from} to ${to}.`, 'p2p.invalid_stage');
  }
}

/** Owner-published timer seconds. Blank (null/undefined) refuses `p2p.config_unset` when needed. */
export interface StageTimers {
  respondentWindowSeconds?: number | null;
  proofWindowSeconds?: number | null;
}

const TIMED: Partial<Record<DisputeStage, keyof StageTimers>> = {
  counterparty_response: 'respondentWindowSeconds',
  providing_proof: 'proofWindowSeconds',
};

/** Deadline for entering `stage` at `now`; null for untimed stages. Blank or bad timer refuses. */
export function stageDeadline(stage: DisputeStage, now: Date, timers: StageTimers): Date | null {
  const key = TIMED[stage];
  if (!key) return null;
  const s = timers[key];
  if (typeof s !== 'number' || !Number.isSafeInteger(s) || s <= 0) {
    throw new DisputeStageError(`Dispute timer ${key} is not set.`, 'p2p.config_unset');
  }
  const at = new Date(now.getTime() + s * 1000);
  // A huge safe-integer timer overflows Date (Invalid Date), which would fire at once: refuse.
  if (!Number.isFinite(at.getTime()) || !Number.isFinite(now.getTime())) {
    throw new DisputeStageError(`Dispute timer ${key} is out of range.`, 'p2p.config_unset');
  }
  return at;
}

/**
 * The sweeper's move for an expired timed stage: both windows fall to
 * `under_review`. Returns null when nothing is due. Never touches escrow.
 */
export function timedTransition(stage: DisputeStage, deadlineAt: Date | null, now: Date): { from: DisputeStage; to: DisputeStage } | null {
  if (!TIMED[stage] || !deadlineAt) return null;
  // Fail-closed: an invalid deadline or clock never fires a transition.
  if (!Number.isFinite(deadlineAt.getTime()) || !Number.isFinite(now.getTime())) {
    throw new DisputeStageError('Dispute deadline is invalid.', 'p2p.config_unset');
  }
  if (now < deadlineAt) return null;
  assertStage(stage, 'under_review');
  return { from: stage, to: 'under_review' };
}

export const DISPUTE_EVENT_KINDS = [
  'stage_changed',
  'evidence_added',
  'info_requested',
  'info_answered',
  'note',
  'escalated',
  'ruling',
] as const;
export type DisputeEventKind = (typeof DISPUTE_EVENT_KINDS)[number];

export interface DisputeEvent {
  id: string;
  kind: DisputeEventKind;
  at: Date;
  actor: string;
  /** Internal by default: only an explicit `true` makes an event visible to the parties. */
  visibleToParties?: boolean;
  body?: string;
  stage?: DisputeStage;
}

/**
 * The `disputes.events` read. Operators see everything. Parties never see a
 * `note` (internal notes) and never see an event not explicitly marked
 * visible: missing flag = hidden (fail-closed).
 */
export function eventsFor(viewer: 'party' | 'operator', events: readonly DisputeEvent[]): DisputeEvent[] {
  if (viewer === 'operator') return [...events];
  return events.filter((e) => e.kind !== 'note' && e.visibleToParties === true);
}
