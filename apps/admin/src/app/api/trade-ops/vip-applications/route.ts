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
import { vipReviewPayloadHash, vipTrialGrantPayloadHash } from '@/lib/trade-ops/vip-review-hash';

/**
 * VIP applications room, through svc-trade `admin.vipApplications.*` and identity's two-person approvals.
 *
 *   POST { action: 'read', status? }                                         the applications, the trial the owner
 *                                                                            publishes now, whether proofs open
 *   POST { action: 'proof', applicationId, reason }                          one proof file (audited by svc-trade)
 *   POST { action: 'propose', kind: 'review', applicationId, decision, reason } file the approval a decision needs
 *   POST { action: 'propose', kind: 'grant', applicationId, reason }        file the approval a trial grant needs
 *   POST { action: 'apply', kind, applicationId, decision?, reason, approvalId } apply it once APPROVED
 *
 * A proposal is bound to the application's status now and, for an approval, to the trial the owner publishes now: the
 * room reads both fresh before it files one, and svc-trade checks them again when it is applied. A grant while no trial
 * is published is refused here before anything is filed (svc-trade refuses it the same way, `vip.trial_unset`).
 */
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_.:-]{1,128}$/;

/** The application as svc-trade holds it now, with the trial published now. */
async function current(ctx: TradeCtx, applicationId: string) {
  const list = await readVipApplications(ctx, null);
  if (list.kind !== 'ok') return list;
  const application = list.data.applications.find((a) => a.id === applicationId);
  if (!application) return refused('vip_application_not_found', 'No such application in the latest 200.', 404);
  return ok({ application, trialRules: list.data.trialRules }, list.asOf);
}

async function handler(ctx: TradeCtx, body: Record<string, unknown>): Promise<Outcome<unknown>> {
  const action = body.action;
  if (action === 'read') {
    const status = body.status === undefined || body.status === null ? null : body.status;
    if (status !== null && !VIP_STATUSES.includes(status as VipStatus)) return refused('trade_ops.vip_bad_status', 'Unknown status.', 400);
    return readVipApplications(ctx, status as VipStatus | null);
  }
  if (action !== 'proof' && action !== 'propose' && action !== 'apply') return refused('trade_ops.bad_action', 'Unknown VIP action.', 400);
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

  const now = await current(ctx, applicationId);
  if (now.kind !== 'ok') return now;
  const { application, trialRules } = now.data;

  if (action === 'propose') {
    if (kind === 'review') {
      if (application.status !== 'pending')
        return refused('vip.application_decided', `The application is already decided (${application.status}).`, 409);
      const input = { applicationId, decision: decision as VipDecision, reason: reason.reason, trial: trialRules };
      const filed = await proposeVipReview(ctx, input);
      return filed.kind === 'ok'
        ? ok({ approval: filed.data, payloadHash: vipReviewPayloadHash(input), trial: decision === 'approve' ? trialRules : null })
        : filed;
    }
    if (application.status !== 'approved_no_trial')
      return refused(
        'vip.trial_not_owed',
        `Only an application approved without a trial is granted one (this one is ${application.status}).`,
        409,
      );
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
  // A grant while no trial is published is refused by svc-trade before any approval is spent; say so here too.
  if (kind === 'grant' && !trialRules)
    return refused('vip.trial_unset', 'The owner has not published a VIP trial (tier and days), so none can be granted.', 409);
  // The decision is bound to the approval's own operation id, which identity minted when it was proposed.
  const approval = await readMatchingApproval(ctx, approvalId);
  if (approval.kind !== 'ok') return approval;
  if (approval.data.status !== 'APPROVED')
    return refused(
      approval.data.status === 'PENDING' ? 'action_approval.pending' : 'action_approval.not_approved',
      approval.data.status === 'PENDING'
        ? 'This request is still waiting for a second founder. Nothing was decided.'
        : `This request is ${approval.data.status}, not APPROVED. Nothing was decided.`,
      409,
    );
  const ids = { approvalId, operationId: approval.data.operationId };
  return kind === 'review'
    ? applyVipReview(ctx, { applicationId, decision: decision as VipDecision, reason: reason.reason, ...ids })
    : applyVipTrialGrant(ctx, { applicationId, reason: reason.reason, ...ids });
}

export const POST = (req: Request) => tradeOpsRoute(req, handler);
