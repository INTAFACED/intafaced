import { tradeOpsRoute } from '@/lib/trade-ops/bff';
import { readMatchingApproval } from '@/lib/trade-ops/matching-edge';
import { ok, refused, type Outcome } from '@/lib/trade-ops/outcome';
import type { TradeCtx } from '@/lib/trade-ops/edge';
import { actionOf, CHART_FEED_ACTION_TYPE, CHART_FEED_TARGET_SERVICE, reasonReady } from '@/lib/trade-ops/chart-feed-model';
import {
  prepareChartFeedChange,
  proposeChartFeedChange,
  readChartFeedControls,
  runChartFeedChange,
} from '@/lib/trade-ops/chart-feed-calls';

/**
 * Feed source and symbol control (J-charts-desk-19 #2 #3), through svc-trade `admin.chartFeedControls.*`.
 *
 *   POST { action: 'read' }                                                   every market's source and chart state, and the journal
 *   POST { action: 'propose', symbol, kind, to?, expectedVersion, reason }      svc-trade checks it and answers the hash; then the
 *                                                                              two-person request is filed at identity
 *   POST { action: 'apply',   symbol, kind, to?, expectedVersion, reason, approvalId }   apply it once a second operator APPROVED it
 *
 * svc-trade decides what is allowed (a blank fallback list refuses before any request is filed) and recomputes the hash
 * when it applies the change; this route first checks the approval is APPROVED and for this market's chart feed.
 */
export const dynamic = 'force-dynamic';

const TOKEN = /^[A-Za-z0-9_.:-]{1,128}$/;
const VERSION = /^(?:0|[1-9]\d*)$/;
const bad = (code: string, message: string) => refused(code, message, 400);

async function handler(ctx: TradeCtx, body: Record<string, unknown>): Promise<Outcome<unknown>> {
  if (body.action === 'read') return readChartFeedControls(ctx);
  if (body.action !== 'propose' && body.action !== 'apply') return bad('trade_ops.bad_action', 'Unknown chart feed action.');

  if (typeof body.symbol !== 'string' || body.symbol.trim() === '' || body.symbol.trim().length > 64)
    return bad('chart_feed.bad_symbol', 'Choose a market.');
  const action = actionOf(body.kind, body.to);
  if (action === null) return bad('chart_feed.bad_action', 'Choose what to change, and for a switch, the source.');
  const expectedVersion = typeof body.expectedVersion === 'string' && VERSION.test(body.expectedVersion) ? body.expectedVersion : null;
  if (expectedVersion === null) return bad('chart_feed.bad_version', 'Read the page again: the version on the form is missing.');
  if (typeof body.reason !== 'string' || !reasonReady(body.reason))
    return bad(
      'chart_feed.reason_required',
      'Write the reason for this change (12 to 500 characters). It is kept in the journal and the audit.',
    );
  const change = { symbol: body.symbol.trim(), action, expectedVersion, reason: body.reason.trim() };

  if (body.action === 'propose') {
    const prepared = await prepareChartFeedChange(ctx, change);
    if (prepared.kind !== 'ok') return prepared;
    const filed = await proposeChartFeedChange(ctx, prepared.data);
    if (filed.kind !== 'ok') return filed;
    return ok({ approval: filed.data, prepared: prepared.data }, filed.asOf);
  }

  if (typeof body.approvalId !== 'string' || !TOKEN.test(body.approvalId.trim()))
    return bad('trade_ops.approval_id_invalid', 'Enter the id of an APPROVED request.');
  const approvalId = body.approvalId.trim();
  const approval = await readMatchingApproval(ctx, approvalId);
  if (approval.kind !== 'ok') return approval;
  const a = approval.data;
  if (a.status !== 'APPROVED')
    return refused(
      a.status === 'PENDING' ? 'action_approval.pending' : 'action_approval.not_approved',
      a.status === 'PENDING'
        ? 'This request is still waiting for a second operator. Nothing was changed.'
        : `This request is ${a.status}, not APPROVED. Nothing was changed.`,
      409,
    );
  if (a.actionType !== CHART_FEED_ACTION_TYPE || a.targetService !== CHART_FEED_TARGET_SERVICE || a.targetId !== change.symbol)
    return refused('chart_feed.approval_mismatch', 'That approval is for a different change. Nothing was changed.', 409);
  // svc-trade recomputes the hash of exactly this change and reason, and refuses an approval bound to anything else.
  return runChartFeedChange(ctx, { ...change, approvalId, operationId: a.operationId });
}

export const POST = (req: Request) => tradeOpsRoute(req, handler);
