/**
 * Start one already-approved TWAP/VWAP/POV parent.
 *
 * Marks an injected approved parent `running` so children may take new later.
 * This door never creates the parent, never plans slices, never ticks,
 * never places children, and does not touch matching. Matching halt-all
 * (`venueHalted`) refuses — missing halt source refuses; never invent live.
 */
import { matchingVenueHaltRefuse, type MatchingVenueHalt } from './oms-matching-venue-halt.js';

export type AlgoKind = 'twap' | 'vwap' | 'pov';
export type ApprovedAlgoStatus = 'approved' | 'running' | 'stopped' | 'undeployed' | 'expired' | 'paper' | 'staged' | 'abandoned';

export type RetainedAlgoSchedule = {
  readonly durationMs: number;
  readonly sliceIntervalMs: number;
  readonly slicesPlanned: number;
  readonly participationBps: number | null; // POV only; null on TWAP/VWAP
  readonly expireAt?: string | null;
};

export type RetainedParentResidual = {
  readonly remaining: string;
  readonly released?: boolean;
};

export type ApprovedAlgoParent = {
  readonly parentClientOrderId: string;
  readonly kind: AlgoKind;
  readonly status: ApprovedAlgoStatus;
  readonly schedule: RetainedAlgoSchedule;
  readonly startedAt: string | null;
  readonly residual?: RetainedParentResidual | null;
  /** Current execution owner. Null/absent = unowned. Never invent an operator. */
  readonly executionOwner?: string | null;
  /** First claimer. Set once; shift/pass never overwrite. Distinct from executionOwner. */
  readonly originator?: string | null;
  /** Named target of an offered pass. Null/absent = no pending handoff. Owner stays responsible until accept. */
  readonly pendingPassTo?: string | null;
  /** Caller-supplied pass deadline. Null/absent = no pending pass timeout. Never invent from duration or the clock. */
  readonly pendingPassExpireAt?: string | null;
};

export interface ApprovedAlgoParentStore {
  get(parentClientOrderId: string): ApprovedAlgoParent | null;
  approve(parent: ApprovedAlgoParent): ApprovedAlgoParent;
  start(parentClientOrderId: string, startedAt: string, operatorId?: string): ApprovedAlgoParent | null;
  stop(parentClientOrderId: string): ApprovedAlgoParent | null;
  /** Live unattended kill — approved|running → stopped. Distinct from running-only stop. */
  kill?(parentClientOrderId: string): ApprovedAlgoParent | null;
  undeploy(parentClientOrderId: string): ApprovedAlgoParent | null;
  expire(parentClientOrderId: string): ApprovedAlgoParent | null;
  releaseResidual?(parentClientOrderId: string): ApprovedAlgoParent | null;
  /**
   * Writes leftover already computed by a door — never invents remaining.
   * When expectedRemaining is set, the write sticks only if the stored remaining is still that value.
   */
  consumeResidual?(parentClientOrderId: string, remaining: string, expectedRemaining?: string): ApprovedAlgoParent | null;
  paper?(parentClientOrderId: string): ApprovedAlgoParent | null;
  promote?(parentClientOrderId: string): ApprovedAlgoParent | null;
  /** Park an approved parent as staged (not live). Never invents an operator. */
  stage?(parentClientOrderId: string, operatorId: string): ApprovedAlgoParent | null;
  /** Release a staged parent to live (approved). Never invents an operator or a fill. */
  release?(parentClientOrderId: string, operatorId: string): ApprovedAlgoParent | null;
  /** Abandon a staged parent so it never goes live. Never invents an operator. Live uses undeployDrain. */
  abandon?(parentClientOrderId: string, operatorId: string): ApprovedAlgoParent | null;
  claim?(parentClientOrderId: string, operatorId: string): ApprovedAlgoParent | null;
  unclaim?(parentClientOrderId: string, operatorId: string): ApprovedAlgoParent | null;
  offerPass?(parentClientOrderId: string, fromOperatorId: string, toOperatorId: string, expireAt: string): ApprovedAlgoParent | null;
  acceptPass?(parentClientOrderId: string, operatorId: string): ApprovedAlgoParent | null;
  rejectPass?(parentClientOrderId: string, operatorId: string): ApprovedAlgoParent | null;
  timeoutPass?(parentClientOrderId: string): ApprovedAlgoParent | null;
  shift?(parentClientOrderId: string, fromOperatorId: string, toOperatorId: string): ApprovedAlgoParent | null;
  /** Scan used by the unattended desk door — never invents rows. */
  list?(): readonly ApprovedAlgoParent[];
}

export class InMemoryApprovedAlgoParentStore implements ApprovedAlgoParentStore {
  private readonly rows = new Map<string, ApprovedAlgoParent>();

  /** Tests only — never invent an approved parent on the live host. */
  seed(parent: ApprovedAlgoParent): void {
    this.rows.set(parent.parentClientOrderId, cloneParent(parent));
  }

  /** Put one row back after a journal append throws. Null means it was absent. */
  restore(parentClientOrderId: string, previous: ApprovedAlgoParent | null): void {
    if (!previous) {
      this.rows.delete(parentClientOrderId);
      return;
    }
    this.rows.set(parentClientOrderId, cloneParent(previous));
  }

  get(parentClientOrderId: string): ApprovedAlgoParent | null {
    const row = this.rows.get(parentClientOrderId);
    return row ? cloneParent(row) : null;
  }

  list(): readonly ApprovedAlgoParent[] {
    return [...this.rows.values()].map(cloneParent);
  }

  approve(parent: ApprovedAlgoParent): ApprovedAlgoParent {
    const next = cloneParent({ ...parent, status: 'approved', startedAt: null });
    this.rows.set(parent.parentClientOrderId, next);
    return cloneParent(next);
  }

  start(parentClientOrderId: string, startedAt: string, operatorId?: string): ApprovedAlgoParent | null {
    const row = this.rows.get(parentClientOrderId);
    if (!row) return null;
    const op = operatorId?.trim() ?? '';
    const current = row.executionOwner?.trim() ?? '';
    if (op && current && current !== op) return null;
    const originator = row.originator?.trim() || op;
    const next = cloneParent({
      ...row,
      status: 'running',
      startedAt,
      ...(op ? { executionOwner: op, originator } : {}),
    });
    this.rows.set(parentClientOrderId, next);
    return cloneParent(next);
  }

  stop(parentClientOrderId: string): ApprovedAlgoParent | null {
    const row = this.rows.get(parentClientOrderId);
    if (!row) return null;
    if (row.status !== 'running') return null;
    const next = cloneParent({ ...row, status: 'stopped' });
    this.rows.set(parentClientOrderId, next);
    return cloneParent(next);
  }

  kill(parentClientOrderId: string): ApprovedAlgoParent | null {
    const row = this.rows.get(parentClientOrderId);
    if (!row) return null;
    if (row.status !== 'approved' && row.status !== 'running') return null;
    const next = cloneParent({ ...row, status: 'stopped' });
    this.rows.set(parentClientOrderId, next);
    return cloneParent(next);
  }

  undeploy(parentClientOrderId: string): ApprovedAlgoParent | null {
    const row = this.rows.get(parentClientOrderId);
    if (!row) return null;
    if (row.status !== 'stopped') return null;
    const next = cloneParent({ ...row, status: 'undeployed' });
    this.rows.set(parentClientOrderId, next);
    return cloneParent(next);
  }

  expire(parentClientOrderId: string): ApprovedAlgoParent | null {
    const row = this.rows.get(parentClientOrderId);
    if (!row) return null;
    const expireAt = row.schedule.expireAt?.trim();
    if (!expireAt) return null;
    const next = cloneParent({ ...row, status: 'expired' });
    this.rows.set(parentClientOrderId, next);
    return cloneParent(next);
  }

  releaseResidual(parentClientOrderId: string): ApprovedAlgoParent | null {
    const row = this.rows.get(parentClientOrderId);
    if (!row) return null;
    const remaining = row.residual?.remaining?.trim();
    if (!remaining) return null;
    const next = cloneParent({
      ...row,
      residual: { remaining, released: true },
    });
    this.rows.set(parentClientOrderId, next);
    return cloneParent(next);
  }

  consumeResidual(parentClientOrderId: string, remaining: string, expectedRemaining?: string): ApprovedAlgoParent | null {
    const row = this.rows.get(parentClientOrderId);
    if (!row) return null;
    const current = row.residual?.remaining?.trim();
    if (!current) return null;
    const nextRemaining = remaining.trim();
    if (!nextRemaining) return null;
    if (expectedRemaining !== undefined && current !== expectedRemaining.trim()) return null;
    const next = cloneParent({
      ...row,
      residual: {
        remaining: nextRemaining,
        ...(row.residual?.released !== undefined ? { released: row.residual.released } : {}),
      },
    });
    this.rows.set(parentClientOrderId, next);
    return cloneParent(next);
  }

  paper(parentClientOrderId: string): ApprovedAlgoParent | null {
    const row = this.rows.get(parentClientOrderId);
    if (!row) return null;
    const next = cloneParent({ ...row, status: 'paper' });
    this.rows.set(parentClientOrderId, next);
    return cloneParent(next);
  }

  promote(parentClientOrderId: string): ApprovedAlgoParent | null {
    const row = this.rows.get(parentClientOrderId);
    if (!row) return null;
    if (row.status !== 'paper') return null;
    const remaining = row.residual?.remaining?.trim();
    if (!remaining) return null;
    if (row.residual?.released === true) return null;
    const next = cloneParent({ ...row, status: 'approved' });
    this.rows.set(parentClientOrderId, next);
    return cloneParent(next);
  }

  stage(parentClientOrderId: string, operatorId: string): ApprovedAlgoParent | null {
    const row = this.rows.get(parentClientOrderId);
    if (!row) return null;
    const op = operatorId.trim();
    if (!op) return null;
    if (row.status !== 'approved' && row.status !== 'staged') return null;
    const current = row.executionOwner?.trim() ?? '';
    if (current && current !== op) return null;
    const originator = row.originator?.trim() || op;
    const next = cloneParent({ ...row, status: 'staged', executionOwner: op, originator });
    this.rows.set(parentClientOrderId, next);
    return cloneParent(next);
  }

  release(parentClientOrderId: string, operatorId: string): ApprovedAlgoParent | null {
    const row = this.rows.get(parentClientOrderId);
    if (!row) return null;
    if (row.status !== 'staged') return null;
    const op = operatorId.trim();
    if (!op) return null;
    const current = row.executionOwner?.trim() ?? '';
    if (current && current !== op) return null;
    const originator = row.originator?.trim() || op;
    const next = cloneParent({ ...row, status: 'approved', executionOwner: op, originator });
    this.rows.set(parentClientOrderId, next);
    return cloneParent(next);
  }

  abandon(parentClientOrderId: string, operatorId: string): ApprovedAlgoParent | null {
    const row = this.rows.get(parentClientOrderId);
    if (!row) return null;
    const op = operatorId.trim();
    if (!op) return null;
    if (row.status !== 'staged' && row.status !== 'abandoned') return null;
    const current = row.executionOwner?.trim() ?? '';
    if (current && current !== op) return null;
    const originator = row.originator?.trim() || op;
    const next = cloneParent({ ...row, status: 'abandoned', executionOwner: op, originator });
    this.rows.set(parentClientOrderId, next);
    return cloneParent(next);
  }

  claim(parentClientOrderId: string, operatorId: string): ApprovedAlgoParent | null {
    const row = this.rows.get(parentClientOrderId);
    if (!row) return null;
    const current = row.executionOwner?.trim() ?? '';
    if (current && current !== operatorId) return null;
    const originator = row.originator?.trim() || operatorId;
    const next = cloneParent({ ...row, executionOwner: operatorId, originator });
    this.rows.set(parentClientOrderId, next);
    return cloneParent(next);
  }

  unclaim(parentClientOrderId: string, operatorId: string): ApprovedAlgoParent | null {
    const row = this.rows.get(parentClientOrderId);
    if (!row) return null;
    const current = row.executionOwner?.trim() ?? '';
    if (!current || current !== operatorId) return null;
    const pending = row.pendingPassTo?.trim() ?? '';
    if (pending) return null;
    const next = cloneParent({ ...row, executionOwner: null });
    this.rows.set(parentClientOrderId, next);
    return cloneParent(next);
  }

  offerPass(parentClientOrderId: string, fromOperatorId: string, toOperatorId: string, expireAt: string): ApprovedAlgoParent | null {
    const row = this.rows.get(parentClientOrderId);
    if (!row) return null;
    const current = row.executionOwner?.trim() ?? '';
    if (!current || current !== fromOperatorId) return null;
    if (!toOperatorId || toOperatorId === fromOperatorId) return null;
    const deadline = expireAt.trim();
    if (!deadline) return null;
    const pending = row.pendingPassTo?.trim() ?? '';
    if (pending && pending !== toOperatorId) return null;
    const next = cloneParent({ ...row, pendingPassTo: toOperatorId, pendingPassExpireAt: deadline });
    this.rows.set(parentClientOrderId, next);
    return cloneParent(next);
  }

  acceptPass(parentClientOrderId: string, operatorId: string): ApprovedAlgoParent | null {
    const row = this.rows.get(parentClientOrderId);
    if (!row) return null;
    const pending = row.pendingPassTo?.trim() ?? '';
    if (!pending || pending !== operatorId) return null;
    const next = cloneParent({
      ...row,
      executionOwner: operatorId,
      pendingPassTo: null,
      pendingPassExpireAt: null,
    });
    this.rows.set(parentClientOrderId, next);
    return cloneParent(next);
  }

  rejectPass(parentClientOrderId: string, operatorId: string): ApprovedAlgoParent | null {
    const row = this.rows.get(parentClientOrderId);
    if (!row) return null;
    const pending = row.pendingPassTo?.trim() ?? '';
    if (!pending || pending !== operatorId) return null;
    const next = cloneParent({ ...row, pendingPassTo: null, pendingPassExpireAt: null });
    this.rows.set(parentClientOrderId, next);
    return cloneParent(next);
  }

  timeoutPass(parentClientOrderId: string): ApprovedAlgoParent | null {
    const row = this.rows.get(parentClientOrderId);
    if (!row) return null;
    const pending = row.pendingPassTo?.trim() ?? '';
    if (!pending) return null;
    const deadline = row.pendingPassExpireAt?.trim() ?? '';
    if (!deadline) return null;
    const next = cloneParent({ ...row, pendingPassTo: null, pendingPassExpireAt: null });
    this.rows.set(parentClientOrderId, next);
    return cloneParent(next);
  }

  shift(parentClientOrderId: string, fromOperatorId: string, toOperatorId: string): ApprovedAlgoParent | null {
    const row = this.rows.get(parentClientOrderId);
    if (!row) return null;
    const current = row.executionOwner?.trim() ?? '';
    if (!current || current !== fromOperatorId) return null;
    if (!toOperatorId || toOperatorId === fromOperatorId) return null;
    const pending = row.pendingPassTo?.trim() ?? '';
    if (pending) return null;
    const originator = row.originator?.trim() || current;
    const next = cloneParent({
      ...row,
      originator,
      executionOwner: toOperatorId,
    });
    this.rows.set(parentClientOrderId, next);
    return cloneParent(next);
  }
}

export type AlgoJobsGate = { readonly enabled: boolean };

export type OmsStartOk = {
  readonly ok: true;
  readonly started: true;
  readonly parentClientOrderId: string;
  readonly kind: AlgoKind;
  readonly status: 'running';
  readonly schedule: RetainedAlgoSchedule;
  readonly startedAt: string;
};

export type OmsStartRefuse =
  | { readonly ok: false; readonly reason: 'missing_parent'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'parent_store_unwired'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'jobs_gate_unwired'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'jobs_off'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'not_found'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'unsupported_kind'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'not_approved'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'already_started'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'missing_schedule'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'missing_operator'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'not_owner'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'venue_halted'; readonly detail: string }
  | { readonly ok: false; readonly reason: 'venue_halt_unavailable'; readonly detail: string };

export type OmsStartResult = OmsStartOk | OmsStartRefuse;

function cloneSchedule(schedule: RetainedAlgoSchedule): RetainedAlgoSchedule {
  return {
    durationMs: schedule.durationMs,
    sliceIntervalMs: schedule.sliceIntervalMs,
    slicesPlanned: schedule.slicesPlanned,
    participationBps: schedule.participationBps,
    ...(schedule.expireAt !== undefined ? { expireAt: schedule.expireAt } : {}),
  };
}

function cloneResidual(residual: ApprovedAlgoParent['residual']): ApprovedAlgoParent['residual'] {
  if (residual == null) return residual;
  return {
    remaining: residual.remaining,
    ...(residual.released !== undefined ? { released: residual.released } : {}),
  };
}

function cloneParent(parent: ApprovedAlgoParent): ApprovedAlgoParent {
  return {
    parentClientOrderId: parent.parentClientOrderId,
    kind: parent.kind,
    status: parent.status,
    schedule: cloneSchedule(parent.schedule),
    startedAt: parent.startedAt,
    ...(parent.residual !== undefined ? { residual: cloneResidual(parent.residual) } : {}),
    ...(parent.executionOwner !== undefined ? { executionOwner: parent.executionOwner } : {}),
    ...(parent.originator !== undefined ? { originator: parent.originator } : {}),
    ...(parent.pendingPassTo !== undefined ? { pendingPassTo: parent.pendingPassTo } : {}),
    ...(parent.pendingPassExpireAt !== undefined ? { pendingPassExpireAt: parent.pendingPassExpireAt } : {}),
  };
}

function isAlgoKind(kind: string): kind is AlgoKind {
  return kind === 'twap' || kind === 'vwap' || kind === 'pov';
}

function refuse(reason: OmsStartRefuse['reason'], detail: string): OmsStartRefuse {
  return { ok: false, reason, detail };
}

function scheduleMissing(parent: ApprovedAlgoParent): boolean {
  const { durationMs, sliceIntervalMs, slicesPlanned, participationBps } = parent.schedule;
  if (!(durationMs > 0) || !(sliceIntervalMs > 0) || slicesPlanned < 1) return true;
  if (parent.kind === 'pov' && (participationBps === null || !Number.isInteger(participationBps))) return true;
  return false;
}

function operatorOf(operatorId?: string): string {
  return operatorId?.trim() ?? '';
}

function ownerOf(parent: ApprovedAlgoParent): string | null {
  const owner = parent.executionOwner?.trim() ?? '';
  return owner || null;
}

export function startApprovedAlgoParent(input: {
  parentClientOrderId?: string;
  operatorId?: string;
  parentStore?: ApprovedAlgoParentStore;
  jobs?: AlgoJobsGate;
  now?: Date;
  matchingVenueHalt?: MatchingVenueHalt | null;
}): OmsStartResult {
  const parentClientOrderId = input.parentClientOrderId?.trim() ?? '';
  if (!parentClientOrderId) {
    return refuse('missing_parent', 'parentClientOrderId is required');
  }
  if (!input.parentStore) {
    return refuse('parent_store_unwired', 'approved algo parent store is required for start');
  }
  if (!input.jobs) {
    return refuse('jobs_gate_unwired', 'algo jobs gate is required for start');
  }
  if (input.jobs.enabled === false) {
    return refuse('jobs_off', 'EXECUTION_ALGO_JOBS_ENABLED is off — refusing to invent a live start');
  }

  const existing = input.parentStore.get(parentClientOrderId);
  if (!existing) {
    return refuse('not_found', `no approved algo parent for ${parentClientOrderId}`);
  }
  if (!isAlgoKind(existing.kind)) {
    return refuse('unsupported_kind', `kind ${String(existing.kind)} is not twap|vwap|pov`);
  }
  if (existing.status === 'running') {
    return refuse('already_started', `parent ${parentClientOrderId} is already running`);
  }
  if (existing.status !== 'approved') {
    return refuse('not_approved', `parent ${parentClientOrderId} is not approved`);
  }
  if (scheduleMissing(existing)) {
    return refuse('missing_schedule', 'retained schedule is incomplete — refusing to invent slices');
  }
  const operatorId = operatorOf(input.operatorId);
  if (!operatorId) {
    return refuse('missing_operator', 'operator id is required — refusing to invent a user');
  }
  const current = ownerOf(existing);
  if (current && current !== operatorId) {
    return refuse('not_owner', `parent ${parentClientOrderId} is owned by ${current} — refusing steal`);
  }
  const halt = matchingVenueHaltRefuse(input.matchingVenueHalt);
  if (halt) return halt;

  const startedAt = (input.now ?? new Date()).toISOString();
  const started = input.parentStore.start(parentClientOrderId, startedAt, operatorId);
  if (!started) {
    return refuse('not_found', `no approved algo parent for ${parentClientOrderId}`);
  }
  const executionOwner = ownerOf(started);
  if (!executionOwner) {
    return refuse('missing_operator', 'operator id is required — refusing to invent a user');
  }

  return {
    ok: true,
    started: true,
    parentClientOrderId: started.parentClientOrderId,
    kind: started.kind,
    status: 'running',
    schedule: cloneSchedule(started.schedule),
    startedAt,
  };
}
