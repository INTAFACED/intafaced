import 'server-only';
import {
  riskAppealDecideInputSchema,
  riskCaseInputSchema,
  riskCaseSchema,
  riskQueueSchema,
  riskRevokeInputSchema,
  riskWithholdInputSchema,
} from '@intafaced/contracts/campaigns-risk';
import { founderCall, parseWith, type FounderCallContext } from '@/lib/desk/founder-call';
import { check, ruleReply } from './builder-server';

/**
 * The risk review desk as the signed-in founder (J-campaigns-18): svc-campaigns reads every row and records the founder
 * from their own token on every decision. The only money a decision here moves is the reclaim of an owed reward that was
 * never paid, through svc-campaigns' one ledger recipe for it; a reward paid to a customer's own wallet is never pulled back.
 */

export const checkCase = check(riskCaseInputSchema, 'Which account?');
export const checkWithhold = check(riskWithholdInputSchema, 'Which reward, and why (3 to 500 characters)?');
export const checkRevoke = check(riskRevokeInputSchema, 'Which account, and why (3 to 500 characters)?');
export const checkDecide = check(riskAppealDecideInputSchema, 'Which account, upheld or overturned, and why (3 to 500 characters)?');

const readQueue = parseWith(riskQueueSchema);
const readCase = parseWith(riskCaseSchema);

export async function loadRiskQueue(ctx: FounderCallContext) {
  return ruleReply(await founderCall(ctx, 'campaigns', 'ops.risk.queue', 'GET', undefined, readQueue));
}

export async function loadRiskCase(ctx: FounderCallContext, input: unknown) {
  return ruleReply(await founderCall(ctx, 'campaigns', 'ops.risk.case', 'GET', input, readCase));
}

export async function withholdReward(ctx: FounderCallContext, input: unknown) {
  return ruleReply(await founderCall(ctx, 'campaigns', 'ops.risk.withhold', 'POST', input, readCase));
}

export async function revokeRewards(ctx: FounderCallContext, input: unknown) {
  return ruleReply(await founderCall(ctx, 'campaigns', 'ops.risk.revoke', 'POST', input, readCase, { timeoutMs: 30_000 }));
}

export async function decideAppeal(ctx: FounderCallContext, input: unknown) {
  return ruleReply(await founderCall(ctx, 'campaigns', 'ops.risk.decideAppeal', 'POST', input, readCase, { timeoutMs: 30_000 }));
}
