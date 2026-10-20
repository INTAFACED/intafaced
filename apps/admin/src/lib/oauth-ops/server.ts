import 'server-only';
import { oauthAppSchema, oauthReviewQueueRowSchema } from '@intafaced/contracts';
import { founderCall, parseWith, type FounderCallContext, type FounderCallResult } from '@/lib/desk/founder-call';
import { partFrom, type Part, type PartLabels } from '@/lib/desk/part';
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

/** Every row must be exactly the contract's: a shape that is not makes the whole read invalid, so the desk never prints a guess. */
function readQueue(raw: unknown): OAuthQueueApp[] | null {
  if (!raw || typeof raw !== 'object' || !('apps' in raw) || !Array.isArray(raw.apps)) return null;
  const rows: OAuthQueueApp[] = [];
  for (const row of raw.apps) {
    const parsed = oauthReviewQueueRowSchema.safeParse(row);
    if (!parsed.success) return null;
    rows.push(parsed.data);
  }
  return rows;
}

export async function loadOAuthQueue(ctx: FounderCallContext, status: OAuthReviewStatus, now: Date = new Date()): Promise<OAuthQueueView> {
  const result = await founderCall(ctx, 'identity', 'oauth.apps.queue', 'GET', { status, limit: QUEUE_PAGE }, readQueue);
  return { asOf: now.toISOString(), status, limit: QUEUE_PAGE, apps: partFrom(result, (apps) => apps, LABELS) };
}

type ReviewedApp = ReturnType<typeof oauthAppSchema.parse>;

/** Decide as the signed-in founder: svc-identity records the reviewer from the verified session, never from this console. */
export function reviewOAuthApp(ctx: FounderCallContext, request: OAuthReviewRequest): Promise<FounderCallResult<ReviewedApp>> {
  return founderCall(ctx, 'identity', 'oauth.apps.review', 'POST', request, parseWith(oauthAppSchema));
}
