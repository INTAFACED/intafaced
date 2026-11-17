import 'server-only';
import { distributionRunInputSchema, distributionRunSchema } from '@intafaced/contracts/campaigns-distribution';
import {
  distributionPlanInputSchema,
  distributionPlanSchema,
  payoutBoardInputSchema,
  payoutBoardSchema,
} from '@intafaced/contracts/campaigns-payout-board';
import { founderCall, parseWith, type FounderCallContext } from '@/lib/desk/founder-call';
import { check, ruleReply } from './builder-server';

/**
 * The payout board and an airdrop's plan as the signed-in founder (J-campaigns-19): svc-campaigns reads every intent with
 * its ledger and chain references. The run takes the snapshot when due or resumes a run that stopped part way; svc-campaigns
 * owes each share once under its business key, so a replay pays nobody twice. No money moves in this console.
 */

export const checkBoard = check(payoutBoardInputSchema, 'Which campaign?');
export const checkPlan = check(distributionPlanInputSchema, 'Which airdrop campaign?');
export const checkRun = check(distributionRunInputSchema, 'Which airdrop campaign, and why (3 to 500 characters)?');

const readBoard = parseWith(payoutBoardSchema);
const readPlan = parseWith(distributionPlanSchema);
const readRun = parseWith(distributionRunSchema);

export async function loadPayoutBoard(ctx: FounderCallContext, input: unknown) {
  return ruleReply(await founderCall(ctx, 'campaigns', 'ops.payouts.board', 'GET', input, readBoard));
}

export async function loadDistributionPlan(ctx: FounderCallContext, input: unknown) {
  return ruleReply(await founderCall(ctx, 'campaigns', 'ops.campaigns.distribution.plan', 'GET', input, readPlan));
}

export async function runDistribution(ctx: FounderCallContext, input: unknown) {
  return ruleReply(await founderCall(ctx, 'campaigns', 'ops.campaigns.distribution.run', 'POST', input, readRun, { timeoutMs: 30_000 }));
}
