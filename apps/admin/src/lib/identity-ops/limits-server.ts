import 'server-only';
import {
  limitDeskOutputSchema,
  limitRequestSchema,
  type LimitDeskOutput,
  type LimitRequest,
  type LimitReviewInput,
} from '@intafaced/contracts/api-rate-limits';
import { founderCall, parseWith, type FounderCallContext, type FounderCallResult } from '@/lib/desk/founder-call';
import { partFrom, type Part, type PartLabels } from '@/lib/desk/part';

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
  const result = await founderCall(ctx, 'identity', 'apiLimitDesk.queue', 'GET', undefined, parseWith(limitDeskOutputSchema));
  return { asOf: now.toISOString(), desk: partFrom(result, (desk) => desk, LABELS) };
}

/** Decide as the signed-in founder: svc-identity records the reviewer from the verified session, never from this console. */
export function reviewLimit(ctx: FounderCallContext, input: LimitReviewInput): Promise<FounderCallResult<LimitRequest>> {
  return founderCall(ctx, 'identity', 'apiLimitDesk.review', 'POST', input, parseWith(limitRequestSchema));
}
