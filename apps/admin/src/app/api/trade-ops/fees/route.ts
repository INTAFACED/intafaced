import { tradeOpsRoute } from '@/lib/trade-ops/bff';
import type { TradeCtx } from '@/lib/trade-ops/edge';
import { readMatchingApproval } from '@/lib/trade-ops/matching-edge';
import { ok, refused, type Outcome } from '@/lib/trade-ops/outcome';
import { buildProposal, parseDraft, versionStates, type FeeVersionRow } from '@/lib/trade-ops/fees-versions-model';
import {
  FEE_SCHEDULE_SET_ACTION_TYPE,
  FEE_SCHEDULE_TARGET_ID,
  FEE_SCHEDULE_TARGET_SERVICE,
  feeScheduleSetPayloadHash,
  type FeeScheduleSetBody,
} from '@/lib/trade-ops/fees-hash';
import {
  draftFeeNotice,
  loadFeesDesk,
  proposeFeeSchedule,
  publishFeeNotice,
  readFeeHistory,
  requestFeeNoticePublish,
  writeFeeSchedule,
} from '@/lib/trade-ops/fees-calls';

/**
 * Fees and convert room (J-cex-spot-17), through svc-trade `admin.fees.*` / `admin.convertDesk.*`, svc-bank
 * `ops.onrampQuotes` / `ops.onrampFeesNotKnown`, svc-notify's notice board and identity's approvals.
 *
 *   POST { action: 'read' }                                              every read of the room
 *   POST { action: 'propose', basisVersion, draft, reason }              file the two-person request for a new version
 *   POST { action: 'apply',   basisVersion, draft, reason, approvalId }  write it, once the request is APPROVED
 *   POST { action: 'notice-draft',   version, title, body }               a fee-change notice draft for a scheduled version
 *   POST { action: 'notice-request', noticeId }                           ask a second founder to approve its publish
 *   POST { action: 'notice-publish', noticeId, approvalId }               publish it, once that request is APPROVED
 *
 * A proposal is always built from the latest stored version and checked here again (the page checks it before it sends
 * anything): a blank rate refuses with svc-trade's own code, and a form built on an older version is refused as stale. The
 * approval binds the hash of exactly what is written; svc-trade checks it again when it consumes the approval. Nothing here
 * moves money: a version changes what later orders are charged, never an order already placed.
 */
export const dynamic = 'force-dynamic';

const TOKEN = /^[A-Za-z0-9_.:-]{1,128}$/;
const VERSION = /^(?:0|[1-9]\d*)$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const bad = (code: string, message: string) => refused(code, message, 400);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The version written exactly as the form asks, against the latest stored version, or the refusal that stops it. */
async function proposalBody(ctx: TradeCtx, body: Record<string, unknown>): Promise<Outcome<FeeScheduleSetBody>> {
  const draft = parseDraft(body.draft);
  if (!draft) return bad('trade_ops.fee_draft_invalid', 'The proposal is not complete. Read the versions again.');
  const basis = str(body.basisVersion);
  if (!VERSION.test(basis))
    return bad('trade_ops.fee_draft_invalid', 'Read the versions again: the version the form started from is missing.');
  const read = await readFeeHistory(ctx);
  if (read.kind !== 'ok') return read;
  const base: FeeVersionRow | undefined = read.data.history.find((row) => row.version === read.data.version);
  if (!base)
    return refused(
      'trade_ops.fee_no_base_version',
      'No version is stored, so there is nothing to start from: the boot schedule applies until a first version is written.',
      409,
    );
  if (basis !== read.data.version)
    return refused('fee_schedule_stale', `The versions changed since you read them (now v${read.data.version}). Read them again.`, 409);
  const check = buildProposal(base, draft, str(body.reason), new Date());
  if (!check.ok) return bad(check.code, check.message);
  return ok({
    schedule: check.schedule,
    effectiveAt: check.effectiveAt,
    expectedVersion: read.data.version,
    reason: str(body.reason).trim(),
  });
}

async function handler(ctx: TradeCtx, body: Record<string, unknown>): Promise<Outcome<unknown>> {
  switch (body.action) {
    case 'read':
      return ok(await loadFeesDesk(ctx));

    case 'propose': {
      const proposal = await proposalBody(ctx, body);
      if (proposal.kind !== 'ok') return proposal;
      const filed = await proposeFeeSchedule(ctx, proposal.data);
      return filed.kind === 'ok' ? ok({ approval: filed.data, payloadHash: feeScheduleSetPayloadHash(proposal.data) }, filed.asOf) : filed;
    }

    case 'apply': {
      if (!TOKEN.test(str(body.approvalId).trim())) return bad('trade_ops.approval_id_invalid', 'Enter the id of an APPROVED request.');
      const approvalId = str(body.approvalId).trim();
      const proposal = await proposalBody(ctx, body);
      if (proposal.kind !== 'ok') return proposal;
      const approval = await readMatchingApproval(ctx, approvalId);
      if (approval.kind !== 'ok') return approval;
      const a = approval.data;
      if (a.status !== 'APPROVED')
        return refused(
          a.status === 'PENDING' ? 'action_approval.pending' : 'action_approval.not_approved',
          a.status === 'PENDING'
            ? 'This request is still waiting for a second founder. Nothing was written.'
            : `This request is ${a.status}, not APPROVED. Nothing was written.`,
          409,
        );
      // The approval must be for this version, from this base, with exactly these rates and this time. Anything else is
      // refused here, before svc-trade is called; svc-trade checks it again when it consumes the approval.
      if (
        a.actionType !== FEE_SCHEDULE_SET_ACTION_TYPE ||
        a.targetService !== FEE_SCHEDULE_TARGET_SERVICE ||
        a.targetId !== FEE_SCHEDULE_TARGET_ID
      )
        return refused('trade_ops.fee_approval_mismatch', 'That approval is for a different change. Nothing was written.', 409);
      if (a.payloadHash !== feeScheduleSetPayloadHash(proposal.data))
        return refused(
          'trade_ops.fee_approval_mismatch',
          'That approval is for different rates, a different time or reason. Nothing was written.',
          409,
        );
      return writeFeeSchedule(ctx, { ...proposal.data, approvalId, operationId: a.operationId });
    }

    case 'notice-draft': {
      const version = str(body.version);
      const title = str(body.title).trim();
      const text = str(body.body).trim();
      if (!VERSION.test(version)) return bad('trade_ops.notice_version_missing', 'Choose the version the notice is for.');
      if (title === '' || title.length > 200) return bad('trade_ops.notice_title', 'Write a title of 1 to 200 characters.');
      if (text === '' || text.length > 8000) return bad('trade_ops.notice_body', 'Write the notice text, 1 to 8000 characters.');
      const read = await readFeeHistory(ctx);
      if (read.kind !== 'ok') return read;
      const row = read.data.history.find((r) => r.version === version);
      if (!row) return bad('trade_ops.notice_version_missing', `There is no version v${version}. Read the versions again.`);
      // A notice tells customers before a change: a version already in force has nothing left to announce.
      if (versionStates(read.data.history, new Date()).get(version) !== 'scheduled')
        return refused(
          'notify.notice_effective_invalid',
          `v${version} is already in force, so a notice can no longer come before it.`,
          409,
        );
      return draftFeeNotice(ctx, { version, effectiveAt: row.effectiveAt, title, body: text });
    }

    case 'notice-request':
      if (!UUID.test(str(body.noticeId))) return bad('trade_ops.notice_missing', 'Save the notice draft first.');
      return requestFeeNoticePublish(ctx, str(body.noticeId));

    case 'notice-publish': {
      if (!UUID.test(str(body.noticeId))) return bad('trade_ops.notice_missing', 'Save the notice draft first.');
      if (!TOKEN.test(str(body.approvalId).trim())) return bad('trade_ops.approval_id_invalid', 'Enter the id of an APPROVED request.');
      const approval = await readMatchingApproval(ctx, str(body.approvalId).trim());
      if (approval.kind !== 'ok') return approval;
      const a = approval.data;
      if (a.status !== 'APPROVED')
        return refused(
          a.status === 'PENDING' ? 'action_approval.pending' : 'action_approval.not_approved',
          a.status === 'PENDING'
            ? 'This request is still waiting for a second founder. Nothing was published.'
            : `This request is ${a.status}, not APPROVED. Nothing was published.`,
          409,
        );
      if (a.actionType !== 'notify.notice.publish' || a.targetService !== 'svc-notify' || a.targetId !== str(body.noticeId))
        return refused('trade_ops.notice_approval_mismatch', 'That approval is for a different notice. Nothing was published.', 409);
      return publishFeeNotice(ctx, { noticeId: str(body.noticeId), approvalId: a.approvalId, operationId: a.operationId });
    }

    default:
      return bad('trade_ops.bad_action', 'Unknown fees action.');
  }
}

export const POST = (req: Request) => tradeOpsRoute(req, handler);
