/**
 * Moderator request for information and case claim/assign with a lease
 * (P-disputes-security-05).
 *
 * Pure rules only. Builds on the P-disputes-security-02 stage list
 * (`waiting_on_party`). Not wired yet: the info-request and assignment tables
 * (migration), the `disputes.requestInfo/respondInfo/claim/assign` procedures
 * (a new procedure must be mapped in the existing leak sweep, which needs an
 * exception), and party delivery. Lead D77: there is NO direct svc-p2p to
 * svc-notify call here; delivery waits for the event outbox or a lead ruling.
 *
 * The database claim must be one atomic statement; `CLAIM_SQL_SHAPE` documents
 * it, and `decideClaim` is the same rule for tests and for reading a row.
 */

import { assertStage, type DisputeStage } from './dispute-stage.js';

export type CaseworkCode =
  'p2p.case_claimed' | 'p2p.request_expired' | 'p2p.not_the_addressee' | 'p2p.config_unset' | 'p2p.invalid_stage' | 'p2p.dispute_resolved';

export class CaseworkError extends Error {
  constructor(
    message: string,
    readonly code: CaseworkCode,
  ) {
    super(message);
    this.name = 'CaseworkError';
  }
}

export type InfoRequestStatus = 'open' | 'answered' | 'expired';

export interface InfoRequest {
  id: string;
  disputeId: string;
  addresseeId: string;
  status: InfoRequestStatus;
  expiresAt: Date;
  /** The stage to return to when answered or expired. */
  returnStage: DisputeStage;
}

function requireSeconds(v: number | null | undefined, what: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) {
    throw new CaseworkError(`${what} is not set.`, 'p2p.config_unset');
  }
  return v;
}

function validTime(d: Date | null | undefined): d is Date {
  return d instanceof Date && Number.isFinite(d.getTime());
}

/** `now + secs`, refusing `p2p.config_unset` when the result would be an Invalid Date (huge seconds). */
function addSeconds(now: Date, secs: number, what: string): Date {
  const at = new Date(now.getTime() + secs * 1000);
  if (!validTime(now) || !validTime(at)) throw new CaseworkError(`${what} is out of range.`, 'p2p.config_unset');
  return at;
}

/** Open a request: the dispute moves to waiting_on_party. Blank expiry refuses. */
export function openInfoRequest(input: {
  id: string;
  disputeId: string;
  stage: DisputeStage;
  addresseeId: string;
  parties: { buyerId: string; sellerId: string };
  expirySeconds: number | null | undefined;
  now: Date;
}): { request: InfoRequest; stage: DisputeStage } {
  const secs = requireSeconds(input.expirySeconds, 'Information request expiry');
  if (!input.addresseeId || (input.addresseeId !== input.parties.buyerId && input.addresseeId !== input.parties.sellerId)) {
    throw new CaseworkError('A request can be addressed only to a party of the trade.', 'p2p.not_the_addressee');
  }
  try {
    assertStage(input.stage, 'waiting_on_party');
  } catch (e) {
    const code = (e as { code?: string }).code;
    throw new CaseworkError((e as Error).message, code === 'p2p.dispute_resolved' ? 'p2p.dispute_resolved' : 'p2p.invalid_stage');
  }
  return {
    stage: 'waiting_on_party',
    request: {
      id: input.id,
      disputeId: input.disputeId,
      addresseeId: input.addresseeId,
      status: 'open',
      expiresAt: addSeconds(input.now, secs, 'Information request expiry'),
      returnStage: input.stage === 'under_investigation' ? 'under_investigation' : 'under_review',
    },
  };
}

/** Answer: only the addressee, only while open and unexpired. Returns the stage to go back to. */
export function answerInfoRequest(req: InfoRequest, userId: string, now: Date): { request: InfoRequest; stage: DisputeStage } {
  if (!userId || userId !== req.addresseeId) throw new CaseworkError('This request is not addressed to you.', 'p2p.not_the_addressee');
  if (req.status !== 'open' || !validTime(req.expiresAt) || !validTime(now) || now >= req.expiresAt)
    throw new CaseworkError('This request has expired or closed.', 'p2p.request_expired');
  return { request: { ...req, status: 'answered' }, stage: req.returnStage };
}

/** Sweeper: an open request past expiry expires and the case returns to review (moderator is told by the caller). */
export function expireInfoRequest(req: InfoRequest, now: Date): { request: InfoRequest; stage: DisputeStage } | null {
  if (req.status !== 'open') return null;
  if (!validTime(req.expiresAt) || !validTime(now)) {
    throw new CaseworkError('Information request expiry is invalid.', 'p2p.config_unset');
  }
  if (now < req.expiresAt) return null;
  return { request: { ...req, status: 'expired' }, stage: req.returnStage };
}

export interface Assignment {
  agentId: string | null;
  leaseUntil: Date | null;
}

/**
 * A lease that has run out counts as unassigned. Fail-closed: an agent with an
 * invalid (or missing) lease time or an invalid clock still counts as holding
 * the case; it is never read as unheld.
 */
export function currentAgent(a: Assignment, now: Date): string | null {
  if (!a.agentId) return null;
  if (!validTime(a.leaseUntil) || !validTime(now)) return a.agentId;
  return now < a.leaseUntil ? a.agentId : null;
}

/**
 * Claim rule: free (or lease expired) → claimed with a new lease; the same
 * agent renews; anyone else refuses `p2p.case_claimed`. Blank lease refuses.
 */
export function decideClaim(a: Assignment, agentId: string, leaseSeconds: number | null | undefined, now: Date): Assignment {
  const secs = requireSeconds(leaseSeconds, 'Case lease');
  if (!agentId) throw new CaseworkError('An agent is required.', 'p2p.case_claimed');
  const holder = currentAgent(a, now);
  if (holder && holder !== agentId) throw new CaseworkError('Another agent holds this case.', 'p2p.case_claimed');
  return { agentId, leaseUntil: addSeconds(now, secs, 'Case lease') };
}

/**
 * Required claim statement for the repo/mount slice: an upsert, so the first
 * claim works without a pre-existing row and 0 rows unambiguously means held
 * (`p2p.case_claimed`). The database clock (`now()`) is the only authority;
 * `decideClaim`'s caller-supplied `now` is for tests and display only.
 * UNPROVEN until the Postgres concurrency test runs.
 */
export const CLAIM_UPSERT_SQL_SHAPE =
  'INSERT INTO p2p.p2p_dispute_assignments (dispute_id, agent_id, lease_until) VALUES ($id, $agent, now() + $lease) ' +
  'ON CONFLICT (dispute_id) DO UPDATE SET agent_id = EXCLUDED.agent_id, lease_until = EXCLUDED.lease_until ' +
  'WHERE p2p_dispute_assignments.agent_id IS NULL OR p2p_dispute_assignments.lease_until <= now() ' +
  'OR p2p_dispute_assignments.agent_id = EXCLUDED.agent_id RETURNING agent_id';

/** Superseded by CLAIM_UPSERT_SQL_SHAPE (UPDATE-only needs an existing row). The single atomic statement the claim must use once the table exists (no read-then-write). */
export const CLAIM_SQL_SHAPE =
  'UPDATE p2p.p2p_dispute_assignments SET agent_id = $agent, lease_until = $until ' +
  'WHERE dispute_id = $id AND (agent_id IS NULL OR lease_until <= now() OR agent_id = $agent) RETURNING agent_id';

export type SlaBadge = 'no_target' | 'on_track' | 'due_soon' | 'overdue';

/** Per-case-type target: blank = "no target set" (no colouring), never a default. */
export function slaBadge(openedAt: Date, targetSeconds: number | null | undefined, now: Date): SlaBadge {
  if (targetSeconds === null || targetSeconds === undefined) return 'no_target';
  const secs = requireSeconds(targetSeconds, 'SLA target');
  const due = openedAt.getTime() + secs * 1000;
  if (now.getTime() >= due) return 'overdue';
  return now.getTime() >= due - (secs * 1000) / 5 ? 'due_soon' : 'on_track';
}
