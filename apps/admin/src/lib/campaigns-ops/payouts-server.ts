import 'server-only';
import type { ProcedureInput } from '@intafaced/contracts/procedure';
import {
  CAMPAIGNS_OPS_CAMPAIGNS_DISTRIBUTION_PLAN,
  CAMPAIGNS_OPS_CAMPAIGNS_DISTRIBUTION_RUN,
  CAMPAIGNS_OPS_PAYOUTS_BOARD,
} from '@intafaced/contracts/campaigns-procedures';
import { founderRecordCall, type FounderCallContext } from '@/lib/desk';
import { check, ruleReply } from './builder-server';

/**
 * The payout board and an airdrop's plan as the signed-in founder (J-campaigns-19): svc-campaigns reads every intent with
 * its ledger and chain references. The run takes the snapshot when due or resumes a run that stopped part way; svc-campaigns
 * owes each share once under its business key, so a replay pays nobody twice. No money moves in this console.
 */

export const checkBoard = check(CAMPAIGNS_OPS_PAYOUTS_BOARD.input, 'Which campaign?');
export const checkPlan = check(CAMPAIGNS_OPS_CAMPAIGNS_DISTRIBUTION_PLAN.input, 'Which airdrop campaign?');
export const checkRun = check(CAMPAIGNS_OPS_CAMPAIGNS_DISTRIBUTION_RUN.input, 'Which airdrop campaign, and why (3 to 500 characters)?');

export async function loadPayoutBoard(ctx: FounderCallContext, input: ProcedureInput<typeof CAMPAIGNS_OPS_PAYOUTS_BOARD>) {
  return ruleReply(await founderRecordCall(ctx, CAMPAIGNS_OPS_PAYOUTS_BOARD, input, { sendEmptyInput: true }));
}

export async function loadDistributionPlan(
  ctx: FounderCallContext,
  input: ProcedureInput<typeof CAMPAIGNS_OPS_CAMPAIGNS_DISTRIBUTION_PLAN>,
) {
  return ruleReply(await founderRecordCall(ctx, CAMPAIGNS_OPS_CAMPAIGNS_DISTRIBUTION_PLAN, input));
}

export async function runDistribution(ctx: FounderCallContext, input: ProcedureInput<typeof CAMPAIGNS_OPS_CAMPAIGNS_DISTRIBUTION_RUN>) {
  return ruleReply(await founderRecordCall(ctx, CAMPAIGNS_OPS_CAMPAIGNS_DISTRIBUTION_RUN, input, { timeoutMs: 30_000 }));
}
