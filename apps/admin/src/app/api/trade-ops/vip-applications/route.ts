import { tradeOpsRoute } from '@/lib/trade-ops/bff';
import type { TradeCtx } from '@/lib/trade-ops/edge';
import { readMatchingApproval } from '@/lib/trade-ops/matching-edge';
import { ok, refused, type Outcome } from '@/lib/trade-ops/outcome';
import { checkReason, VIP_STATUSES, type VipDecision, type VipStatus } from '@/lib/trade-ops/vip-review';
import {
  applyVipReview,
  applyVipTrialGrant,
  openVipProof,
  proposeVipReview,
  proposeVipTrialGrant,
  readVipApplications,
} from '@/lib/trade-ops/vip-review-calls';
import {
  VIP_REVIEW_ACTION_TYPE,
  VIP_TRIAL_GRANT_ACTION_TYPE,
  vipReviewPayloadHash,
  vipTrialGrantPayloadHash,
} from '@/lib/trade-ops/vip-review-hash';

/**
 * VIP applications room, through svc-trade `admin.vipApplications.*` and identity's two-person approvals.
 *
 *   POST { action: 'read', status? }                                         the applications, the trial the owner
 *                                                                            publishes now, whether proofs open
 *   POST { action: 'proof', applicationId, reason }                          one proof file (audited by svc-trade)
 *   POST { action: 'propose', kind: 'review', applicationId, decision, reason } file the approval a decision needs
 *   POST { action: 'propose', kind: 'grant', applicationId, reason }        file the approval a trial grant needs
 *   POST { action: 'apply', kind, applicationId, decision?, reason, approvalId } apply it once APPROVED
 *   POST { action: 'hash', kind, applicationId, decision?, reason }          the hash a request for exactly this would
 *                                                                            carry, so the approving founder can check
 *                                                                            what they approve (nothing is filed)
 *
 * A proposal is bound to the application's status now and, for an approval, to the trial the owner publishes now: the
 * room reads both fresh before it files one, and svc-trade checks them again when it is applied. A grant while no trial
 * is published is refused here before anything is filed (svc-trade refuses it the same way, `vip.trial_unset`). Before
 * an apply the room says in words when the approval was filed for something else; svc-trade decides everything else.
 */
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_.:-]{1,128}$/;

const WAITING: Record<'review' | 'grant', VipStatus> = { review: 'pending', grant: 'approved_no_trial' };

/**
 * The application as svc-trade holds it now, among those in the status the action needs (so an old one is not lost
 * behind the newest 200 of every status), with the trial published now. One not found there is looked for once among
 * every status, to say whether it was decided already.
 */
async function current(ctx: TradeCtx, applicationId: string, kind: 'review' | 'grant') {
  const list = await readVipApplications(ctx, WAITING[kind]);
  if (list.kind !== 'ok') return list;
  const application = list.data.applications.find((a) => a.id === applicationId);
  if (application) return ok({ application, trialRules: list.data.trialRules }, list.asOf);
  const any = await readVipApplications(ctx, null);
  const elsewhere = any.kind === 'ok' ? any.data.applications.find((a) => a.id === applicationId) : undefined;
  if (elsewhere && kind === 'review')
    return refused('vip.application_decided', `The application is already decided (${elsewhere.status}).`, 409);
  if (elsewhere)
    return refused(
      'vip.trial_not_owed',
      `Only an application approved without a trial is granted one (this one is ${elsewhere.status}).`,
      409,
    );
  return refused('vip_application_not_found', 'No such application among the newest 200. Read the room again.', 404);
}

async function handler(ctx: TradeCtx, body: Record<string, unknown>): Promise<Outcome<unknown>> {
  const action = body.action;
  if (action === 'read') {
    const status = body.status === undefined || body.status === null ? null : body.status;
    if (status !== null && !VIP_STATUSES.includes(status as VipStatus)) return refused('trade_ops.vip_bad_status', 'Unknown status.', 400);
    return readVipApplications(ctx, status as VipStatus | null);
  }
  if (action !== 'proof' && action !== 'propose' && action !== 'apply' && action !== 'hash')
    return refused('trade_ops.bad_action', 'Unknown VIP action.', 400);
  if (typeof body.applicationId !== 'string' || !UUID.test(body.applicationId))
    return refused('trade_ops.vip_bad_application', 'Choose an application.', 400);
  const applicationId = body.applicationId.toLowerCase();
  const reason = checkReason(body.reason);
  if (!reason.ok) return refused('reason_required', reason.message, 400);

  if (action === 'proof') return openVipProof(ctx, applicationId, reason.reason);

  const kind = body.kind;
  if (kind !== 'review' && kind !== 'grant')
    return refused('trade_ops.bad_action', 'Say whether this is a decision or a trial grant.', 400);
  const decision = body.decision;
  if (kind === 'review' && decision !== 'approve' && decision !== 'reject')
    return refused('trade_ops.vip_bad_decision', 'Choose approve or reject.', 400);

  if (action === 'hash') {
    // Pure: the hash a request for exactly this carries, with the trial published now. Nothing is filed.
    const rules = await readVipApplications(ctx, WAITING[kind]);
    if (rules.kind !== 'ok') return rules;
    const trialRules = rules.data.trialRules;
    if (kind === 'grant' && !trialRules)
      return refused('vip.trial_unset', 'The owner has not published a VIP trial (tier and days), so no grant can be approved.', 409);
    const trial = kind === 'review' && decision === 'reject' ? null : trialRules;
    const payloadHash =
      kind === 'review'
        ? vipReviewPayloadHash({ applicationId, decision: decision as VipDecision, reason: reason.reason, trial: trialRules })
        : vipTrialGrantPayloadHash({ applicationId, reason: reason.reason, trial: trialRules! });
    return ok({ payloadHash, trial }, rules.asOf);
  }

  if (action === 'propose') {
    const now = await current(ctx, applicationId, kind);
    if (now.kind !== 'ok') return now;
    const { trialRules } = now.data;
    if (kind === 'review') {
      const input = { applicationId, decision: decision as VipDecision, reason: reason.reason, trial: trialRules };
      const filed = await proposeVipReview(ctx, input);
      return filed.kind === 'ok'
        ? ok({ approval: filed.data, payloadHash: vipReviewPayloadHash(input), trial: decision === 'approve' ? trialRules : null })
        : filed;
    }
    if (!trialRules)
      return refused(
        'vip.trial_unset',
        'The owner has not published a VIP trial (tier and days), so none can be granted. Nothing was filed.',
        409,
      );
    const input = { applicationId, reason: reason.reason, trial: trialRules };
    const filed = await proposeVipTrialGrant(ctx, input);
    return filed.kind === 'ok' ? ok({ approval: filed.data, payloadHash: vipTrialGrantPayloadHash(input), trial: trialRules }) : filed;
  }

  // apply
  if (typeof body.approvalId !== 'string' || !TOKEN.test(body.approvalId.trim()))
    return refused('trade_ops.approval_id_invalid', 'Enter the id of an APPROVED request.', 400);
  const approvalId = body.approvalId.trim();
  // The decision is bound to the approval's own operation id, which identity minted when it was proposed.
  const approval = await readMatchingApproval(ctx, approvalId);
  if (approval.kind !== 'ok') return approval;
  const { status } = approval.data;
  if (status === 'PENDING')
    return refused('action_approval.pending', 'This request is still waiting for a second founder. Nothing was decided.', 409);
  // A used approval goes to svc-trade as it is: the same decision sent again (a reply lost on the way) answers what was
  // decided, and anything else is refused there (approval_reused).
  if (status !== 'APPROVED' && status !== 'CONSUMED')
    return refused('action_approval.not_approved', `This request is ${status}, not APPROVED. Nothing was decided.`, 409);
  if (status === 'APPROVED') {
    // Say in words when the approval is for something else, before svc-trade refuses it as approval_mismatch.
    const rules = await readVipApplications(ctx, WAITING[kind]);
    if (rules.kind !== 'ok') return rules;
    const trialRules = rules.data.trialRules;
    const expected =
      kind === 'review'
        ? vipReviewPayloadHash({ applicationId, decision: decision as VipDecision, reason: reason.reason, trial: trialRules })
        : trialRules
          ? vipTrialGrantPayloadHash({ applicationId, reason: reason.reason, trial: trialRules })
          : null;
    const actionType = kind === 'review' ? VIP_REVIEW_ACTION_TYPE : VIP_TRIAL_GRANT_ACTION_TYPE;
    if (approval.data.actionType !== actionType || approval.data.targetId !== applicationId)
      return refused(
        'approval_mismatch',
        'This approval was filed for another application or another kind of action. Nothing was decided.',
        409,
      );
    if (expected !== null && approval.data.payloadHash !== expected)
      return refused(
        'approval_mismatch',
        'This approval was filed for a different decision, reason or trial than the one entered here (the owner may have changed the published trial since). Nothing was decided.',
        409,
      );
  }
  const ids = { approvalId, operationId: approval.data.operationId };
  return kind === 'review'
    ? applyVipReview(ctx, { applicationId, decision: decision as VipDecision, reason: reason.reason, ...ids })
    : applyVipTrialGrant(ctx, { applicationId, reason: reason.reason, ...ids });
}

export const POST = (req: Request) => tradeOpsRoute(req, handler);
