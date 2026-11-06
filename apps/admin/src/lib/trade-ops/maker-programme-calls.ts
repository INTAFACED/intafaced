import 'server-only';
import type { ActionApproval } from '@intafaced/contracts';
import { edgeCall, trpcSpec, type TradeCtx } from './edge';
import { parseApproval } from './approvals-parse';
import { readMatchingApproval } from './matching-edge';
import { refused, type Outcome } from './outcome';
import type { MemberInput, PlanInput, TermsInput } from './maker-programme-model';
import {
  MAKER_PROGRAMME_TARGET_SERVICE,
  parseClawbacks,
  parseMarketPlans,
  parseMemberRow,
  parseMembers,
  parsePlanRow,
  parseTerms,
  parseTermsRow,
  type ClawbackRow,
  type MarketPlan,
  type MemberRow,
  type PlanRow,
  type TermsRow,
} from './maker-programme-view';

/** svc-trade admin.makerProgramme.* and admin.launchLiquidity.* through the edge (J-cex-spot-20 #8). */

export const readTerms = (ctx: TradeCtx): Promise<Outcome<{ terms: TermsRow | null }>> =>
  edgeCall(ctx, trpcSpec('trade', 'admin.makerProgramme.terms', 'query', undefined, parseTerms));
export const readMembers = (ctx: TradeCtx): Promise<Outcome<readonly MemberRow[]>> =>
  edgeCall(ctx, trpcSpec('trade', 'admin.makerProgramme.members', 'query', undefined, parseMembers));
export const readClawbacks = (ctx: TradeCtx): Promise<Outcome<readonly ClawbackRow[]>> =>
  edgeCall(ctx, trpcSpec('trade', 'admin.makerProgramme.clawbacks', 'query', undefined, parseClawbacks));
export const readMarketPlans = (ctx: TradeCtx): Promise<Outcome<readonly MarketPlan[]>> =>
  edgeCall(ctx, trpcSpec('trade', 'admin.launchLiquidity.plans', 'query', undefined, parseMarketPlans));

/** identity actionApproval.propose, bound to `payloadHash` for `targetId` at `expectedVersion`. */
export function proposeApproval(
  ctx: TradeCtx,
  req: { actionType: string; targetId: string; expectedVersion: string; payloadHash: string; policyVersion: string },
): Promise<Outcome<ActionApproval>> {
  return edgeCall(
    ctx,
    trpcSpec('identity', 'actionApproval.propose', 'mutation', { ...req, targetService: MAKER_PROGRAMME_TARGET_SERVICE }, parseApproval),
  );
}

/**
 * The approved request `approvalId`, checked against exactly what is about to be written; its operation id is the write's
 * client request id, so svc-trade consumes it under the id identity bound. Refuses anything else, and writes nothing.
 */
export async function approvedFor(
  ctx: TradeCtx,
  approvalId: string,
  want: { actionType: string; targetId: string; payloadHash: string },
): Promise<Outcome<ActionApproval>> {
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
  if (a.actionType !== want.actionType || a.targetService !== MAKER_PROGRAMME_TARGET_SERVICE || a.targetId !== want.targetId)
    return refused('trade_ops.approval_mismatch', 'That approval is for a different change. Nothing was written.', 409);
  if (a.payloadHash !== want.payloadHash)
    return refused('trade_ops.approval_mismatch', 'That approval is for different values or an older version. Nothing was written.', 409);
  return approval;
}

type Write = { readonly expectedVersion: string; readonly approvalId: string; readonly clientRequestId: string };

export const writeTerms = (ctx: TradeCtx, body: Write & { readonly terms: TermsInput }): Promise<Outcome<TermsRow>> =>
  edgeCall(ctx, trpcSpec('trade', 'admin.makerProgramme.setTerms', 'mutation', body, parseTermsRow));
export const writeMember = (ctx: TradeCtx, body: Write & { readonly member: MemberInput }): Promise<Outcome<MemberRow>> =>
  edgeCall(ctx, trpcSpec('trade', 'admin.makerProgramme.setMember', 'mutation', body, parseMemberRow));
export const writePlan = (ctx: TradeCtx, body: Write & { readonly market: string; readonly plan: PlanInput }): Promise<Outcome<PlanRow>> =>
  edgeCall(ctx, trpcSpec('trade', 'admin.launchLiquidity.setPlan', 'mutation', body, parsePlanRow));
