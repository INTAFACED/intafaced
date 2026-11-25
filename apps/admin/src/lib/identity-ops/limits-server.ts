import 'server-only';
import { type LimitDeskOutput, type LimitRequest, type LimitReviewInput } from '@intafaced/contracts/api-rate-limits';
import { type FounderCallContext, type FounderCallResult, partFrom, type Part, type PartLabels, founderRecordCall } from '@/lib/desk';
import { IDENTITY_API_LIMIT_DESK_QUEUE, IDENTITY_API_LIMIT_DESK_REVIEW } from '@intafaced/contracts/identity-api-limit-desk-procedures';

/** The API limit request desk as the console shows it: svc-identity's answer, with when the console read it. */
export interface LimitDeskView {
  readonly asOf: string;
  readonly desk: Part<LimitDeskOutput>;
}

const LABELS: PartLabels = {
  service: 'svc-identity',
  forbiddenMessage:
    'Your console session cannot read API limit requests. The desk needs the support operator permission (support:ops) on a founder sign-in.',
};

export async function loadLimitDesk(ctx: FounderCallContext, now: Date = new Date()): Promise<LimitDeskView> {
  const result = await founderRecordCall(ctx, IDENTITY_API_LIMIT_DESK_QUEUE, undefined);
  return { asOf: now.toISOString(), desk: partFrom(result, (desk) => desk, LABELS) };
}

/** Decide as the signed-in founder: svc-identity records the reviewer from the verified session, never from this console. */
export function reviewLimit(ctx: FounderCallContext, input: LimitReviewInput): Promise<FounderCallResult<LimitRequest>> {
  return founderRecordCall(ctx, IDENTITY_API_LIMIT_DESK_REVIEW, input);
}
