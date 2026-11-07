import { tradeOpsRoute } from '@/lib/trade-ops/bff';
import type { TradeCtx } from '@/lib/trade-ops/edge';
import { readMatchingApproval } from '@/lib/trade-ops/matching-edge';
import { ok, refused, type Outcome } from '@/lib/trade-ops/outcome';
import { checkRulebookDraft, loadRulebookDesk, proposeRulebook, publishRulebook } from '@/lib/trade-ops/rulebook-calls';
import { parseRulebookDraft } from '@/lib/trade-ops/rulebook-model';

/**
 * Trading rulebook room (RC-cex-spot-08, J-cex-spot-20 #6), through svc-matching's founder doors on svc-edge and
 * identity's approvals.
 *
 *   POST { action: 'read' }                         the published versions
 *   POST { action: 'propose', draft }               svc-matching checks the draft, then the two-person request is filed
 *   POST { action: 'publish', draft, approvalId }   publish it, once that request is APPROVED
 *
 * svc-matching refuses a draft with a blank section (`matching.rulebook_section_unset`) or an edit of a published version
 * (`matching.rulebook_immutable`), and answers the payload hash the request binds. At publish it recomputes that hash
 * from the draft and consumes the approval: a changed word needs a new request. No money moves here.
 */
export const dynamic = 'force-dynamic';

const TOKEN = /^[A-Za-z0-9_.:-]{1,128}$/;
const bad = (code: string, message: string) => refused(code, message, 400);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

async function handler(ctx: TradeCtx, body: Record<string, unknown>): Promise<Outcome<unknown>> {
  switch (body.action) {
    case 'read':
      return ok(await loadRulebookDesk(ctx));

    case 'propose': {
      const draft = parseRulebookDraft(body.draft);
      if (!draft) return bad('trade_ops.rulebook_draft_invalid', 'The draft is not complete. Read the page again.');
      const check = await checkRulebookDraft(ctx, draft);
      if (check.kind !== 'ok') return check;
      const filed = await proposeRulebook(ctx, check.data);
      return filed.kind === 'ok'
        ? ok({ approval: filed.data, payloadHash: check.data.payloadHash, version: check.data.version }, filed.asOf)
        : filed;
    }

    case 'publish': {
      const draft = parseRulebookDraft(body.draft);
      if (!draft) return bad('trade_ops.rulebook_draft_invalid', 'The draft is not complete. Read the page again.');
      const approvalId = str(body.approvalId).trim();
      if (!TOKEN.test(approvalId)) return bad('trade_ops.approval_id_invalid', 'Enter the id of an APPROVED request.');
      const approval = await readMatchingApproval(ctx, approvalId);
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
      return publishRulebook(ctx, draft, { approvalId, operationId: a.operationId });
    }

    default:
      return bad('trade_ops.bad_action', 'Unknown rulebook action.');
  }
}

export const POST = (req: Request) => tradeOpsRoute(req, handler);
