import 'server-only';
import { actionApprovalSchema, type ActionApproval } from '@intafaced/contracts';
import { confirmPhrase, encodePacket, isApprovalId, needsStepUp, readDeskRequest, type DeskRequest } from './approval-packet';
import { payloadHashFor, proposeInputFor } from './approval-hash';
import { founderCall, parseWith, type FounderCallContext, type FounderCallFailure } from './founder-call';
import { explainRefusal } from './refusal-copy';
import type { ApprovalView, ExecuteReply, StepName, StepReply } from './approval-types';

export type { ApprovalView, ExecuteReply, StepName, StepReply } from './approval-types';

/**
 * `stepUpCode` is the running founder's fresh authenticator code, sent only with an execute step whose service asks for
 * a same-person step-up (a governance role change). Every other executor ignores it.
 */
export type ExecuteFn = (
  request: DeskRequest,
  ids: { approvalId: string; operationId: string; stepUpCode?: string },
) => Promise<ExecuteReply>;

/**
 * The four steps of a two-founder request, run as the signed-in founder through identity.
 *
 *   propose  founder A asks identity for an approval bound to the exact request (hash of module/action/reason).
 *   approve  founder B, having read the same request, signs off. Identity refuses A approving their own.
 *   reject   founder B declines. Withdraw (`revoke`) is A's undo of a request nobody has used.
 *   execute  the request is sent to its owning service (svc-edge or svc-ledger), which spends the approval ONCE.
 *
 * Identity is the authority for who may propose/approve and for single use. This file adds only friction that must
 * not depend on the browser: the typed phrase is checked here as well as in the page, so a replayed request that
 * skipped the page still has to carry it.
 */

const STEPS: readonly StepName[] = ['propose', 'approve', 'reject', 'revoke', 'execute'];

export interface StepBody {
  readonly step: StepName;
  readonly request: DeskRequest | null;
  readonly confirm: string;
  readonly approvalId: string | null;
  readonly operationId: string | null;
  /** Six digits from the founder's authenticator, only on an execute step. */
  readonly stepUpCode?: string;
}

export type ParsedStep = { readonly ok: true; readonly body: StepBody } | { readonly ok: false; readonly error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

/** Trim the reason the way the services will before hashing, then read the request strictly. */
function normalisedRequest(raw: unknown): DeskRequest | null {
  if (!isRecord(raw)) return null;
  const copy: Record<string, unknown> = { ...raw };
  if (typeof copy.reason === 'string') copy.reason = copy.reason.trim();
  return readDeskRequest(copy);
}

export function parseStepBody(raw: unknown): ParsedStep {
  if (!isRecord(raw)) return { ok: false, error: 'a JSON object is required' };
  const step = STEPS.find((s) => s === raw.step);
  if (!step) return { ok: false, error: 'step must be propose, approve, reject, revoke or execute' };
  const needsRequest = step === 'propose' || step === 'approve' || step === 'execute';
  const request = raw.request === undefined ? null : normalisedRequest(raw.request);
  if (needsRequest && request === null) return { ok: false, error: 'request is missing or not a recognised request' };
  const approvalId = raw.approvalId === undefined ? null : raw.approvalId;
  const operationId = raw.operationId === undefined ? null : raw.operationId;
  if (step !== 'propose' && !isApprovalId(approvalId)) return { ok: false, error: 'approvalId is required' };
  if (step === 'execute' && !isApprovalId(operationId)) return { ok: false, error: 'operationId is required' };
  const stepUpCode = raw.stepUpCode === undefined ? undefined : raw.stepUpCode;
  if (
    stepUpCode !== undefined &&
    (step !== 'execute' || request === null || !needsStepUp(request) || typeof stepUpCode !== 'string' || !/^\d{6}$/.test(stepUpCode))
  ) {
    return { ok: false, error: 'stepUpCode is six digits, sent only to run a request that needs a step-up' };
  }
  const confirm = typeof raw.confirm === 'string' ? raw.confirm : '';
  if (needsRequest && request !== null && confirm !== confirmPhrase(request)) {
    return { ok: false, error: `type ${confirmPhrase(request)} exactly to confirm` };
  }
  return {
    ok: true,
    body: {
      step,
      request,
      confirm,
      approvalId: typeof approvalId === 'string' ? approvalId : null,
      operationId: typeof operationId === 'string' ? operationId : null,
      ...(stepUpCode !== undefined ? { stepUpCode } : {}),
    },
  };
}

function viewOf(a: ActionApproval): ApprovalView {
  return {
    approvalId: a.approvalId,
    operationId: a.operationId,
    status: a.status,
    expiresAt: a.expiresAt,
    requesterId: a.requesterId,
    approverId: a.approverId,
  };
}

function failureReply(step: StepName, failure: FounderCallFailure<unknown>): StepReply {
  switch (failure.kind) {
    case 'forbidden':
    case 'refused':
      return { ok: false, step, refusal: explainRefusal(failure.refusal.code, failure.refusal.status) };
    case 'unavailable':
      return { ok: false, step, refusal: explainRefusal(null, 503, failure.uncertain) };
    case 'not_built':
      return {
        ok: false,
        step,
        refusal: {
          title: 'Approvals are not available on this deployment',
          body: 'Identity does not expose the approval procedures here. Nothing was changed.',
          next: 'Tell engineering.',
          code: null,
          changed: 'no',
        },
      };
    case 'invalid':
      return {
        ok: false,
        step,
        refusal: {
          title: 'Identity answered in a shape this console does not understand',
          body: 'It is not known whether the step went through.',
          next: 'Read the current state before doing anything again.',
          code: null,
          changed: 'unknown',
        },
      };
  }
}

const parseApproval = parseWith(actionApprovalSchema);

/** The row identity returned must be for the request this founder read: same action, target, version and hash. */
export function approvalMatchesRequest(approval: ActionApproval, request: DeskRequest): boolean {
  const expected = proposeInputFor(request);
  return (
    approval.actionType === expected.actionType &&
    approval.targetService === expected.targetService &&
    approval.targetId === expected.targetId &&
    approval.expectedVersion === expected.expectedVersion &&
    approval.payloadHash === expected.payloadHash
  );
}

export async function runStep(ctx: FounderCallContext, body: StepBody, execute: ExecuteFn): Promise<StepReply> {
  const { step, request } = body;

  if (step === 'propose' && request) {
    const proposed = await founderCall(ctx, 'identity', 'actionApproval.propose', 'POST', proposeInputFor(request), parseApproval);
    if (proposed.kind !== 'ok') return failureReply(step, proposed);
    const a = proposed.data;
    if (!approvalMatchesRequest(a, request)) {
      // Identity stored something other than what was asked. Do not hand a packet for it to anyone.
      return {
        ok: false,
        step,
        refusal: {
          title: 'Identity stored a different request than the one you made',
          body: 'The approval it returned does not match what was sent, so no packet was made.',
          next: 'Withdraw it if you can, then tell engineering. Nothing was run.',
          code: null,
          changed: 'unknown',
        },
      };
    }
    return {
      ok: true,
      step,
      approval: viewOf(a),
      packet: encodePacket({
        request,
        approvalId: a.approvalId,
        operationId: a.operationId,
        expiresAt: a.expiresAt,
        requesterId: a.requesterId,
      }),
    };
  }

  if (step === 'approve' && request && body.approvalId) {
    const approved = await founderCall(
      ctx,
      'identity',
      'actionApproval.approve',
      'POST',
      // The approver signs off on the payload THEY read, recomputed here from the decoded request.
      { approvalId: body.approvalId, expectedPayloadHash: payloadHashFor(request) },
      parseApproval,
    );
    if (approved.kind !== 'ok') return failureReply(step, approved);
    return {
      ok: true,
      step,
      approval: viewOf(approved.data),
      matchesReviewedRequest: approvalMatchesRequest(approved.data, request),
    };
  }

  if ((step === 'reject' || step === 'revoke') && body.approvalId) {
    const done = await founderCall(
      ctx,
      'identity',
      step === 'reject' ? 'actionApproval.reject' : 'actionApproval.revoke',
      'POST',
      { approvalId: body.approvalId },
      parseApproval,
    );
    if (done.kind !== 'ok') return failureReply(step, done);
    return { ok: true, step, approval: viewOf(done.data) };
  }

  if (step === 'execute' && request && body.approvalId && body.operationId) {
    const result = await execute(request, {
      approvalId: body.approvalId,
      operationId: body.operationId,
      ...(body.stepUpCode && needsStepUp(request) ? { stepUpCode: body.stepUpCode } : {}),
    });
    if (!result.ok) return { ok: false, step, refusal: result.refusal };
    return result.document
      ? { ok: true, step, detail: result.detail, document: result.document }
      : { ok: true, step, detail: result.detail };
  }

  return { ok: false, step, refusal: explainRefusal('admin.request_invalid', 400) };
}

/** One structured line per step, for the platform log. Never the reason text, never a credential. */
export function auditLine(ctx: FounderCallContext, body: StepBody, reply: StepReply): string {
  return JSON.stringify({
    audit: 'admin.desk.step',
    at: new Date().toISOString(),
    founder: ctx.session.userId,
    step: body.step,
    kind: body.request?.kind ?? null,
    module: body.request?.kind === 'edge.kill' ? body.request.module : null,
    approvalId: body.approvalId ?? (reply.ok && reply.step !== 'execute' ? reply.approval.approvalId : null),
    ok: reply.ok,
    code: reply.ok ? null : reply.refusal.code,
    changed: reply.ok ? 'yes' : reply.refusal.changed,
  });
}
