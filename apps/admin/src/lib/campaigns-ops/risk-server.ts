import 'server-only';
import type { ProcedureInput } from '@intafaced/contracts/procedure';
import {
  CAMPAIGNS_OPS_RISK_CASE,
  CAMPAIGNS_OPS_RISK_DECIDE_APPEAL,
  CAMPAIGNS_OPS_RISK_QUEUE,
  CAMPAIGNS_OPS_RISK_REVOKE,
  CAMPAIGNS_OPS_RISK_WITHHOLD,
} from '@intafaced/contracts/campaigns-procedures';
import { founderRecordCall, type FounderCallContext } from '@/lib/desk';
import { check, ruleReply } from './builder-server';

/**
 * The risk review desk as the signed-in founder (J-campaigns-18): svc-campaigns reads every row and records the founder
 * from their own token on every decision. The only money a decision here moves is the reclaim of an owed reward that was
 * never paid, through svc-campaigns' one ledger recipe for it; a reward paid to a customer's own wallet is never pulled back.
 */

export const checkCase = check(CAMPAIGNS_OPS_RISK_CASE.input, 'Which account?');
export const checkWithhold = check(CAMPAIGNS_OPS_RISK_WITHHOLD.input, 'Which reward, and why (3 to 500 characters)?');
export const checkRevoke = check(CAMPAIGNS_OPS_RISK_REVOKE.input, 'Which account, and why (3 to 500 characters)?');
export const checkDecide = check(
  CAMPAIGNS_OPS_RISK_DECIDE_APPEAL.input,
  'Which account, upheld or overturned, and why (3 to 500 characters)?',
);

export async function loadRiskQueue(ctx: FounderCallContext) {
  return ruleReply(await founderRecordCall(ctx, CAMPAIGNS_OPS_RISK_QUEUE, undefined));
}

export async function loadRiskCase(ctx: FounderCallContext, input: ProcedureInput<typeof CAMPAIGNS_OPS_RISK_CASE>) {
  return ruleReply(await founderRecordCall(ctx, CAMPAIGNS_OPS_RISK_CASE, input));
}

export async function withholdReward(ctx: FounderCallContext, input: ProcedureInput<typeof CAMPAIGNS_OPS_RISK_WITHHOLD>) {
  return ruleReply(await founderRecordCall(ctx, CAMPAIGNS_OPS_RISK_WITHHOLD, input));
}

export async function revokeRewards(ctx: FounderCallContext, input: ProcedureInput<typeof CAMPAIGNS_OPS_RISK_REVOKE>) {
  return ruleReply(await founderRecordCall(ctx, CAMPAIGNS_OPS_RISK_REVOKE, input, { timeoutMs: 30_000 }));
}

export async function decideAppeal(ctx: FounderCallContext, input: ProcedureInput<typeof CAMPAIGNS_OPS_RISK_DECIDE_APPEAL>) {
  return ruleReply(await founderRecordCall(ctx, CAMPAIGNS_OPS_RISK_DECIDE_APPEAL, input, { timeoutMs: 30_000 }));
}
