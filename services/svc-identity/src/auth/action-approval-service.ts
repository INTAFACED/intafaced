/**
 * Issue and consume action-bound approval. A typed-in second name is not
 * authority. TTL is owner-published; blank refuses propose.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type {
  ActionApproval,
  ActionApprovalConsumeInput,
  ActionApprovalPolicy as GovernedPolicy,
  ActionApprovalPolicyEntry,
  ActionApprovalProposeInput,
} from '@intafaced/contracts';
import {
  ACTION_APPROVAL_ALREADY_APPROVED,
  ACTION_APPROVAL_AUDIENCE_MISMATCH,
  ACTION_APPROVAL_POLICY_CHANGED,
  ACTION_APPROVAL_POLICY_UNSET,
  SAME_PERSON_APPROVAL_TTL_SECONDS,
  governedActionTypeOf,
  isConsumableApproval,
  isSamePersonActionType,
  namesAreNotActionApproval,
  samePersonTargetService,
} from '@intafaced/contracts';
import {
  type ActionAudience,
  type ApprovalSubject,
  type FounderDirectory,
  audienceOfApproval,
  inFounderNamespace,
} from './action-approval-audience.js';
import { type ApprovalPolicySource, approvalPolicyEntries } from './action-approval-policy.js';
import {
  type ActionApprovalStore,
  type StoredApproval,
  approvalProvenance,
  newApprovalIds,
  toActionApproval,
} from './action-approval-store.js';

export const ACTION_APPROVAL_TTL_UNSET = 'action_approval.ttl_unset' as const;

export type ActionApprovalErrorCode =
  | typeof ACTION_APPROVAL_TTL_UNSET
  | 'action_approval.not_found'
  | 'action_approval.not_pending'
  | 'action_approval.not_approved'
  | 'action_approval.same_person'
  | 'action_approval.payload_mismatch'
  | 'action_approval.target_mismatch'
  | 'action_approval.expired'
  | 'action_approval.consumed'
  | 'action_approval.not_requester'
  | 'action_approval.service_mismatch'
  | 'action_approval.type_not_four_eyes'
  | 'action_approval.operator_only'
  | 'action_approval.trade_ops_only'
  | 'action_approval.founder_only'
  | 'action_approval.founders_unavailable'
  | 'action_approval.type_not_same_person'
  | 'action_approval.already_terminal'
  | typeof ACTION_APPROVAL_POLICY_UNSET
  | typeof ACTION_APPROVAL_POLICY_CHANGED
  | typeof ACTION_APPROVAL_AUDIENCE_MISMATCH
  | typeof ACTION_APPROVAL_ALREADY_APPROVED;

export class ActionApprovalError extends Error {
  constructor(
    message: string,
    readonly code: ActionApprovalErrorCode,
  ) {
    super(message);
    this.name = 'ActionApprovalError';
  }
}

export type ActionApprovalPolicy = {
  readonly ttlSeconds: number | undefined;
  /**
   * Who is a founder right now. Founder-only action types are refused at approve and at consume without it
   * (fail closed): an unwired directory never lets a founder-only approval through.
   */
  readonly founders?: FounderDirectory | undefined;
  /**
   * Owner policy rows for governed action types (OPS-change-control-01 CR-1), read again on every propose, approve and
   * consume. Absent, every governed type is `action_approval.policy_unset`. Ungoverned types never read it.
   */
  readonly policies?: ApprovalPolicySource | undefined;
};

/** Constant-time equality of two hash strings of any length (both are digested first, so length does not leak). */
export function payloadHashesEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a).digest();
  const db = createHash('sha256').update(b).digest();
  return timingSafeEqual(da, db);
}

export class ActionApprovalService {
  constructor(
    private readonly store: ActionApprovalStore,
    private readonly policy: ActionApprovalPolicy,
    private readonly clock: () => Date = () => new Date(),
    /** Same-person consume writes the customer step-up audit. Absent in unit tests. */
    private readonly onSamePersonConsumed?: (row: StoredApproval, at: Date) => Promise<void>,
  ) {}

  async propose(requesterId: string, input: ActionApprovalProposeInput): Promise<ActionApproval> {
    // Same-person step-up types have their own door (`createSamePerson`), which demands a fresh
    // factor. They are never four-eyes types, so a second person cannot approve one.
    if (isSamePersonActionType(input.actionType)) {
      throw new ActionApprovalError(
        'this action type is a same-person step-up, not a four-eyes approval',
        'action_approval.type_not_four_eyes',
      );
    }
    // A governed type is refused before anything else when its owner row is not set: nothing is written.
    const governed = governedActionTypeOf(input.actionType) === null ? null : this.requirePolicy(input.actionType);
    const ttl = this.policy.ttlSeconds;
    if (ttl === undefined) {
      throw new ActionApprovalError('action-approval lifetime is unpublished; identity does not invent hours', ACTION_APPROVAL_TTL_UNSET);
    }
    if (governed && input.targetService !== governed.applier) {
      throw new ActionApprovalError('this action type is applied only by the service its policy names', 'action_approval.service_mismatch');
    }
    // The policy's maximum age caps the shared lifetime; it never lengthens it.
    const lifetime = governed ? Math.min(ttl, governed.maxAgeSeconds) : ttl;
    const now = this.clock();
    const ids = newApprovalIds();
    const row: StoredApproval = {
      approvalId: ids.approvalId,
      actionType: input.actionType,
      targetService: input.targetService,
      targetId: input.targetId,
      expectedVersion: input.expectedVersion,
      payloadHash: input.payloadHash,
      requesterId,
      approverId: null,
      policyVersion: input.policyVersion,
      operationId: ids.operationId,
      status: 'PENDING',
      createdAt: now,
      expiresAt: new Date(now.getTime() + lifetime * 1000),
      approvedAt: null,
      consumedAt: null,
      ...(governed ? { approvalsRequired: governed.requiredApprovals, policyHash: governed.version, approvalsGiven: 0 } : {}),
    };
    return toActionApproval(await this.store.insert(row));
  }

  /**
   * Money-out step-up approval. The CALLER must already have proven a fresh second factor
   * (passkey or TOTP, never a recovery code) in this same request; this method only records
   * the result. The row is born APPROVED, bound to the proving user and session, valid five
   * minutes, and only that user in that session can consume it, once, through the target
   * service's HMAC consume. The four-eyes rule (`same_person` refusal in `approve`) is untouched.
   */
  async createSamePerson(
    principal: { readonly userId: string; readonly sessionId: string },
    input: { readonly actionType: string; readonly payloadHash: string },
  ): Promise<ActionApproval> {
    if (!isSamePersonActionType(input.actionType)) {
      throw new ActionApprovalError('this action type does not take a same-person step-up', 'action_approval.type_not_same_person');
    }
    const now = this.clock();
    const approvalId = newApprovalIds().approvalId;
    const row: StoredApproval = {
      approvalId,
      actionType: input.actionType,
      targetService: samePersonTargetService(input.actionType),
      // The consuming service recomputes the same hash. The payload carries every business field.
      targetId: input.actionType,
      expectedVersion: '1',
      payloadHash: input.payloadHash,
      requesterId: principal.userId,
      approverId: principal.userId,
      policyVersion: 'step-up-v1',
      // The client holds only the approval id, so the operation id is the approval id (unique per row).
      operationId: approvalId,
      status: 'APPROVED',
      createdAt: now,
      expiresAt: new Date(now.getTime() + SAME_PERSON_APPROVAL_TTL_SECONDS * 1000),
      approvedAt: now,
      consumedAt: null,
      kind: 'same_person',
      sessionId: principal.sessionId,
    };
    return toActionApproval(await this.store.insert(row));
  }

  async approve(approverId: string, approvalId: string, expectedPayloadHash: string): Promise<ActionApproval> {
    const row = await this.loadLive(approvalId);
    if (row.status !== 'PENDING') {
      throw this.terminal(row, 'action_approval.not_pending');
    }
    // Ids compare as the vote counter does, ignoring case, so the four-eyes refusal is the one given.
    if (row.requesterId.toLowerCase() === approverId.toLowerCase()) {
      throw new ActionApprovalError('the requester cannot approve their own action', 'action_approval.same_person');
    }
    // The approver signs off on the payload they reviewed, not on an id. Constant-time, on the stored hash.
    if (!payloadHashesEqual(row.payloadHash, expectedPayloadHash)) {
      throw new ActionApprovalError('the approval is for a different payload than the one reviewed', 'action_approval.payload_mismatch');
    }
    const governed = this.governedPolicyOf(row);
    if (governed) {
      if (governed.approverAudience === 'founder' || inFounderNamespace(row)) await this.requireFounders(row, { approverId });
      const vote = await this.store.casVote(approvalId, approverId, this.clock());
      if (vote.kind === 'already_approved') {
        throw new ActionApprovalError('this person has already approved this request', ACTION_APPROVAL_ALREADY_APPROVED);
      }
      if (vote.kind === 'not_pending') throw this.terminal(await this.loadLive(approvalId), 'action_approval.not_pending');
      return toActionApproval(vote.row);
    }
    if (audienceOfApproval(row) === 'founder') {
      // Both parties: an approval a non-founder proposed is not one a founder pair can complete.
      await this.requireFounders(row, { approverId });
    }
    const next = await this.store.casApprove(approvalId, approverId, this.clock());
    if (!next) throw this.terminal(await this.loadLive(approvalId), 'action_approval.not_pending');
    return toActionApproval(next);
  }

  async reject(actorId: string, approvalId: string): Promise<ActionApproval> {
    const row = await this.loadLive(approvalId);
    if (row.status !== 'PENDING') {
      throw this.terminal(row, 'action_approval.not_pending');
    }
    if (row.requesterId.toLowerCase() === actorId.toLowerCase()) {
      throw new ActionApprovalError('the requester cannot reject as checker; revoke instead', 'action_approval.same_person');
    }
    const next = await this.store.casReject(approvalId, actorId, this.clock());
    if (!next) throw this.terminal(await this.loadLive(approvalId), 'action_approval.not_pending');
    return toActionApproval(next);
  }

  async revoke(actorId: string, approvalId: string): Promise<ActionApproval> {
    const row = await this.loadLive(approvalId);
    if (row.status !== 'PENDING' && row.status !== 'APPROVED') {
      throw this.terminal(row, 'action_approval.already_terminal');
    }
    if (row.requesterId !== actorId) {
      throw new ActionApprovalError('only the requester can revoke', 'action_approval.not_requester');
    }
    const next = await this.store.casRevoke(approvalId, actorId, this.clock());
    if (!next) throw this.terminal(await this.loadLive(approvalId), 'action_approval.already_terminal');
    return toActionApproval(next);
  }

  async consume(callerService: string, input: ActionApprovalConsumeInput): Promise<ActionApproval> {
    const row = await this.loadLive(input.approvalId);
    // Already used: a repeat of the same request id replays; any other request id is consumed,
    // even when the payload also differs. That distinction is not a payload error.
    if (row.status === 'CONSUMED') {
      return this.consumedAgain(row, callerService, input);
    }
    const { founderAttestation } = await this.consumable(row, callerService, input);
    const consumedAt = this.clock();
    const next = await this.store.casConsume({
      ...input,
      now: consumedAt,
      requestId: input.requestId ?? null,
      consumedByService: callerService,
      consumedByPrincipal: input.consumerPrincipalId ?? null,
    });
    if (!next) {
      const again = await this.loadLive(input.approvalId);
      if (again.status === 'CONSUMED') return this.consumedAgain(again, callerService, input);
      throw this.terminal(again, 'action_approval.not_approved');
    }
    if (next.kind === 'same_person') await this.onSamePersonConsumed?.(next, consumedAt);
    return { ...toActionApproval(next), ...approvalProvenance(next), ...(founderAttestation ?? {}) };
  }

  /**
   * Resolves when `consume` with this input would spend the approval, without spending it: the same checks, read only.
   * A first phase of a two-phase change (starting an authenticator replace) checks the approval its second phase then
   * consumes. An approval already used refuses `action_approval.consumed`.
   */
  async check(callerService: string, input: ActionApprovalConsumeInput): Promise<void> {
    const row = await this.loadLive(input.approvalId);
    if (row.status === 'CONSUMED') throw new ActionApprovalError('approval already consumed', 'action_approval.consumed');
    await this.consumable(row, callerService, input);
  }

  /** Every check `consume` makes before it spends the row; the founder attestation it returns rides on the answer. */
  private async consumable(
    row: StoredApproval,
    callerService: string,
    input: ActionApprovalConsumeInput,
  ): Promise<{ founderAttestation: { approverIsFounder: true; requesterIsFounder: true } | null }> {
    if (callerService !== input.targetService || callerService !== row.targetService) {
      throw new ActionApprovalError('consume is only for the target service', 'action_approval.service_mismatch');
    }
    if (!payloadHashesEqual(row.payloadHash, input.payloadHash)) {
      throw new ActionApprovalError('payload hash does not match the approved action', 'action_approval.payload_mismatch');
    }
    if (row.targetId !== input.targetId || row.expectedVersion !== input.expectedVersion || row.operationId !== input.operationId) {
      throw new ActionApprovalError('target, version, or operation id does not match', 'action_approval.target_mismatch');
    }
    const samePerson = row.kind === 'same_person';
    const hasPrincipal = input.principalUserId !== undefined || input.principalSessionId !== undefined;
    if (samePerson !== hasPrincipal) {
      // A same-person row is consumed only with the consumer's principal, and a four-eyes row never is.
      throw new ActionApprovalError('approval kind does not match this consume', 'action_approval.target_mismatch');
    }
    if (samePerson && (row.requesterId !== input.principalUserId || row.sessionId !== input.principalSessionId)) {
      throw new ActionApprovalError(
        'only the user and session that proved the factor can consume this approval',
        'action_approval.not_requester',
      );
    }
    // Governed: the policy row is read again, must be the one the request was proposed under, and names the applier.
    const governed = this.governedPolicyOf(row);
    if (governed && callerService !== governed.applier) {
      throw new ActionApprovalError('this action type is applied only by the service its policy names', 'action_approval.service_mismatch');
    }
    if (!isConsumableApproval(toActionApproval(row))) {
      throw this.terminal(row, 'action_approval.not_approved');
    }
    let founderAttestation: { approverIsFounder: true; requesterIsFounder: true } | null = null;
    if (governed) {
      // Consumable only with at least the required distinct approvals, none of them the requester.
      const approvers = await this.distinctApprovers(row);
      if (approvers.length < governed.requiredApprovals) {
        throw new ActionApprovalError('the request does not yet have the approvals its policy requires', 'action_approval.not_approved');
      }
      if (governed.approverAudience === 'founder' || inFounderNamespace(row)) {
        for (const approverId of approvers) founderAttestation = await this.requireFounders(row, { approverId });
      }
    } else if (audienceOfApproval(row) === 'founder') {
      // Founder-only types: the proposer and the approver must both still be live founders NOW. This is evaluated on
      // every consume, so a row approved before this check existed (by an operator who is not a founder) is refused
      // here, not grandfathered. The result is attested to the target service on the returned row.
      founderAttestation = await this.requireFounders(row, { approverId: row.approverId });
    }
    return { founderAttestation };
  }

  /**
   * A second consume. The same request id, caller and binding returns the original row so a retry
   * after a lost reply is not the same refusal as someone else's use.
   */
  private consumedAgain(row: StoredApproval, callerService: string, input: ActionApprovalConsumeInput): ActionApproval {
    const sameRequest =
      input.requestId !== undefined &&
      row.consumedRequestId === input.requestId &&
      row.consumedByService === callerService &&
      (row.consumedByPrincipal ?? null) === (input.consumerPrincipalId ?? null);
    if (!sameRequest) {
      throw new ActionApprovalError('approval already consumed', 'action_approval.consumed');
    }
    if (!payloadHashesEqual(row.payloadHash, input.payloadHash)) {
      throw new ActionApprovalError('payload hash does not match the approved action', 'action_approval.payload_mismatch');
    }
    if (row.targetId !== input.targetId || row.expectedVersion !== input.expectedVersion || row.operationId !== input.operationId) {
      throw new ActionApprovalError('target, version, or operation id does not match', 'action_approval.target_mismatch');
    }
    if (callerService !== input.targetService || callerService !== row.targetService) {
      throw new ActionApprovalError('consume is only for the target service', 'action_approval.service_mismatch');
    }
    return {
      ...toActionApproval(row),
      ...approvalProvenance(row),
      consumption: 'already_consumed_by_this_request',
    };
  }

  /**
   * Pending approvals this caller may decide, or the caller's own rows.
   * `pending` is empty of founder-only rows unless the caller is a live founder,
   * and empty of operator rows unless the caller is an operator. The router
   * refuses the pending view entirely when the caller is neither.
   */
  async listForCaller(
    callerId: string,
    view: 'pending' | 'mine',
    limit: number,
    access: { readonly operator: boolean; readonly founder: boolean; readonly tradeOps?: boolean },
  ): Promise<{ readonly approvals: ActionApproval[]; readonly pageFull: boolean }> {
    if (view === 'mine') {
      const rows = await this.store.listByRequester(callerId, limit);
      return { approvals: rows.map(toActionApproval), pageFull: rows.length === limit };
    }
    const rows = await this.store.listPendingExcept(callerId, limit);
    const visible = [];
    const caller = callerId.toLowerCase();
    for (const row of rows) {
      const audience = this.visibleAudienceOf(row);
      if (audience === 'self') continue;
      // A governed row waiting on more approvers is not the caller's to act on once they have voted on it.
      if (row.approvalsRequired != null && (await this.store.listVotes(row.approvalId)).some((v) => v.approverId.toLowerCase() === caller))
        continue;
      if (audience === 'founder' && access.founder) visible.push(toActionApproval(row));
      else if (audience === 'trade_ops' && access.tradeOps) visible.push(toActionApproval(row));
      else if (audience === 'operator' && access.operator) visible.push(toActionApproval(row));
    }
    return { approvals: visible, pageFull: rows.length === limit };
  }

  /**
   * One approval the caller may read: their own row, or a pending/decided row
   * whose audience they belong to. Anyone else is refused. Missing is not found.
   */
  async getForCaller(
    callerId: string,
    approvalId: string,
    access: { readonly operator: boolean; readonly founder: boolean; readonly tradeOps?: boolean; readonly adminRead?: boolean },
  ): Promise<ActionApproval> {
    const row = await this.store.get(approvalId);
    if (!row) throw new ActionApprovalError('approval not found', 'action_approval.not_found');
    const party =
      row.requesterId.toLowerCase() === callerId.toLowerCase() ||
      (row.approverId !== null && row.approverId.toLowerCase() === callerId.toLowerCase());
    if (!party) {
      const audience = this.visibleAudienceOf(row);
      const allowed =
        audience === 'founder'
          ? access.founder
          : audience === 'trade_ops'
            ? access.tradeOps === true
            : audience === 'operator'
              ? access.operator
              : false;
      if (!allowed) throw new ActionApprovalError('this approval is not visible to this session', 'action_approval.not_requester');
    }
    if (!party && access.adminRead !== true) return toActionApproval(row);
    return { ...toActionApproval(row), ...approvalProvenance(row) };
  }

  /**
   * The two people on an approval, or null when there is none. Read before a consume so a door can refuse a
   * request one of them may not make without spending the approval. Discloses nothing past the two ids.
   */
  async partiesOf(approvalId: string): Promise<{ readonly requesterId: string; readonly approverId: string | null } | null> {
    const row = await this.store.get(approvalId);
    return row ? { requesterId: row.requesterId, approverId: row.approverId } : null;
  }

  /**
   * The audience-relevant fields of a stored approval, or null. Lets a door classify it before acting on it.
   * Only the request's own type, target service, target id and kind: nothing else is disclosed.
   */
  async subjectOf(approvalId: string): Promise<ApprovalSubject | null> {
    const row = await this.store.get(approvalId);
    return row ? { actionType: row.actionType, targetService: row.targetService, targetId: row.targetId, kind: row.kind } : null;
  }

  /**
   * Is this user a founder right now, according to the wired directory. False when no directory is wired or the
   * directory says no. A directory that cannot answer (it throws) is `founders_unavailable`: still refused, but
   * told apart from "not a founder" so an outage is not read as a policy refusal.
   */
  async isFounder(userId: string): Promise<boolean> {
    try {
      return (await this.policy.founders?.isFounder(userId)) === true;
    } catch {
      throw new ActionApprovalError('the founder list could not be read; nothing was changed', 'action_approval.founders_unavailable');
    }
  }

  /**
   * Both parties of a founder-only approval must be live founders and distinct. Refuses with `founder_only`, or
   * `founders_unavailable` when the founder list cannot be read (nothing is consumed either way).
   * `approverId` is null when nobody approved (a consume of an unapproved row never reaches here).
   */
  private async requireFounders(
    row: StoredApproval,
    parties: { readonly approverId: string | null },
  ): Promise<{ approverIsFounder: true; requesterIsFounder: true }> {
    const approverId = parties.approverId;
    const ok =
      approverId !== null &&
      approverId.toLowerCase() !== row.requesterId.toLowerCase() &&
      (await this.isFounder(approverId)) &&
      (await this.isFounder(row.requesterId));
    if (!ok) {
      throw new ActionApprovalError(
        'this action type needs a distinct proposer and approver who are both founders',
        'action_approval.founder_only',
      );
    }
    return { approverIsFounder: true, requesterIsFounder: true };
  }

  /**
   * Who may propose, approve or reject this request. A governed type answers with its policy's audience, or refuses
   * `action_approval.policy_unset` when the row is not set. Every other request keeps `audienceOfApproval`.
   * `whenUnset: 'default'` (reject only) falls back to the fixed audience instead, so a pending governed request can
   * still be turned down while its row is blank; nothing can be approved or applied that way.
   */
  audienceFor(subject: ApprovalSubject, whenUnset: 'refuse' | 'default' = 'refuse'): ActionAudience {
    if (subject.kind === 'same_person' || governedActionTypeOf(subject.actionType) === null) return audienceOfApproval(subject);
    // The row decides who may approve its type (an owner value, CR-1), but never lowers a founder-namespaced request.
    if (inFounderNamespace(subject)) {
      if (whenUnset === 'refuse') this.requirePolicy(subject.actionType);
      return 'founder';
    }
    if (whenUnset === 'default') {
      const found = this.lookupPolicy(subject.actionType);
      return found ? found.approverAudience : audienceOfApproval(subject);
    }
    return this.requirePolicy(subject.actionType).approverAudience;
  }

  /** True when the request is policy-governed, so a door can name `audience_mismatch` instead of the fixed codes. */
  isGoverned(subject: ApprovalSubject): boolean {
    return subject.kind !== 'same_person' && governedActionTypeOf(subject.actionType) !== null;
  }

  /** Every governed type with its policy row or `unset`, read now. */
  policyEntries(): ActionApprovalPolicyEntry[] {
    return approvalPolicyEntries(this.policy.policies);
  }

  /** The current row for a governed type, or null when it is unset or cannot be read (fail closed). */
  private lookupPolicy(actionType: string): GovernedPolicy | null {
    const type = governedActionTypeOf(actionType);
    if (type === null || !this.policy.policies) return null;
    try {
      const found = this.policy.policies(type);
      return found.state === 'set' ? found.policy : null;
    } catch {
      return null;
    }
  }

  private requirePolicy(actionType: string): GovernedPolicy {
    const found = this.lookupPolicy(actionType);
    if (!found) {
      throw new ActionApprovalError(
        'the owner has not set the approval policy for this action type; nothing was changed',
        ACTION_APPROVAL_POLICY_UNSET,
      );
    }
    return found;
  }

  /**
   * The policy a stored request is judged by, or null when it is not governed. A governed type's row must exist now and
   * be the exact version the request was proposed under; a row that changed, or a request filed before the type was
   * governed, is refused rather than judged by a different rule.
   */
  private governedPolicyOf(row: StoredApproval): GovernedPolicy | null {
    if (row.kind === 'same_person') return null;
    const governedType = governedActionTypeOf(row.actionType) !== null;
    if (!governedType && row.approvalsRequired == null) return null;
    const changed = () =>
      new ActionApprovalError(
        'the approval policy for this action type changed after the request was made; propose it again',
        ACTION_APPROVAL_POLICY_CHANGED,
      );
    // A request filed under a policy whose type is no longer governed has no row to be judged by: changed, not unset.
    if (!governedType) throw changed();
    const current = this.requirePolicy(row.actionType);
    if (
      row.approvalsRequired == null ||
      row.policyHash == null ||
      row.policyHash !== current.version ||
      row.approvalsRequired !== current.requiredApprovals
    ) {
      throw changed();
    }
    return current;
  }

  /** Distinct recorded approvers of a governed row, none of them the requester. */
  private async distinctApprovers(row: StoredApproval): Promise<string[]> {
    const requester = row.requesterId.toLowerCase();
    const seen = new Map<string, string>();
    for (const vote of await this.store.listVotes(row.approvalId)) {
      const key = vote.approverId.toLowerCase();
      if (key !== requester && !seen.has(key)) seen.set(key, vote.approverId);
    }
    return [...seen.values()];
  }

  /** Audience used to decide who may SEE a row: never refuses, falls back to the fixed audience. */
  private visibleAudienceOf(row: StoredApproval): ActionAudience {
    return this.audienceFor(row, 'default');
  }

  /** Two strings in one body never become an approval. */
  namesAreNotAuthority(input: { readonly actorId?: string | null; readonly confirmActorId?: string | null }): true {
    return namesAreNotActionApproval(input);
  }

  private async loadLive(approvalId: string): Promise<StoredApproval> {
    const expired = await this.store.casExpire(approvalId, this.clock());
    if (!expired) throw new ActionApprovalError('approval not found', 'action_approval.not_found');
    if (expired.status === 'EXPIRED') {
      throw new ActionApprovalError('approval expired', 'action_approval.expired');
    }
    return expired;
  }

  private terminal(row: StoredApproval, fallback: ActionApprovalErrorCode): ActionApprovalError {
    if (row.status === 'EXPIRED') return new ActionApprovalError('approval expired', 'action_approval.expired');
    if (row.status === 'CONSUMED') return new ActionApprovalError('approval already consumed', 'action_approval.consumed');
    if (row.status === 'REJECTED' || row.status === 'REVOKED') {
      return new ActionApprovalError(`approval is ${row.status}`, 'action_approval.already_terminal');
    }
    return new ActionApprovalError(`approval is ${row.status}`, fallback);
  }
}
