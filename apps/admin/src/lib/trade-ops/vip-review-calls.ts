import 'server-only';
import type { ActionApproval } from '@intafaced/contracts';
import { parseApproval } from './approvals-parse';
import { edgeCall, trpcSpec, type TradeCtx } from './edge';
import type { Outcome } from './outcome';
import {
  parseVipList,
  parseVipProof,
  parseVipReviewResult,
  VIP_LIST_SHOWN,
  type VipDecision,
  type VipList,
  type VipProofFile,
  type VipReviewResult,
  type VipStatus,
  type VipTrialRules,
} from './vip-review';
import {
  VIP_POLICY_VERSION,
  VIP_REVIEW_ACTION_TYPE,
  VIP_TARGET_SERVICE,
  VIP_TRIAL_GRANT_ACTION_TYPE,
  vipReviewPayloadHash,
  vipTrialGrantPayloadHash,
} from './vip-review-hash';

/**
 * The calls behind the VIP applications room. Server only: each is a real call to svc-trade (`admin.vipApplications`)
 * or svc-identity (`actionApproval`) through svc-edge with the signed-in founder's own token. Nothing is cached or
 * retried.
 */

export function readVipApplications(ctx: TradeCtx, status: VipStatus | null): Promise<Outcome<VipList>> {
  return edgeCall(
    ctx,
    trpcSpec('trade', 'admin.vipApplications.list', 'query', { ...(status ? { status } : {}), limit: VIP_LIST_SHOWN }, parseVipList),
  );
}

/** One proof file, opened for a reason. svc-trade writes the opening to its operator audit. */
export function openVipProof(ctx: TradeCtx, applicationId: string, reason: string): Promise<Outcome<VipProofFile>> {
  return edgeCall(ctx, trpcSpec('trade', 'admin.vipApplications.proof', 'mutation', { applicationId, reason }, parseVipProof));
}

export function proposeVipReview(
  ctx: TradeCtx,
  input: { applicationId: string; decision: VipDecision; reason: string; trial: VipTrialRules | null },
): Promise<Outcome<ActionApproval>> {
  return edgeCall(
    ctx,
    trpcSpec(
      'identity',
      'actionApproval.propose',
      'mutation',
      {
        actionType: VIP_REVIEW_ACTION_TYPE,
        targetService: VIP_TARGET_SERVICE,
        targetId: input.applicationId,
        expectedVersion: 'pending',
        payloadHash: vipReviewPayloadHash(input),
        policyVersion: VIP_POLICY_VERSION,
      },
      parseApproval,
    ),
  );
}

export function proposeVipTrialGrant(
  ctx: TradeCtx,
  input: { applicationId: string; reason: string; trial: VipTrialRules },
): Promise<Outcome<ActionApproval>> {
  return edgeCall(
    ctx,
    trpcSpec(
      'identity',
      'actionApproval.propose',
      'mutation',
      {
        actionType: VIP_TRIAL_GRANT_ACTION_TYPE,
        targetService: VIP_TARGET_SERVICE,
        targetId: input.applicationId,
        expectedVersion: 'approved_no_trial',
        payloadHash: vipTrialGrantPayloadHash(input),
        policyVersion: VIP_POLICY_VERSION,
      },
      parseApproval,
    ),
  );
}

export function applyVipReview(
  ctx: TradeCtx,
  input: { applicationId: string; decision: VipDecision; reason: string; approvalId: string; operationId: string },
): Promise<Outcome<VipReviewResult>> {
  return edgeCall(ctx, trpcSpec('trade', 'admin.vipApplications.review', 'mutation', input, parseVipReviewResult));
}

export function applyVipTrialGrant(
  ctx: TradeCtx,
  input: { applicationId: string; reason: string; approvalId: string; operationId: string },
): Promise<Outcome<VipReviewResult>> {
  return edgeCall(ctx, trpcSpec('trade', 'admin.vipApplications.grantTrial', 'mutation', input, parseVipReviewResult));
}
