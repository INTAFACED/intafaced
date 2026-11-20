import 'server-only';
import { IDENTITY_OAUTH_APPS_QUEUE, IDENTITY_OAUTH_APPS_REVIEW } from '@intafaced/contracts/identity-oauth-procedures';
import type { ProcedureOutput } from '@intafaced/contracts/procedure';
import { type FounderCallContext, type FounderCallResult, partFrom, type Part, type PartLabels } from '@/lib/desk';
import { founderRecordCall } from '@/lib/desk/founder-call';
import { OAUTH_OPS_FORBIDDEN } from './refusal';
import { QUEUE_PAGE, type OAuthQueueApp, type OAuthReviewRequest, type OAuthReviewStatus } from './model';

export interface OAuthQueueView {
  readonly asOf: string;
  readonly status: OAuthReviewStatus;
  readonly limit: number;
  readonly apps: Part<readonly OAuthQueueApp[]>;
}

const LABELS: PartLabels = {
  service: 'svc-identity',
  forbiddenMessage: `${OAUTH_OPS_FORBIDDEN}. The queue needs the compliance permission (admin:compliance), which founder sign-in carries only when identity is set to grant it.`,
};

export async function loadOAuthQueue(ctx: FounderCallContext, status: OAuthReviewStatus, now: Date = new Date()): Promise<OAuthQueueView> {
  // Every row must be exactly the record's: a shape that is not makes the whole read invalid, so the desk never prints a guess.
  const result = await founderRecordCall(ctx, IDENTITY_OAUTH_APPS_QUEUE, { status, limit: QUEUE_PAGE });
  return { asOf: now.toISOString(), status, limit: QUEUE_PAGE, apps: partFrom(result, (data) => data.apps, LABELS) };
}

type ReviewedApp = ProcedureOutput<typeof IDENTITY_OAUTH_APPS_REVIEW>;

/** Decide as the signed-in founder: svc-identity records the reviewer from the verified session, never from this console. */
export function reviewOAuthApp(ctx: FounderCallContext, request: OAuthReviewRequest): Promise<FounderCallResult<ReviewedApp>> {
  return founderRecordCall(ctx, IDENTITY_OAUTH_APPS_REVIEW, request);
}
