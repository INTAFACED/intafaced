import { tradeOpsRoute } from '@/lib/trade-ops/bff';
import { checkDays, checkLeadReason, type LeadApplication } from '@/lib/trade-ops/copy-lead';
import {
  approveLead,
  approveLeadApproval,
  fileLeadApproval,
  proposeLead,
  readLeadDesk,
  rejectLead,
  setLeadCriteria,
  setLeadState,
} from '@/lib/trade-ops/copy-lead-calls';
import { COPY_LEAD_ACTION_TYPE, copyLeadPayloadHash } from '@/lib/trade-ops/copy-lead-hash';
import type { TradeCtx } from '@/lib/trade-ops/edge';
import { readMatchingApproval } from '@/lib/trade-ops/matching-edge';
import { ok, refused, type Outcome } from '@/lib/trade-ops/outcome';

/**
 * Copy trading room, through svc-trade `copy.ops.*` and identity's two-person approvals (CB-ops-01, CB-copy-12).
 *
 *   POST { action: 'read' }                                 the queue oldest first, the criteria, the leads, the audit
 *   POST { action: 'criteria', minTrackRecordDays }         set the lead criteria (a founder's setting, audited)
 *   POST { action: 'approve', applicationId }               founder A: file the approval and mark the application
 *                                                           waiting for a second founder; on a waiting application,
 *                                                           a new approval replaces one that expired or no longer
 *                                                           matches the criteria
 *   POST { action: 'confirm', applicationId }               founder B: approve it in identity, then list the lead
 *   POST { action: 'reject', applicationId, reason }        reject; the applicant reads the reason
 *   POST { action: 'suspend', leaderRef, reason }           suspend a listed lead (audited with the reason)
 *
 * The approval is bound to the application, the name it lists under and the criteria in force when it was filed; an
 * approval while the criteria are unset is refused here before anything is filed (svc-trade refuses it the same way,
 * `trade.copy_lead_criteria_unset`). Request ids are business keys: the change they make from the state now.
 */
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REF = /^[A-Za-z0-9_.:-]{1,80}$/;
const CRITERIA_UNSET = 'The lead criteria are not set. Set the minimum track record on this desk before approving; nothing was filed.';

/** The application as svc-trade holds it now, and the criteria in force. */
async function current(ctx: TradeCtx, applicationId: string): Promise<Outcome<{ application: LeadApplication; days: number | null }>> {
  const read = await readLeadDesk(ctx);
  if (read.kind !== 'ok') return read;
  const application = read.data.queue.applications.find((a) => a.id === applicationId);
  if (!application) return refused('trade.copy_lead_application_not_found', 'No such application is waiting. Read the room again.', 404);
  return ok({ application, days: read.data.queue.criteria?.minTrackRecordDays ?? null }, read.asOf);
}

async function handler(ctx: TradeCtx, body: Record<string, unknown>): Promise<Outcome<unknown>> {
  const action = body.action;
  if (action === 'read') return readLeadDesk(ctx);

  if (action === 'criteria') {
    const days = checkDays(body.minTrackRecordDays);
    if (!days.ok) return refused('trade_ops.copy_lead_criteria_invalid', days.message, 400);
    const read = await readLeadDesk(ctx);
    if (read.kind !== 'ok') return read;
    // The change from the criteria in force now to these: the same save sent twice is one row.
    const from = read.data.queue.criteria?.setAt ?? 'unset';
    return setLeadCriteria(ctx, { minTrackRecordDays: days.days, clientRequestId: `${from}>${days.days}` });
  }

  if (action === 'suspend') {
    if (typeof body.leaderRef !== 'string' || !REF.test(body.leaderRef)) return refused('trade_ops.copy_bad_lead', 'Choose a lead.', 400);
    const reason = checkLeadReason(body.reason);
    if (!reason.ok) return refused('reason_required', reason.message, 400);
    const read = await readLeadDesk(ctx);
    if (read.kind !== 'ok') return read;
    const lead = read.data.leads.find((l) => l.leaderRef === body.leaderRef);
    if (!lead) return refused('trade.copy_leader_not_found', 'No such lead. Read the room again.', 404);
    if (lead.state === 'suspended') return refused('trade_ops.copy_lead_suspended', 'This lead is already suspended.', 409);
    return setLeadState(ctx, {
      leaderRef: lead.leaderRef,
      state: 'suspended',
      reason: reason.reason,
      clientRequestId: `copy-lead-suspend:${lead.leaderRef}:${lead.stateChangedAt}`,
    });
  }

  if (action !== 'approve' && action !== 'confirm' && action !== 'reject')
    return refused('trade_ops.bad_action', 'Unknown copy trading action.', 400);
  if (typeof body.applicationId !== 'string' || !UUID.test(body.applicationId))
    return refused('trade_ops.copy_bad_application', 'Choose an application.', 400);
  const applicationId = body.applicationId.toLowerCase();

  if (action === 'reject') {
    const reason = checkLeadReason(body.reason);
    if (!reason.ok) return refused('reason_required', reason.message, 400);
    return rejectLead(ctx, { applicationId, reason: reason.reason });
  }

  const now = await current(ctx, applicationId);
  if (now.kind !== 'ok') return now;
  const { application, days } = now.data;
  if (days === null) return refused('trade.copy_lead_criteria_unset', CRITERIA_UNSET, 412);
  const payload = { applicationId, displayName: application.displayName, minTrackRecordDays: days };

  if (action === 'approve') {
    if (application.status !== 'pending' && application.status !== 'awaiting_second')
      return refused('trade.copy_lead_application_decided', 'This application is decided.', 409);
    const filed = await fileLeadApproval(ctx, payload);
    if (filed.kind !== 'ok') return filed;
    return proposeLead(ctx, { applicationId, approvalId: filed.data.approvalId });
  }

  // confirm
  if (application.status !== 'awaiting_second' || !application.approvalId)
    return refused('trade_ops.copy_lead_not_waiting', 'No approval is waiting for a second founder on this application.', 409);
  if (application.proposedBy?.toLowerCase() === ctx.session.userId.toLowerCase())
    return refused(
      'action_approval.same_person',
      'The founder who filed this approval cannot confirm it. A different founder must sign in and confirm it.',
      409,
    );
  const approvalId = application.approvalId;
  const approval = await readMatchingApproval(ctx, approvalId);
  if (approval.kind !== 'ok') return approval;
  if (approval.data.actionType !== COPY_LEAD_ACTION_TYPE || approval.data.targetId !== applicationId)
    return refused('approval_mismatch', 'The approval on this application was filed for something else. Nothing was listed.', 409);
  if (approval.data.status === 'PENDING') {
    // The hash this desk computes for what it shows now: an approval filed under other criteria or another name is refused.
    const approved = await approveLeadApproval(ctx, { approvalId, expectedPayloadHash: copyLeadPayloadHash(payload) });
    if (approved.kind !== 'ok') return approved;
  } else if (approval.data.status !== 'APPROVED' && approval.data.status !== 'CONSUMED') {
    return refused('action_approval.not_approved', `This approval is ${approval.data.status}. Nothing was listed.`, 409);
  }
  return approveLead(ctx, { applicationId, approvalId, operationId: approval.data.operationId });
}

export const POST = (req: Request) => tradeOpsRoute(req, handler);
