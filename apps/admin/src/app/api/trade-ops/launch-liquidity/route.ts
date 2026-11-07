import { tradeOpsRoute } from '@/lib/trade-ops/bff';
import type { TradeCtx } from '@/lib/trade-ops/edge';
import { ok, refused, type Outcome } from '@/lib/trade-ops/outcome';
import { approvedFor, proposeApproval, readMarketPlans, readMembers, writePlan } from '@/lib/trade-ops/maker-programme-calls';
import { planDraft } from '@/lib/trade-ops/maker-programme-drafts';
import { checkPlan, LAUNCH_PLAN_ACTION_TYPE, LAUNCH_PLAN_MAKER_UNKNOWN, type PlanInput } from '@/lib/trade-ops/maker-programme-model';
import { LAUNCH_PLAN_POLICY_VERSION, planPayloadHash } from '@/lib/trade-ops/maker-programme-view';

/**
 * Launch-liquidity room (J-cex-spot-20 #8, RC-cex-spot-09), through svc-trade `admin.launchLiquidity.*` and identity's
 * approvals.
 *
 *   POST { action: 'propose', market, draft }               file the two-person request for the market's next plan version
 *   POST { action: 'apply',   market, draft, approvalId }   write it, once APPROVED
 *
 * The version is read here from svc-trade. A blank refuses `trade.launch_plan_unset` by name, and a maker who is not an
 * active programme member refuses `trade.launch_plan_maker_unknown`, before anything is filed; svc-trade checks both
 * again in the transaction that writes. Capital figures are plan records, not balances: nothing here moves money.
 */
export const dynamic = 'force-dynamic';

const TOKEN = /^[A-Za-z0-9_.:-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const bad = (code: string, message: string) => refused(code, message, 400);

async function planReq(
  ctx: TradeCtx,
  body: Record<string, unknown>,
  /** The approval's own version on apply; on propose, the market's current version is read. */
  boundVersion?: string,
): Promise<Outcome<{ market: string; plan: PlanInput; expectedVersion: string; payloadHash: string }>> {
  const market = typeof body.market === 'string' ? body.market : '';
  if (!UUID.test(market)) return bad('trade_ops.plan_market_missing', 'Choose a market.');
  const draft = planDraft(body.draft);
  if (!draft) return bad('trade_ops.plan_draft_invalid', 'The plan is not complete. Read the room again.');
  const check = checkPlan(draft);
  if (!check.ok) return bad(check.code, `${check.message}.`);
  const [plans, members] = await Promise.all([readMarketPlans(ctx), readMembers(ctx)]);
  if (plans.kind !== 'ok') return plans;
  if (members.kind !== 'ok') return members;
  const row = plans.data.find((m) => m.market === market);
  if (!row) return bad('trade_ops.plan_market_missing', 'That market is not a spot market in the catalogue.');
  const active = new Set(members.data.filter((m) => m.status === 'active').map((m) => m.accountId));
  const unknown = check.value.makers.find((m) => !active.has(m.accountId!));
  if (unknown) return bad(LAUNCH_PLAN_MAKER_UNKNOWN, `Maker ${unknown.accountId} is not an active member of the maker programme.`);
  const expectedVersion = boundVersion ?? row.plan?.version ?? '0';
  return ok({ market, plan: check.value, expectedVersion, payloadHash: planPayloadHash(market, expectedVersion, check.value) });
}

async function handler(ctx: TradeCtx, body: Record<string, unknown>): Promise<Outcome<unknown>> {
  if (body.action !== 'propose' && body.action !== 'apply') return bad('trade_ops.bad_action', 'Unknown launch-liquidity action.');
  if (body.action === 'propose') {
    const req = await planReq(ctx, body);
    if (req.kind !== 'ok') return req;
    const { market, expectedVersion, payloadHash } = req.data;
    const filed = await proposeApproval(ctx, {
      actionType: LAUNCH_PLAN_ACTION_TYPE,
      targetId: market,
      expectedVersion,
      payloadHash,
      policyVersion: LAUNCH_PLAN_POLICY_VERSION,
    });
    return filed.kind === 'ok' ? ok({ approval: filed.data, payloadHash, expectedVersion }, filed.asOf) : filed;
  }
  const approvalId = typeof body.approvalId === 'string' ? body.approvalId.trim() : '';
  if (!TOKEN.test(approvalId)) return bad('trade_ops.approval_id_invalid', 'Enter the id of an APPROVED request.');
  const first = await planReq(ctx, body);
  if (first.kind !== 'ok') return first;
  const { market, plan } = first.data;
  const approval = await approvedFor(ctx, approvalId, {
    actionType: LAUNCH_PLAN_ACTION_TYPE,
    targetId: market,
    payloadHashAt: (v) => planPayloadHash(market, v, plan),
  });
  if (approval.kind !== 'ok') return approval;
  const expectedVersion = approval.data.expectedVersion;
  return writePlan(ctx, { market, plan, expectedVersion, approvalId, clientRequestId: approval.data.operationId });
}

export const POST = (req: Request) => tradeOpsRoute(req, handler);
