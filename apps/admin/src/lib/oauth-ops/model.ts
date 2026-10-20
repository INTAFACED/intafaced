/**
 * The operator queue for OAuth apps (DV-oauth-01), as svc-identity returns it (`oauth.apps.queue`) and the one write the
 * desk makes (`oauth.apps.review`). Pure, so the BFF route, the server loader and the page share one set of rules.
 */

export const OAUTH_REVIEW_STATUSES = ['pending', 'approved', 'suspended'] as const;
export type OAuthReviewStatus = (typeof OAUTH_REVIEW_STATUSES)[number];

/** One page of the queue. The service caps a read at 200; the desk asks for fewer and says when the page is full. */
export const QUEUE_PAGE = 50;

export const REASON_MIN = 12;
export const REASON_MAX = 500;

export interface OAuthQueueApp {
  readonly id: string;
  readonly clientId: string;
  readonly name: string;
  readonly description: string | null;
  readonly logoUrl: string | null;
  readonly redirectUrls: readonly string[];
  readonly scopes: readonly string[];
  readonly confidential: boolean;
  readonly status: OAuthReviewStatus;
  readonly createdAt: string;
  readonly secretRolledAt: string | null;
  readonly developerUserId: string;
}

export type OAuthDecision = 'approve' | 'suspend';

export interface OAuthReviewRequest {
  readonly appId: string;
  readonly decision: OAuthDecision;
  readonly reason: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isAppId = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

export const isReviewStatus = (value: unknown): value is OAuthReviewStatus =>
  typeof value === 'string' && (OAUTH_REVIEW_STATUSES as readonly string[]).includes(value);

/** The status an app holds once a decision is made. A reply that shows any other status is not reported as done. */
export const statusAfter = (decision: OAuthDecision): OAuthReviewStatus => (decision === 'approve' ? 'approved' : 'suspended');

/** A decision always carries a written reason: it opens an app to every user, or ends every live token of one. */
export function readReviewRequest(raw: Record<string, unknown>): OAuthReviewRequest | null {
  if (raw.action !== 'review' || !isAppId(raw.appId)) return null;
  if (raw.decision !== 'approve' && raw.decision !== 'suspend') return null;
  const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
  if (reason.length < REASON_MIN || reason.length > REASON_MAX) return null;
  return { appId: raw.appId, decision: raw.decision, reason };
}

export type ReviewGate = { readonly ok: true } | { readonly ok: false; readonly why: string };

/**
 * What the form must hold before it sends. Approving also needs the app's name typed back: it is the step that lets an
 * outside developer's app reach every customer, so it cannot be a stray click.
 */
export function reviewGate(input: { decision: OAuthDecision; appName: string; reason: string; typed: string; busy: boolean }): ReviewGate {
  if (input.busy) return { ok: false, why: 'Sending.' };
  const reason = input.reason.trim();
  if (reason.length < REASON_MIN) return { ok: false, why: `Write a reason of at least ${REASON_MIN} characters.` };
  if (reason.length > REASON_MAX) return { ok: false, why: `Keep the reason to ${REASON_MAX} characters.` };
  if (input.decision === 'approve' && input.typed.trim() !== input.appName.trim()) {
    return { ok: false, why: 'Type the app name exactly to confirm.' };
  }
  return { ok: true };
}
